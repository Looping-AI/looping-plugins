import { describe, it, expect, vi } from "vitest";
import { TEST_MODELS } from "@loopingai/core/testing";
import { createAgentRuntime } from "@loopingai/core";
import type { SessionLike } from "@loopingai/core/agent";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  archiveMessages,
  recall,
  recallSearch,
  toRecallVectors,
  type Embed,
  type RecallIndex,
  type RecallResult
} from "./index.js";
import { callTool } from "../../test/helpers.js";

/** A stored message. */
function msg(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  } as SessionMessage;
}

/** A user turn wrapped in the gateway's provenance tag, as production stores it. */
function turn(id: string, from: string, body: string): SessionMessage {
  return msg(
    id,
    "user",
    `<turn from="${from}" id="U1" channel="C1" at="2026-07-28T10:00:00Z">${body}</turn>`
  );
}

/** Deterministic embeddings — one dimension per text, so order is assertable. */
const embed: Embed = async (texts) => texts.map((_, i) => [i, 0, 0]);

/** A Vectorize double that records what it was asked to store and search. */
function fakeIndex(matches: VectorizeMatches["matches"] = []) {
  const upserted: VectorizeVector[][] = [];
  const queries: Array<{ vector: number[]; options?: VectorizeQueryOptions }> =
    [];
  const index: RecallIndex = {
    upsert: async (vectors) => {
      upserted.push(vectors);
      return {};
    },
    query: async (vector, options) => {
      queries.push({ vector, options });
      return { count: matches.length, matches } as VectorizeMatches;
    }
  };
  return { index, upserted, queries };
}

const sessionWith = (compactions: number): SessionLike =>
  ({
    getCompactions: async () => Array.from({ length: compactions }, () => ({}))
  }) as unknown as SessionLike;

describe("toRecallVectors", () => {
  it("keys each vector by the message's own id", () => {
    // What makes re-archiving on a compaction retry an idempotent upsert rather
    // than a duplicate.
    const vectors = toRecallVectors(
      [msg("m1", "user", "one"), msg("m2", "assistant", "two")],
      "caller:abc",
      [
        [1, 0, 0],
        [0, 1, 0]
      ]
    );
    expect(vectors.map((v) => v.id)).toEqual(["m1", "m2"]);
    expect(vectors.every((v) => v.namespace === "caller:abc")).toBe(true);
  });

  it("lifts <turn> provenance into metadata", () => {
    // Without the speaker, a recalled line is a quote with no attribution — the
    // agent cannot tell who said what it is about to repeat.
    const [vector] = toRecallVectors(
      [turn("m1", "Bruno", "ship it on Friday")],
      "ns",
      [[1, 0, 0]]
    );
    expect(vector.metadata).toMatchObject({
      role: "user",
      author: "Bruno",
      authorId: "U1",
      channel: "C1",
      at: "2026-07-28T10:00:00Z"
    });
  });

  it("stores un-wrapped messages without inventing provenance", () => {
    const [vector] = toRecallVectors([msg("m1", "user", "plain")], "ns", [
      [1, 0, 0]
    ]);
    expect(vector.metadata).toEqual({ role: "user", text: "plain" });
  });

  it("truncates the stored snippet to the metadata cap", () => {
    // Vectorize allows roughly 10 KiB of metadata per vector and the snippet is
    // nearly all of it, so an untruncated message costs the whole upsert.
    const [vector] = toRecallVectors(
      [msg("m1", "user", "x".repeat(3000))],
      "ns",
      [[1, 0, 0]],
      2000
    );
    expect((vector.metadata!.text as string).length).toBe(2000);
  });
});

describe("archiveMessages", () => {
  it("embeds and upserts the displaced range under the namespace", async () => {
    const { index, upserted } = fakeIndex();
    await archiveMessages(
      index,
      "caller:abc",
      [msg("m1", "user", "one"), msg("m2", "assistant", "two")],
      embed
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0].map((v) => v.id)).toEqual(["m1", "m2"]);
  });

  it("skips messages with no text, keeping embeddings aligned", async () => {
    // The embeddings are supplied 1:1 with the messages. Filtering after
    // embedding — or not filtering at all — pairs a vector with the wrong
    // message, and the archive silently attributes text to the wrong turn.
    const { index, upserted } = fakeIndex();
    await archiveMessages(
      index,
      "ns",
      [msg("m1", "user", "   "), msg("m2", "user", "real content")],
      embed
    );
    expect(upserted[0].map((v) => v.id)).toEqual(["m2"]);
    expect(upserted[0][0].metadata!.text).toBe("real content");
  });

  it("does nothing at all when there is nothing to archive", async () => {
    // Not merely an optimization: an empty upsert is a billable round-trip, and
    // compaction can displace a range of purely empty messages.
    const { index, upserted } = fakeIndex();
    await archiveMessages(index, "ns", [], embed);
    await archiveMessages(index, "ns", [msg("m1", "user", "")], embed);
    expect(upserted).toEqual([]);
  });
});

