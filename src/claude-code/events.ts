import type { ProgressEvent } from "@dynamicagents/core/subtasks";

/**
 * `claude -p --output-format stream-json` on the wire, turned into things this
 * package can act on.
 *
 * ## Pure, and stateless on purpose
 *
 * Nothing here remembers anything between calls. That is not minimalism — it is
 * what makes the drain re-entrant. A Claude Code run is drained in bounded
 * windows across several durable chunks, and a chunk that starts on a fresh
 * isolate re-attaches with `getExec(id, { resume: "tail" })`, which replays. A
 * parser holding a cursor would hand back a different answer depending on which
 * isolate asked, and the difference would show up as duplicated or missing
 * progress in the parent's context rather than as an error.
 *
 * So the caller owns the position and passes it in. See {@link toProgress}.
 *
 * ## A malformed line is skipped, never thrown
 *
 * The stream is a vendor's, it is version-coupled (see the pinned image), and it
 * is the *only* record of what a run did. A parser that throws on one
 * unrecognised line discards the whole run's output to report a schema change,
 * which is the worst possible trade. Unparseable lines are counted instead —
 * {@link ParsedStream.skipped} — so a systematic change is visible in the logs
 * rather than silent, and a single corrupt line costs one line.
 */

/** Content blocks Claude Code emits inside an `assistant` message. */
interface AssistantBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

/** What a `result` line carries, of the fields anything here reads. */
export interface ClaudeCodeResult {
  /** `success`, or one of the `error_*` subtypes. */
  subtype: string;
  isError: boolean;
  /** The run's final answer. Empty is legal and is handled by the caller. */
  text: string;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  /** `null` on a clean run; an HTTP status when the API refused. */
  apiErrorStatus: number | null;
  costUsd: number;
  usage: ClaudeCodeUsage;
  /** How many inner subagents the run spawned — advisory, for the logs. */
  subagentsSpawned?: number;
  permissionDenials: number;
}

/**
 * Token counts, flattened.
 *
 * Cache reads and writes are separated because they are priced differently and
 * because they are the *bulk* of what a `claude -p` invocation bills: a
 * ten-call burst measured 20 raw input tokens against 187,130 cache reads. A
 * usage summary that folds them into one "input" number describes none of the
 * cost.
 */
export interface ClaudeCodeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ClaudeCodeEvent =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "assistant"; text: string; tools: string[] }
  | { kind: "retry"; detail: string }
  /**
   * A tool call the session was not allowed to make.
   *
   * Surfaced rather than counted, because the count is useless on its own and
   * the wording is the whole diagnosis: a session denied `Write` is
   * misconfigured, a session denied one `Bash(curl …)` by a deny rule is working
   * as intended, and `permissionDenials: 3` cannot tell them apart. This is the
   * event that says which.
   */
  | { kind: "denied"; tool?: string; reason: string }
  | { kind: "result"; result: ClaudeCodeResult };

export interface ParsedStream {
  events: ClaudeCodeEvent[];
  /**
   * Bytes after the last newline — an incomplete line the next read completes.
   *
   * A bounded-window drain reads whatever has arrived, which routinely cuts a
   * line in half. Parsing that half throws away a whole event; carrying it costs
   * one string.
   */
  carry: string;
  /** Lines that were not JSON, or were JSON of no recognised shape. */
  skipped: number;
  /**
   * The first skipped line, clipped — absent when nothing was skipped.
   *
   * A count alone says a schema moved and refuses to say how. That is the
   * position this package spent a production incident in: `skipped: 1` on every
   * single session, for days, naming nothing. One clipped line is the difference
   * between a warning an operator can act on and a warning they learn to scroll
   * past.
   *
   * Clipped rather than whole because an unrecognised line is exactly the one
   * with no size contract — and it lands in a log, not a context window.
   */
  sample?: string;
  /** Lines dropped for carrying `parent_tool_use_id`. See {@link parseStream}. */
  nested: number;
}

const EMPTY_USAGE: ClaudeCodeUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readUsage(raw: unknown): ClaudeCodeUsage {
  const usage = asRecord(raw);
  if (!usage) return { ...EMPTY_USAGE };
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens)
  };
}

/**
 * Flatten an `assistant` message into a line of prose and the tools it called.
 *
 * `thinking` blocks are dropped. They are the model's private reasoning, they
 * are the largest thing in the stream by a wide margin, and the parent agent is
 * being shown progress rather than asked to review the subagent's deliberation.
 */
