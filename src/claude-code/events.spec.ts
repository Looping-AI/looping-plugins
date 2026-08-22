import { describe, it, expect } from "vitest";
import { parseStream, toProgress, type ClaudeCodeEvent } from "./events.js";

/**
 * The stream parser, and the three ways it can quietly ruin a run.
 *
 * It can **duplicate** — a retried chunk replays the tail, and a key that does
 * not collide re-posts everything the parent already saw. It can **flood** — the
 * inner subagent tree talks on the same stream, and forwarding it fills the
 * parent's context with work the parent can neither read nor cancel. And it can
 * **lose everything** — one unrecognised line thrown from the parser discards
 * the whole run's only record of what it did.
 *
 * Each of those has a test below, because none of them looks like a failure at
 * the time.
 */

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const init = (sessionId = "sess-1") =>
  line({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "opus"
  });

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  line({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    ...extra
  });

/**
 * A `result` line with the exact field names Claude Code 2.1.238 emits.
 *
 * Copied from the Phase 0b burst (`call-1.json`, 2026-08-20) rather than
 * invented, because every one of these keys is a place a rename would break the
 * cost accounting silently — the run would still succeed and simply report
 * spending nothing.
 */
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "the answer",
  session_id: "257ba51d-8527-438c-828e-9e273cfb02b7",
  num_turns: 1,
  duration_ms: 15_000,
  api_error_status: null,
  total_cost_usd: 0.0572045,
  permission_denials: [],
  subagent_stats: { spawned: 0 },
  usage: {
    input_tokens: 2,
    output_tokens: 685,
    cache_read_input_tokens: 18_713,
    cache_creation_input_tokens: 2_972
  }
};

describe("parseStream", () => {
  it("reads an init line and reports the session id", () => {
    const { events } = parseStream(init("abc"));
    expect(events).toEqual([{ kind: "init", sessionId: "abc", model: "opus" }]);
  });

  /**
   * A bounded-window drain reads whatever has arrived, which cuts a line in half
   * routinely rather than rarely. Parsing the half loses a whole event.
   */
  it("holds an incomplete trailing line back as carry", () => {
    const buffer = `${init()}{"type":"assist`;
    const { events, carry, skipped } = parseStream(buffer);

    expect(events).toHaveLength(1);
    expect(carry).toBe('{"type":"assist');
    // Emphatically not a skip: nothing is wrong with it yet.
    expect(skipped).toBe(0);
  });

  it("parses the line once the rest of it arrives", () => {
    const first = parseStream(`${init()}{"type":"assistant","message":`);
    const rest = `{"content":[{"type":"text","text":"done"}]}}\n`;
    const second = parseStream(first.carry + rest);

    expect(second.events).toEqual([
      { kind: "assistant", text: "done", tools: [] }
    ]);
  });

  /**
   * The single most important line in the module. Claude Code runs its own
   * subagents and they talk on this same stream; they are invisible to Looping's
   * scheduler and unreachable by its cancellation sweep, so their chatter is
   * noise the parent can neither act on nor stop.
   */
  it("drops messages belonging to Claude Code's own subagents", () => {
    const buffer =
      assistant("outer work") +
      assistant("inner chatter", { parent_tool_use_id: "toolu_123" }) +
      assistant("more outer work");

    const { events, nested } = parseStream(buffer);

    expect(events.map((e) => e.kind === "assistant" && e.text)).toEqual([
      "outer work",
      "more outer work"
    ]);
    expect(nested).toBe(1);
  });

  it("drops thinking blocks but keeps the text beside them", () => {
    const buffer = line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "a long private deliberation" },
          { type: "text", text: "the visible part" }
        ]
      }
    });

    expect(parseStream(buffer).events).toEqual([
      { kind: "assistant", text: "the visible part", tools: [] }
    ]);
  });

  it("names the tools an assistant turn called", () => {
    const buffer = line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "editing" },
          { type: "tool_use", name: "Edit", input: {} },
          { type: "tool_use", name: "Bash", input: {} }
        ]
      }
    });

    expect(parseStream(buffer).events).toEqual([
      { kind: "assistant", text: "editing", tools: ["Edit", "Bash"] }
    ]);
  });

  /**
   * `user` lines on this stream are tool results being fed back to the model —
   * large, and already summarised by the assistant turn that follows.
   */
  it("says nothing about tool results coming back", () => {
    const buffer = line({
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] }
    });
    expect(parseStream(buffer).events).toEqual([]);
  });

  it("surfaces an api_retry, which is what a budget refusal looks like", () => {
    const buffer = line({
      type: "system",
      subtype: "api_retry",
      error: "rate_limit",
      attempt: 2
    });

    expect(parseStream(buffer).events).toEqual([
      { kind: "retry", detail: "rate_limit" }
    ]);
  });

  /**
   * The stream is a vendor's and it is version-coupled. Throwing on one bad line
   * would discard a whole run's output to report a schema change.
   */
  it("skips a malformed line instead of throwing, and counts it", () => {
    const buffer = `not json at all\n${init()}{"type":"nonsense"}\n`;
    const { events, skipped } = parseStream(buffer);

    expect(events).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("is silent about system subtypes it does not recognise", () => {
    // Not a skip — nothing is wrong, there is simply nothing to say. Counting
    // these would make the skip signal useless as soon as a release adds one.
    const buffer = line({ type: "system", subtype: "something_new" });
    const { events, skipped } = parseStream(buffer);

    expect(events).toEqual([]);
    expect(skipped).toBe(0);
  });

  describe("the result line", () => {
    it("reads every field the cost accounting depends on", () => {
      const { events } = parseStream(line(RESULT));
      expect(events).toHaveLength(1);
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result).toEqual({
        subtype: "success",
        isError: false,
        text: "the answer",
        sessionId: "257ba51d-8527-438c-828e-9e273cfb02b7",
        numTurns: 1,
        durationMs: 15_000,
        apiErrorStatus: null,
        costUsd: 0.0572045,
        subagentsSpawned: 0,
        permissionDenials: 0,
        usage: {
          input: 2,
          output: 685,
          cacheRead: 18_713,
          cacheWrite: 2_972
        }
      });
    });

    /**
     * Cache reads were 18,713 against 2 raw input tokens on this very call.
     * Folding them into one "input" number would describe none of the cost, and
     * the budget governor meters from exactly this event.
     */
    it("keeps cache reads and writes apart", () => {
      const { events } = parseStream(line(RESULT));
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;
      expect(event.result.usage.cacheRead).toBeGreaterThan(
        event.result.usage.input * 1000
      );
    });

    it("reports an error subtype without inventing a cost", () => {
      const { events } = parseStream(
        line({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          api_error_status: 429
        })
      );
      const event = events[0] as Extract<ClaudeCodeEvent, { kind: "result" }>;

      expect(event.result.subtype).toBe("error_max_turns");
      expect(event.result.isError).toBe(true);
      expect(event.result.apiErrorStatus).toBe(429);
      expect(event.result.costUsd).toBe(0);
      expect(event.result.text).toBe("");
    });
  });
});

