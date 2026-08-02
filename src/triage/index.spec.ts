import { describe, it, expect, vi } from "vitest";
import type { LanguageModel } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createAgentRuntime } from "@loopingai/core";
import { mockModel } from "@loopingai/core/testing";
import {
  buildTriagePrompt,
  isNoReplyTurn,
  noReplyTool,
  NO_REPLY_IGNORED,
  NO_REPLY_TOOL_NAME,
  shouldReply,
  stepCallsNoReply,
  triage,
  triageSchema
} from "./index.js";
import { acceptsInput, callTool, inputShape } from "../../test/helpers.js";

/** A stored message, shaped just enough for the prompt builder. */
function msg(role: "user" | "assistant", text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role,
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  } as SessionMessage;
}

/** A user turn wrapped in the gateway's provenance tag, as production stores it. */
function turn(from: string, body: string): SessionMessage {
  return msg(
    "user",
    `<turn from="${from}" id="U1" channel="C1" at="2026-07-28T10:00:00Z">${body}</turn>`
  );
}

/** A verdict object with every field present; override the ones under test. */
function verdict(overrides: Record<string, unknown> = {}) {
  return {
    for_other_people: false,
    for_another_agent: false,
    can_contribute: true,
    should_reply: true,
    reason: "asked you directly",
    ...overrides
  };
}

/**
 * A classifier that answers with `value`. Core's `mockModel` scripts a plain-text
 * step, which is exactly what `Output.object` parses — so a structured-output
 * double needs no machinery of its own.
 */
const answering = (value: unknown): LanguageModel =>
  mockModel({
    text: typeof value === "string" ? value : JSON.stringify(value)
  });

describe("triageSchema", () => {
  it("orders the reasoning fields ahead of the verdict", () => {
    // Load-bearing, not cosmetic: constrained decoding fills properties in
    // schema order, so these keys are what the model commits to *before* it can
    // name a verdict. Reordering them changes what it reasons about.
    expect(Object.keys(triageSchema.shape)).toEqual([
      "for_other_people",
      "for_another_agent",
      "can_contribute",
      "should_reply",
      "reason"
    ]);
  });
});

describe("buildTriagePrompt", () => {
  it("names the speaker from the <turn> wrapper and unwraps the body", () => {
    const prompt = buildTriagePrompt([
      turn("Bruno", "did you see the deploy?")
    ]);
    expect(prompt).toContain("Bruno: did you see the deploy?");
    // The provenance tag itself is noise for a classifier — only who, and what.
    expect(prompt).not.toContain("<turn");
  });

  it("labels assistant turns as the agent's own", () => {
    // "The previous message was your own" is one of the rules, so the transcript
    // has to make that legible.
    const prompt = buildTriagePrompt([
      turn("Bruno", "what's the staging URL?"),
      msg("assistant", "It's staging.example.com"),
      turn("Bruno", "thanks")
    ]);
    expect(prompt).toContain("you: It's staging.example.com");
  });

  it("handles un-wrapped user text", () => {
    expect(buildTriagePrompt([msg("user", "plain message")])).toContain(
      "someone: plain message"
    );
  });

  it("keeps only the last historyMessages messages", () => {
    const history = Array.from({ length: 16 }, (_, i) =>
      turn("Bruno", `message ${i}`)
    );
    const prompt = buildTriagePrompt(history, { historyMessages: 12 });
    expect(prompt).not.toContain("message 0");
    expect(prompt).toContain("message 15");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(550);
    const prompt = buildTriagePrompt([turn("Bruno", long)], {
      messageMaxChars: 500
    });
    expect(prompt).toContain(`${"x".repeat(500)}…`);
    expect(prompt).not.toContain(long);
  });

  it("states that the last line is the message being judged", () => {
    // Without this anchor the classifier may judge the wrong turn.
    expect(buildTriagePrompt([turn("Bruno", "hi")])).toContain(
      "The last line is the message you are judging"
    );
  });
});