function readAssistant(message: Record<string, unknown>): {
  text: string;
  tools: string[];
} {
  const content = Array.isArray(message.content)
    ? (message.content as AssistantBlock[])
    : [];
  const text: string[] = [];
  const tools: string[] = [];

  for (const block of content) {
    if (!asRecord(block)) continue;
    const blockText = str(block.text);
    if (block.type === "text" && blockText) text.push(blockText.trim());
    const toolName = str(block.name);
    if (block.type === "tool_use" && toolName) tools.push(toolName);
  }

  return { text: text.join(" ").replace(/\s+/g, " ").trim(), tools };
}

/**
 * Read a `system`/`permission_denied` line into something worth reporting.
 *
 * Claude Code emits one per auto-denied tool call — the headless path denies
 * rather than prompts, so this is what a permission problem looks like from
 * outside the container. Three fields carry the answer and any of them may be
 * absent, so they are tried in order of how much they explain: the message the
 * model was given, then the deciding component's own words, then the bare
 * discriminator (`mode`, `rule`, `classifier`, `asyncAgent`).
 *
 * `agent_id` is deliberately not read. It marks a denial inside Claude Code's
 * own subagent tree, and unlike the `parent_tool_use_id` filter above there is
 * no case for dropping those: an inner subagent that cannot write is the same
 * misconfiguration as an outer one, discovered one level down.
 */
function readDenial(event: Record<string, unknown>): ClaudeCodeEvent {
  const tool = str(event.tool_name);
  const reason =
    str(event.message) ??
    str(event.decision_reason) ??
    str(event.decision_reason_type) ??
    "no reason given";
  return { kind: "denied", reason, ...(tool ? { tool } : {}) };
}

/**
 * Parse whatever has arrived so far into complete events plus a carry.
 *
 * **Messages carrying `parent_tool_use_id` are dropped**, and this is the single
 * most important line in the module. Claude Code runs its *own* subagents, and
 * every message one of them produces arrives on this same stream tagged with the
 * parent tool-use that spawned it. Forwarding those fills the Dynamic Agents
 * parent's context with the inner tree's chatter — which it can neither act on
 * nor cancel, because those subagents are invisible to Dynamic Agents'
 * scheduler. The tag is the only reliable way to tell the two apart, so it is
 * the filter.
 *
 * `result` and `init` are never nested and are read unconditionally.
 */
export function parseStream(buffer: string): ParsedStream {
  const events: ClaudeCodeEvent[] = [];
  let skipped = 0;
  let nested = 0;
  let sample: string | undefined;

  /**
   * Count an unrecognised line, and remember the first one.
   *
   * First rather than last: a stream that has gone wrong systematically repeats
   * the same shape, and the earliest instance is the one closest to whatever
   * changed. Every `skipped++` in this function goes through here so that a
   * later branch cannot quietly count without sampling.
   */
  const skip = (line: string): void => {
    skipped++;
    sample ??= clip(line, SAMPLE_MAX_CHARS);
  };

  const newline = buffer.lastIndexOf("\n");
  const carry = newline === -1 ? buffer : buffer.slice(newline + 1);
  const complete = newline === -1 ? "" : buffer.slice(0, newline);

  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skip(trimmed);
      continue;
    }

    const event = asRecord(parsed);
    if (!event) {
      skip(trimmed);
      continue;
    }

    // The inner-subagent filter. Checked before the type switch so it applies to
    // every message shape, including ones added by a later Claude Code.
    if (str(event.parent_tool_use_id)) {
      nested++;
      continue;
    }

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          const sessionId = str(event.session_id);
          if (!sessionId) {
            skip(trimmed);
            break;
          }
          const model = str(event.model);
          events.push({
            kind: "init",
            sessionId,
            ...(model ? { model } : {})
          });
          break;
        }
        if (event.subtype === "permission_denied") {
          events.push(readDenial(event));
          break;
        }
        if (event.subtype === "api_retry") {
          events.push({
            kind: "retry",
            detail:
              str(event.error) ??
              str(event.message) ??
              `attempt ${num(event.attempt) || "?"}`
          });
          break;
        }
        // Other `system` subtypes are informational and grow between releases.
        // Not "skipped": nothing is wrong, there is simply nothing to say.
        //
        // That reading is right for the rest of them and was wrong for
        // `permission_denied` above, which sat in here for a release saying
        // nothing while every session in the deployment was being refused every
        // write. A new subtype belongs here only once somebody has read what it
        // carries; the default is silence, not the conclusion that it is noise.
        break;
      }

      case "assistant": {
        const message = asRecord(event.message);
        if (!message) {
          skip(trimmed);
          break;
        }
        const { text, tools } = readAssistant(message);
        if (!text && tools.length === 0) break;
        events.push({ kind: "assistant", text, tools });
        break;
      }

      // `user` messages on this stream are tool *results* being fed back to the
      // model, not anything a human said. They are large, they are already
      // summarised by the assistant turn that follows, and the un-nested ones
      // belong to the outer run's own tools — so they are deliberately not
      // surfaced as progress.
      case "user":
        break;

      case "result": {
        events.push({ kind: "result", result: readResult(event) });
        break;
      }

      default:
        skip(trimmed);
    }
  }

  return { events, carry, skipped, nested, ...(sample ? { sample } : {}) };
}