describe("recallSearch", () => {
  it("constrains the query to the caller's own namespace", async () => {
    // The isolation boundary. The namespace is bound in code from the verified
    // identity and is never model input, so one caller cannot read another's
    // archive.
    const { index, queries } = fakeIndex();
    await recallSearch(index, "caller:abc", "the deploy", embed, 5);
    expect(queries[0].options).toMatchObject({
      namespace: "caller:abc",
      topK: 5,
      returnMetadata: "all"
    });
  });

  it("maps metadata to a compact result", async () => {
    const { index } = fakeIndex([
      {
        id: "m1",
        score: 0.82,
        metadata: {
          role: "user",
          text: "ship it Friday",
          author: "Bruno",
          authorId: "U1",
          channel: "C1",
          at: "2026-07-28T10:00:00Z"
        }
      }
    ] as VectorizeMatches["matches"]);

    const [result] = await recallSearch(index, "ns", "when", embed);
    expect(result).toEqual<RecallResult>({
      score: 0.82,
      role: "user",
      text: "ship it Friday",
      author: "Bruno",
      authorId: "U1",
      channel: "C1",
      at: "2026-07-28T10:00:00Z"
    });
  });

  it("omits provenance fields that were never stored", async () => {
    const { index } = fakeIndex([
      { id: "m1", score: 0.5, metadata: { role: "user", text: "plain" } }
    ] as VectorizeMatches["matches"]);

    expect(await recallSearch(index, "ns", "q", embed)).toEqual([
      { score: 0.5, role: "user", text: "plain" }
    ]);
  });

  it("returns nothing when the query could not be embedded", async () => {
    const { index, queries } = fakeIndex();
    const noEmbedding: Embed = async () => [];
    expect(await recallSearch(index, "ns", "q", noEmbedding)).toEqual([]);
    // And never asks Vectorize for matches against an undefined vector.
    expect(queries).toEqual([]);
  });
});

describe("recall()", () => {
  const config = () => ({
    ai: {} as Ai,
    index: fakeIndex().index,
    namespace: () => "caller:abc",
    embed
  });

  it("withholds its tool until history has actually been compacted", async () => {
    // Before the first compaction the archive is empty by construction. A tool
    // whose only possible answer is "nothing yet" costs the model a call to find
    // that out, and costs every round the tokens to describe it.
    const plugin = recall(config());
    expect(await plugin.mainAgentTools!({ session: sessionWith(0) })).toEqual(
      {}
    );
    expect(
      Object.keys(await plugin.mainAgentTools!({ session: sessionWith(1) }))
    ).toEqual(["recall"]);
  });

  it("takes only a query and a limit from the model", async () => {
    // The index, the namespace and the embedder all come from the closure. A
    // schema naming the namespace would be one the model could fill in — and
    // that is the whole isolation boundary.
    const plugin = recall(config());
    const tools = await plugin.mainAgentTools!({ session: sessionWith(1) });
    const shape = (
      tools.recall.inputSchema as unknown as { shape: Record<string, unknown> }
    ).shape;
    expect(Object.keys(shape).sort()).toEqual(["limit", "query"]);
  });

  it("searches the namespace the thunk resolves at call time", async () => {
    // A thunk, not a value: the namespace derives from the verified caller's
    // identity, which is not known when `plugins(env)` runs in `onStart`.
    const { index, queries } = fakeIndex();
    let identity = "unknown";
    const plugin = recall({
      ai: {} as Ai,
      index,
      namespace: () => identity,
      embed
    });
    identity = "caller:abc";

    const tools = await plugin.mainAgentTools!({ session: sessionWith(1) });
    await callTool(tools.recall, { query: "the deploy" });
    expect(queries[0].options).toMatchObject({ namespace: "caller:abc" });
  });

  it("archives what compaction displaces, through the runtime's fan-out", async () => {
    const { index, upserted } = fakeIndex();
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        recall({ ai: {} as Ai, index, namespace: () => "caller:abc", embed })
      ]
    });

    await rt.onMessagesDisplaced([
      msg("m1", "user", "one"),
      msg("m2", "assistant", "two")
    ]);
    expect(upserted[0].map((v) => v.id)).toEqual(["m1", "m2"]);
  });

  it("never lets a Vectorize outage abort compaction", async () => {
    // History must still shorten when the side store is briefly unavailable —
    // otherwise a recall outage becomes an agent that cannot hold a conversation.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: RecallIndex = {
      upsert: async () => {
        throw new Error("VECTORIZE unavailable");
      },
      query: async () => ({ count: 0, matches: [] }) as VectorizeMatches
    };
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        recall({
          ai: {} as Ai,
          index: broken,
          namespace: () => "ns",
          embed
        })
      ]
    });

    await expect(
      rt.onMessagesDisplaced([msg("m1", "user", "one")])
    ).resolves.toBeUndefined();
    expect(errors.mock.calls[0][0]).toContain("recall");
    errors.mockRestore();
  });

  it("never touches the AI binding until something is actually embedded", () => {
    // Cloudflare evaluates module scope during `wrangler deploy` and bindings
    // are not populated then; an eagerly-built provider throws "you must provide
    // either a binding or credentials" at deploy time.
    const ai = new Proxy({} as Ai, {
      get() {
        throw new Error("AI binding read at construction");
      }
    });
    expect(() =>
      recall({ ai, index: fakeIndex().index, namespace: () => "ns" })
    ).not.toThrow();
  });

  it("declares the binding it cannot add for itself", () => {
    expect(recall(config()).requires).toEqual({ bindings: ["VECTORIZE"] });
    expect(() =>
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [recall(config())],
        env: {}
      })
    ).toThrow(/VECTORIZE/);
  });
});
