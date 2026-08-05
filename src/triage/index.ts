import { generateText, Output, tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { SessionMessage } from "agents/experimental/memory/session";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import { parseTurn, sessionText } from "@loopingai/core/agent";

/**
 * `@loopingai/plugins/triage` — decide whether an inbound message deserves a
 * reply at all, *before* the tool loop runs.
 *
 * An agent in a shared channel sees every message, and most are not for it. Left
 * to the main loop, that judgement is made by a model simultaneously trying to
 * be helpful, with memory, history and half a dozen tools in view — and it
 * degrades exactly there, and degrades **invisibly**: failing to call a
 * decline-tool looks identical to deciding not to.
 *
 * Triage moves the decision somewhere it cannot be skipped. A structured-output
 * call has no "just answer instead" escape hatch — the schema must be filled —
 * so the question is always actually asked.
 *
 * Two moments, and both are needed. The gate here judges the *message*; the
 * `no_reply` tool below lets the agent decline *late*, after looking something
 * up and concluding there was nothing worth adding. Wiring `no_reply` into a
 * loop is the loop's business (see {@link noReplyTool}); this module ships the
 * pieces rather than the loop.
 */

/** Small, fast classifier. High-volume and narrow — not the chat model. */
const DEFAULT_TRIAGE_MODEL_ID = "@cf/qwen/qwen3-30b-a3b-fp8";
/** Trailing history the classifier sees, including the message being judged. */
const DEFAULT_HISTORY_MESSAGES = 12;
/** Per-message char cap in the prompt — keeps the classify call small. */
const DEFAULT_MESSAGE_MAX_CHARS = 500;

/**
 * The classifier's output. The booleans are **not** metadata for the caller —
 * only `should_reply` is ever read. They exist to shape the generation itself:
 * constrained decoding fills properties in schema order, so declaring them ahead
 * of `should_reply` forces the model to commit to the sub-judgements that
 * determine the answer — *who is this for*, and *do I have something worth
 * adding* — before it can name a verdict. Reordering these fields, or dropping
 * one, changes what the model reasons about; it is not cosmetic.
 *
 * `reason` comes last, after the verdict, on purpose: generated afterwards it
 * justifies the decision rather than steering it, so a logged reason can never
 * contradict the `should_reply` it explains. That is what makes it worth reading
 * when a misclassification needs debugging.
 */
export const triageSchema = z.object({
  for_other_people: z
    .boolean()
    .describe(
      "Is this message aimed at other people in the channel rather than at you?"
    ),
  for_another_agent: z
    .boolean()
    .describe("Is this message aimed at a different bot or agent, not at you?"),
  can_contribute: z
    .boolean()
    .describe(
      "Is there something this conversation clearly needs right now that you can add?"
    ),
  should_reply: z
    .boolean()
    .describe("Given all of the above, should you reply at all?"),
  reason: z.string().describe("One short sentence justifying the verdict.")
});

export type TriageVerdict = z.infer<typeof triageSchema>;

/**
 * The classifier's instructions. Aimed squarely at the failure this exists to
 * fix: the agent joins a conversation legitimately, then keeps answering
 * afterwards as unrelated messages go by. Every rule here is about *audience*
 * and *value* — the hard, per-message calls — rather than about obeying
 * instructions, which was never the part that broke.
 */
const TRIAGE_RULES = [
  "You are the assistant in a shared chat channel, and you see every message — including the many that are not for you.",
  "Decide one thing only: should you reply to the LAST message?",
  "",
  "Rules:",
  "- People talking to each other, chatter, and acknowledgements need no reply from you. In a busy channel this is the common case.",
  "- Having replied recently does not entitle you to reply now. Judge the last message on its own audience; being part of the conversation a moment ago is not a licence to answer whatever follows.",
  "- Reply when you are directly asked something, addressed by name or @mention, or when the previous message was your own and this one answers or follows up on it.",
  "- `can_contribute` is a high bar: something the conversation clearly needs, not merely something true you could say. Restating, agreeing, praising, or acknowledging is not contributing.",
  "- These rules apply in every language, including when the channel is not in English.",
  "- When you are genuinely unsure, reply. A wrong silence is invisible to the person who needed you; a wrong reply is only noise."
].join("\n");

/**
 * The tuning half of {@link TriageConfig}: plain values, no bindings.
 *
 * Declare these once in a config module and spread them at the call site — see
 * `RecallTuning` for why enumerating each field is a liability rather than just
 * noise.
 */
export interface TriageTuning {
  /**
   * AI Gateway id. Pass the host's **resolved** value
   * (`PluginHost.aiGatewayId`), so classify calls stay correlated with chat calls
   * in one gateway.
   */
  aiGatewayId?: string;
  /** Workers-AI id for the classifier. Defaults to a small, fast model. */
  modelId?: string;
  /** Trailing messages the classifier sees. Defaults to 12. */
  historyMessages?: number;
  /** Per-message char cap in the prompt. Defaults to 500. */
  messageMaxChars?: number;
}

export interface TriageConfig extends TriageTuning {
  /** The `AI` binding. Read lazily — see {@link triage}. */
  ai: Ai;
  /** Test override; skips the provider entirely. */
  model?: LanguageModel;
}

/** Trim a message body to the triage char cap, marking it when cut. */
function truncate(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Render one stored message as a transcript line. User turns carry the gateway's
 * `<turn from="…">` provenance, so the speaker's name is surfaced rather than a
 * flat "user" — without it the classifier cannot tell one participant from
 * another, which is most of what it has to reason about. Assistant turns are
 * labelled "you" so "the previous message was your own" is legible.
 */
function transcriptLine(message: SessionMessage, max: number): string {
  const text = sessionText(message);
  if (message.role === "assistant") return `you: ${truncate(text, max)}`;
  const turn = parseTurn(text);
  const speaker = turn ? turn.from : "someone";
  return `${speaker}: ${truncate(turn ? turn.body : text, max)}`;
}

export interface TriagePromptOptions {
  historyMessages?: number;
  messageMaxChars?: number;
}

/**
 * Build the classifier prompt from the tail of the conversation.
 *
 * A bare message is frequently unclassifiable — "yes", "thanks", "and the second
 * one?" only resolve against what came before — and the drift being fixed is
 * *only* visible in context, where the classifier can see the agent has been
 * talking and that the speaker has since turned to someone else.
 *
 * Exported for its own tests: it is pure, so the prompt can be asserted without
 * an LLM.
 */
export function buildTriagePrompt(
  history: SessionMessage[],
  options: TriagePromptOptions = {}
): string {
  const {
    historyMessages = DEFAULT_HISTORY_MESSAGES,
    messageMaxChars = DEFAULT_MESSAGE_MAX_CHARS
  } = options;

  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-historyMessages);
  const transcript = recent
    .map((m) => transcriptLine(m, messageMaxChars))
    .join("\n");
  return [
    TRIAGE_RULES,
    "",
    "Recent messages, oldest first. The last line is the message you are judging:",
    transcript
  ].join("\n");
}

/**
 * Classify whether the agent should reply to the newest message in `history`.
 *
 * **Fails open.** Every error is caught here and answered `true`, because the
 * two mistakes are not symmetric: a wrong reply is noise the user can see and
 * ignore, while a wrong silence is invisible — the person who needed the agent
 * simply never hears back and has no way to tell that anything happened. A
 * triage outage must therefore degrade to the previous behaviour (let the loop
 * decide), never to a silent agent.
 *
 * Only `should_reply` is read; the other fields exist to steer the generation
 * (see {@link triageSchema}) and are logged, not re-derived in code.
 */
export async function shouldReply(
  model: LanguageModel,
  history: SessionMessage[],
  options: TriagePromptOptions = {}
): Promise<boolean> {
  try {
    // `generateText` + `Output.object` rather than `generateObject`, which is
    // deprecated in AI SDK 7. Same effect: the provider is sent a json_schema
    // response format, so the model cannot answer with anything but the schema.
    const { output } = await generateText({
      model,
      output: Output.object({ schema: triageSchema }),
      prompt: buildTriagePrompt(history, options),
      // Consistent with the rest of the runtime: we handle failure ourselves
      // (here, by failing open), so SDK backoff would only delay the turn.
      maxRetries: 0
    });
    // Log the whole verdict, not just the outcome. The booleans are the
    // reasoning — a correct verdict reached through wrong booleans means the
    // decomposition is not carrying the decision, and will drift again on
    // untested cases.
    console.debug("[triage] verdict", output);
    return output.should_reply;
  } catch (err) {
    console.warn("[triage] classify failed, replying by default", {
      error: String(err)
    });
    return true;
  }
}

export function triage(config: TriageConfig): AgentPlugin {
  const {
    ai,
    aiGatewayId,
    modelId = DEFAULT_TRIAGE_MODEL_ID,
    historyMessages,
    messageMaxChars
  } = config;

  /**
   * Built on first use, never at module scope. Cloudflare evaluates module scope
   * during `wrangler deploy` to validate the new version, and bindings are not
   * populated at that point — constructing eagerly makes `createWorkersAI` throw
   * "you must provide either a binding or credentials". The same laziness
   * protects a host that builds its runtime early.
   *
   * No fallback model: triage fails open, so a second attempt on a different
   * model buys nothing a `true` does not already buy, at twice the latency in
   * front of every turn.
   */
  let model: LanguageModel | undefined;
  const classifier = (): LanguageModel =>
    (model ??=
      config.model ??
      createWorkersAI({
        binding: ai,
        ...(aiGatewayId ? { gateway: { id: aiGatewayId } } : {})
      })(modelId));

  return definePlugin({
    key: "triage",

    /**
     * Building the classifier is inside the guarantee, not in front of it.
     *
     * `shouldReply` catches its own failures, but it can only catch what happens
     * after it is entered — and `createWorkersAI` throws synchronously when the
     * binding is missing, before the call is ever made. That threw straight out
     * of this hook, which is the one outcome the whole design forbids: a triage
     * outage must degrade to *running the turn*, never to a silent agent.
     * (`createAgentRuntime` also treats a rejected gate as `true`, so the agent
     * stayed correct — but a plugin that documents fail-open should not be
     * relying on its host to make that true.)
     */
    shouldHandleTurn: async ({ history }) => {
      let model: LanguageModel;
      try {
        model = classifier();
      } catch (error) {
        console.warn("[triage] classifier unavailable, replying by default", {
          error: String(error)
        });
        return true;
      }
      return shouldReply(model, history, { historyMessages, messageMaxChars });
    }

    // No `requires`. `AI` is core's own mandatory binding, not this plugin's to
    // demand — declaring it would report a core misconfiguration under this
    // plugin's name.
  });
}

// --- declining late: the `no_reply` tool ------------------------------------

/** The tool the model calls to end a turn without replying. */
export const NO_REPLY_TOOL_NAME = "no_reply";

/**
 * Tool result when a `no_reply` call is ignored. This is only ever read by the
 * model in one case: it has already sent something this turn (so the tool was
 * withdrawn) yet named it anyway — the call is ignored and it must finish with a
 * reply. When a `no_reply` call is instead honoured it ends the turn, and this
 * result is discarded unread.
 */
export const NO_REPLY_IGNORED =
  "Ignored: you have already sent a message this turn — finish with a reply.";

/**
 * End the turn without replying — the *late* counterpart to the pre-turn gate.
 * The agent looks something up, concludes there is nothing worth adding, and
 * declines.
 *
 * Deliberately an ordinary tool with an ordinary no-op `execute`: the loop, not
 * the tool, decides what a `no_reply` call means (see {@link isNoReplyTurn}).
 * Two things here are load-bearing:
 *
 * - **`execute` must exist.** Once the agent has spoken the tool is withdrawn,
 *   but the model can still name it (the SDK resolves calls against the
 *   unfiltered map); that call is ignored and the loop must continue to a real
 *   reply. `generateText` only continues while every tool call in a step
 *   produced an output, so without `execute` that step would halt with no reply
 *   text and surface as a failure. Executing normally keeps the counts equal.
 * - **`reason` must stay optional.** A required field the model omits makes the
 *   SDK mark the call invalid and skip execution, halting the loop the same way.
 *
 * Wiring is the loop's: offer this tool until the agent has spoken, withdraw it
 * after, and stop the run when {@link isNoReplyTurn} holds.
 */
export const noReplyTool = tool({
  description:
    "End this turn without replying at all, when the message needs no answer from you (chatter, people talking to each other, anything not addressed to you) — or when you looked into it and there is genuinely nothing worth adding. Calling this ends the turn immediately, so do not pair it with a tool whose result you still need. Only available until you have sent anything this turn.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe("One short phrase: why this message needs no reply.")
  }),
  execute: async () => NO_REPLY_IGNORED
});