describe("shouldReply", () => {
  const history = [turn("Bruno", "hey Ana, lunch?")];

  it("returns the model's verdict", async () => {
    await expect(
      shouldReply(answering(verdict({ should_reply: true })), history)
    ).resolves.toBe(true);
    await expect(
      shouldReply(answering(verdict({ should_reply: false })), history)
    ).resolves.toBe(false);
  });

  it("reads should_reply alone, not the reasoning booleans", async () => {
    // The booleans steer generation; they are not re-derived in code. A verdict
    // that disagrees with them is still the verdict.
    await expect(
      shouldReply(
        answering(
          verdict({
            for_other_people: true,
            can_contribute: false,
            should_reply: true
          })
        ),
        history
      )
    ).resolves.toBe(true);
  });

  it("fails open when the model's output does not parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(shouldReply(answering("¯\\_(ツ)_/¯"), history)).resolves.toBe(
      true
    );
    warn.mockRestore();
  });

  it("fails open when the object is missing the verdict", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { should_reply: _omitted, ...partial } = verdict();
    await expect(shouldReply(answering(partial), history)).resolves.toBe(true);
    warn.mockRestore();
  });
});

describe("triage()", () => {
  const history = [turn("Bruno", "hey Ana, lunch?")];

  it("declines a turn the classifier says is not for the agent", async () => {
    const rt = createAgentRuntime({
      plugins: [
        triage({
          ai: {} as Ai,
          model: answering(verdict({ should_reply: false }))
        })
      ]
    });
    expect(await rt.shouldHandleTurn({ history })).toBe(false);
  });

  it("handles a turn the classifier says is for the agent", async () => {
    const rt = createAgentRuntime({
      plugins: [triage({ ai: {} as Ai, model: answering(verdict()) })]
    });
    expect(await rt.shouldHandleTurn({ history })).toBe(true);
  });

  it("never touches the AI binding until a turn is actually judged", () => {
    // Cloudflare evaluates module scope during `wrangler deploy` to validate the
    // new version, and bindings are not populated then — a provider built eagerly
    // throws "you must provide either a binding or credentials" at deploy time,
    // which is a broken deploy rather than a failed request.
    const ai = new Proxy({} as Ai, {
      get() {
        throw new Error("AI binding read at construction");
      }
    });
    expect(() => triage({ ai })).not.toThrow();
    expect(() =>
      createAgentRuntime({ plugins: [triage({ ai })] })
    ).not.toThrow();
  });

  it("demands no bindings of the host", () => {
    // `AI` is core's own mandatory binding. Declaring it here would report a core
    // misconfiguration under this plugin's name.
    expect(triage({ ai: {} as Ai }).requires).toBeUndefined();
  });
});

describe("no_reply — declining late", () => {
  it("keeps `reason` optional", () => {
    // A required field the model omits makes the SDK mark the call invalid and
    // skip execution, halting the loop with no reply text at all.
    expect(Object.keys(inputShape(noReplyTool))).toEqual(["reason"]);
    expect(acceptsInput(noReplyTool, {})).toBe(true);
  });

  it("executes to a result rather than having no execute at all", async () => {
    // `generateText` only continues while every tool call in a step produced an
    // output. A `no_reply` the loop means to ignore must still return something,
    // or the step halts and the turn surfaces as a failure.
    expect(noReplyTool.execute).toBeDefined();
    expect(await callTool(noReplyTool, { reason: "chatter" })).toBe(
      NO_REPLY_IGNORED
    );
  });

  it("counts a decline only when the agent has not already spoken", () => {
    const declined = [{ toolCalls: [{ toolName: NO_REPLY_TOOL_NAME }] }];

    expect(isNoReplyTurn(false, declined)).toBe(true);
    // The guard that matters: hiding the tool only hides it, and the SDK still
    // resolves a call against the unfiltered map. Without this flag a model that
    // names `no_reply` after speaking would discard a turn the user has seen.
    expect(isNoReplyTurn(true, declined)).toBe(false);
  });

  it("counts a decline made beside another tool call", () => {
    // A `no_reply` ends the turn the moment it appears, even alongside a tool
    // whose result is then discarded — so the first step to call it is the last.
    expect(
      stepCallsNoReply({
        toolCalls: [{ toolName: "browser_markdown" }, { toolName: "no_reply" }]
      })
    ).toBe(true);
  });

  it("is not a decline when the last step called something else", () => {
    expect(
      isNoReplyTurn(false, [
        { toolCalls: [{ toolName: NO_REPLY_TOOL_NAME }] },
        { toolCalls: [{ toolName: "browser_markdown" }] }
      ])
    ).toBe(false);
    expect(isNoReplyTurn(false, [])).toBe(false);
  });
});