describe("toProgress", () => {
  it("keys notes by position, continuing from where the last chunk stopped", () => {
    const { events } = parseStream(assistant("one") + assistant("two"));

    expect(toProgress(events, 0).map((p) => p.key)).toEqual([
      "claude:0",
      "claude:1"
    ]);
    expect(toProgress(events, 7).map((p) => p.key)).toEqual([
      "claude:7",
      "claude:8"
    ]);
  });

  /**
   * The replay case, and the reason the key is positional.
   *
   * A chunk that dies mid-drain is retried, the re-attach replays the tail, and
   * the same turns are parsed again. Re-parsing from the same offset must
   * produce the same keys, so the gateway drops the repeats.
   */
  it("produces identical keys when a replayed tail is parsed twice", () => {
    const tail = assistant("running tests") + assistant("running tests");
    const first = toProgress(parseStream(tail).events, 4);
    const second = toProgress(parseStream(tail).events, 4);

    expect(second).toEqual(first);
    // And two *genuinely* repeated notes still get distinct keys — a
    // content-derived key would have collapsed these into one.
    expect(first.map((p) => p.key)).toEqual(["claude:4", "claude:5"]);
  });

  it("says nothing for init or result, which the caller reports itself", () => {
    const { events } = parseStream(init() + line(RESULT));
    expect(toProgress(events, 0)).toEqual([]);
  });

  it("prefixes a turn with the tools it called", () => {
    const buffer = line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "tool_use", name: "Bash", input: {} }
        ]
      }
    });

    // De-duplicated: two Bash calls in one turn are one tool, named once.
    expect(toProgress(parseStream(buffer).events, 0)[0]?.text).toBe(
      "[Bash] checking"
    );
  });

  it("clips a long turn rather than pasting an essay into the parent", () => {
    const note = toProgress(
      parseStream(assistant("x".repeat(5_000))).events,
      0
    );
    expect(note[0]!.text.length).toBeLessThan(300);
    expect(note[0]!.text.endsWith("…")).toBe(true);
  });
});