/**
 * What the agent is told about {@link noReplyTool}, as a system-prompt suffix.
 *
 * It lives here rather than in a host's prompt file for the same reason a subtask
 * type carries its own `capability`: everything the model is told about a
 * capability is declared by whatever owns that capability, so uninstalling the
 * plugin takes its advice with it. A host describing a `no_reply` tool it no
 * longer installs is the exact drift those fields exist to end.
 *
 * Not a `capability` on the plugin, though, and the distinction is the design.
 * `capability` is rendered into the soul once and is true for the whole
 * conversation; this has to be **withdrawn mid-turn**, the moment the agent
 * speaks, in the same `prepareStep` that withdraws the tool. Advice for a tool
 * that is no longer on the call is worse than no advice — so the loop injects it,
 * and the loop is what knows when.
 */
export const NO_REPLY_GUIDANCE = [
  "",
  "",
  "You see every message in this channel, including the many that are not for you.",
  "Call the `no_reply` tool to end your turn without replying whenever the message needs no answer from you: people talking to each other, chatter, acknowledgements, or anything you were not asked about. You may also look something up first and then call `no_reply` if, having looked, there is genuinely nothing worth adding.",
  "Staying silent is the right default in a busy channel. Reply only when you are addressed, asked a question, or can add something the conversation clearly needs.",
  "Calling `no_reply` ends your turn at once — don't pair it with a tool whose result you still need, and don't write any text with it (that text is discarded). It is unavailable once you have already sent something this turn."
].join("\n");