/** Read a `result` line. Total by construction — a missing field reads as zero. */
function readResult(event: Record<string, unknown>): ClaudeCodeResult {
  const apiErrorStatus = event.api_error_status;
  const stats = asRecord(event.subagent_stats);
  const denials = Array.isArray(event.permission_denials)
    ? event.permission_denials.length
    : 0;
  const sessionId = str(event.session_id);
  const spawned = stats ? num(stats.spawned) : undefined;

  return {
    subtype: str(event.subtype) ?? "unknown",
    isError: event.is_error === true,
    text: typeof event.result === "string" ? event.result : "",
    ...(sessionId ? { sessionId } : {}),
    numTurns: num(event.num_turns),
    durationMs: num(event.duration_ms),
    apiErrorStatus: typeof apiErrorStatus === "number" ? apiErrorStatus : null,
    costUsd: num(event.total_cost_usd),
    usage: readUsage(event.usage),
    ...(spawned === undefined ? {} : { subagentsSpawned: spawned }),
    permissionDenials: denials
  };
}

/** How much of one progress note the parent is shown. */
const PROGRESS_MAX_CHARS = 240;

/**
 * How much of an unrecognised line is kept for the logs.
 *
 * Shorter than a progress note and for a different reason: a note is read by a
 * model deciding what to do next, whereas this is read by a person deciding
 * whether a schema moved. The discriminating part of a stream-json line is its
 * `type` and `subtype`, both of which are at the front.
 */
const SAMPLE_MAX_CHARS = 200;

/**
 * Turn events into progress notes the parent can post.
 *
 * **`from` is the number of notes already emitted for this run, and the key is
 * derived from it.** Not from the note's content, not from a clock, and not from
 * the Claude Code `uuid` — from position alone.
 *
 * The reason is replay. A chunk that dies mid-drain is retried by the Workflow,
 * the re-attach replays the tail, and the same assistant turn is parsed twice. A
 * content-derived key would make two identical notes collide *by luck* (and two
 * genuinely repeated notes — "Running tests" twice — collide wrongly). A
 * clock-derived key would never collide, so every replay would re-post
 * everything. Position is the only choice that dedupes exactly the events that
 * are the same event.
 */
export function toProgress(
  events: readonly ClaudeCodeEvent[],
  from: number
): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  let n = from;

  for (const event of events) {
    const text = describe(event);
    if (!text) continue;
    out.push({ key: `claude:${n}`, text });
    n++;
  }

  return out;
}

/** One line of progress, or nothing when the event is not worth a note. */
function describe(event: ClaudeCodeEvent): string | undefined {
  switch (event.kind) {
    // Tool calls are not narration. A turn that only called tools said nothing
    // the reader can act on, and it cost one Slack message per Bash/Read/Edit —
    // nine of them for a one-line README edit. The tool names added nothing to
    // the turns that *did* have text either, so the prefix goes with them.
    //
    // Same policy the in-process agents already apply in the gatekeeper
    // (src/agents/shared/loop.ts: "Tool-only steps stay silent in Slack").
    // Deliberately narrower than silencing the whole channel: `denied` and
    // `retry` below stay, because they are the only evidence of a session that
    // is being refused or throttled.
    case "assistant":
      return event.text ? clip(event.text) : undefined;
    case "denied":
      // The one progress note that is more useful than the session's own
      // account of itself. A refused tool call is invisible in the transcript —
      // the model simply narrates an alternative approach — so without this the
      // parent sees a subagent being resourceful and never learns it was fenced
      // in. Named tool first, because that is what distinguishes a broken
      // configuration from a deny rule doing its job.
      return `permission denied${event.tool ? ` for ${event.tool}` : ""}: ${clip(event.reason)}`;
    case "retry":
      // Surfaced deliberately. This is what a budget refusal from the egress
      // gateway looks like from inside the container, and a run that ends
      // shortly afterwards is explained by it.
      return `retrying the model call: ${clip(event.detail)}`;
    // `init` names a session id nobody outside this package can use, and
    // `result` is the terminal outcome the caller reports itself.
    case "init":
    case "result":
      return undefined;
  }
}

function clip(text: string, max: number = PROGRESS_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