/** The only part of a `StepResult` the no-reply predicates read. */
type ToolCallingStep = { toolCalls: ReadonlyArray<{ toolName: string }> };

/** Whether a step calls `no_reply` at all — on its own or beside other tools. */
export function stepCallsNoReply(step: ToolCallingStep): boolean {
  return step.toolCalls.some((c) => c.toolName === NO_REPLY_TOOL_NAME);
}

/**
 * Whether a run declined to reply: the agent has **not sent anything this turn**
 * (`!repliedAny`) and its final step called `no_reply`. A `no_reply` call ends
 * the turn the moment it appears — even beside another tool, which still runs
 * but whose result is discarded — so the first step to call it is the last. A
 * `no_reply` after the agent already streamed content is the one thing ignored.
 *
 * `!repliedAny` is the runtime guard that lets `no_reply` be a *late* decision
 * while still forbidding it once the agent has spoken. Hiding the tool from the
 * model merely hides it; the SDK still resolves a tool call against the full,
 * unfiltered map, so a model that names `no_reply` after speaking executes it
 * happily — this flag is what stops that from discarding a turn the user has
 * already seen.
 */
export function isNoReplyTurn(
  repliedAny: boolean,
  steps: readonly ToolCallingStep[]
): boolean {
  const last = steps.at(-1);
  return !repliedAny && last !== undefined && stepCallsNoReply(last);
}
