import { embedMany, tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { SessionMessage } from "agents/experimental/memory/session";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import { parseTurn, sessionText } from "@loopingai/core/agent";

/**
 * `@loopingai/plugins/recall` — episodic memory over Cloudflare Vectorize.
 *
 * When the Session compacts, the raw messages it folds into a summary would
 * otherwise be lost. Core announces that moment (`onMessagesDisplaced`) because
 * core is what performs the lossy operation; this plugin is what does something
 * about it — embedding the displaced range and upserting it, so a `recall` tool
 * can later semantically search history that has scrolled out of the live
 * context window.
 *
 * Core carries **no embedding code at all**: no `Embed` type, no
 * `embeddingModelId`, no recall config. It used to, without a single caller, and
 * that had fixed the shape of embedding for every future plugin — one model, one
 * dimension, `string[] → number[][]` — while `ModelConfig` could only say "the
 * agent has an embedding model" when the true statement is "*this plugin* uses
 * this embedding model". So the whole embedding path lives here.
 *
 * The namespace is always bound in code from the caller's verified identity,
 * never model input, so one caller can never read another's archive.
 */

/** Workers-AI embedding model. 1024-dim/cosine, matching the Vectorize index. */
const DEFAULT_EMBEDDING_MODEL_ID = "@cf/baai/bge-m3";
/** Matches to return from a search. */
const DEFAULT_TOP_K = 5;
/**
 * Stored-snippet cap. Vectorize allows roughly 10 KiB of metadata per vector,
 * and the snippet is nearly all of it — a message longer than this is truncated
 * rather than costing the whole upsert.
 */
const DEFAULT_METADATA_TEXT_MAX = 2000;

/**
 * The subset of the Vectorize binding recall drives — structurally satisfied by
 * `Vectorize`/`VectorizeIndex`, so nothing here names the binding type and a
 * test can pass a plain object.
 */
export interface RecallIndex {
  query(
    vector: number[],
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches>;
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
}

/** Embed a batch of texts. Output dimension must match the Vectorize index. */
export type Embed = (texts: string[]) => Promise<number[][]>;

/** A single archived message returned by a recall search. */
export interface RecallResult {
  score: number;
  role: string;
  /** The stored message snippet (truncated to `metadataTextMax`). */
  text: string;
  /** Display name of the human speaker, when the message carried a `<turn>` wrapper. */
  author?: string;
  /** Speaker's platform user id, when present. */
  authorId?: string;
  /** Channel the turn came from, when present. */
  channel?: string;
  /** ISO-8601 instant of the turn, when present. */
  at?: string;
}

/**
 * Build the Vectorize vectors for a batch of archived messages. Pure:
 * `embeddings` are supplied 1:1 with `messages` (both already filtered to
 * non-empty text). The vector `id` is the message's own id, so re-archiving on a
 * compaction retry is an idempotent upsert; `<turn>` provenance is lifted into
 * metadata when present.
 */
export function toRecallVectors(
  messages: SessionMessage[],
  namespace: string,
  embeddings: number[][],
  metadataTextMax: number = DEFAULT_METADATA_TEXT_MAX
): VectorizeVector[] {
  return messages.map((m, i) => {
    const text = sessionText(m);
    const metadata: Record<string, VectorizeVectorMetadata> = {
      role: m.role,
      text: text.slice(0, metadataTextMax)
    };
    const turn = parseTurn(text);
    if (turn) {
      metadata.author = turn.from;
      metadata.authorId = turn.id;
      metadata.channel = turn.channel;
      metadata.at = turn.at;
    }
    return { id: m.id, namespace, values: embeddings[i], metadata };
  });
}

/**
 * Archive a range of displaced messages into Vectorize. Embeds the non-empty
 * texts in one batch and upserts them under `namespace`. No-op on empty input.
 */
export async function archiveMessages(
  index: RecallIndex,
  namespace: string,
  messages: SessionMessage[],
  embed: Embed,
  metadataTextMax: number = DEFAULT_METADATA_TEXT_MAX
): Promise<void> {
  const withText = messages.filter((m) => sessionText(m).trim().length > 0);
  if (withText.length === 0) return;
  const embeddings = await embed(withText.map((m) => sessionText(m)));
  await index.upsert(
    toRecallVectors(withText, namespace, embeddings, metadataTextMax)
  );
}

/**
 * Semantically search this instance's archive. Embeds the query and returns the
 * top matches within `namespace`, mapping each vector's metadata to a compact
 * {@link RecallResult}. Constrained to `namespace` — never a caller-supplied one.
 */
export async function recallSearch(
  index: RecallIndex,
  namespace: string,
  query: string,
  embed: Embed,
  topK: number = DEFAULT_TOP_K
): Promise<RecallResult[]> {
  const [vector] = await embed([query]);
  if (!vector) return [];
  const { matches } = await index.query(vector, {
    namespace,
    topK,
    returnMetadata: "all"
  });
  return matches.map((match) => {
    const md = (match.metadata ?? {}) as Record<string, string>;
    const result: RecallResult = {
      score: match.score,
      role: md.role ?? "unknown",
      text: md.text ?? ""
    };
    if (md.author) result.author = md.author;
    if (md.authorId) result.authorId = md.authorId;
    if (md.channel) result.channel = md.channel;
    if (md.at) result.at = md.at;
    return result;
  });
}

export interface RecallConfig {
  /** The `AI` binding, for embeddings. Read lazily — see below. */
  ai: Ai;
  /** The `VECTORIZE` binding. Must be a 1024-dim, cosine index. */
  index: RecallIndex;
  /**
   * The archive namespace for this agent instance — **a thunk, deliberately.**
   *
   * It derives from the verified caller's identity, which is not known when
   * `plugins(env)` runs in `onStart`. The Durable Object is keyed 1:1 by that
   * caller, so the value is constant once known; a thunk is what lets the host
   * supply it late while both hooks here read the same one.
   */
  namespace: () => string;
  /**
   * AI Gateway id. Pass the host's single value here too, so embedding calls
   * stay correlated with chat calls in one gateway.
   */
  aiGatewayId?: string;
  /** Workers-AI embedding model. Must match the index's dimension. */
  embeddingModelId?: string;
  /** Matches returned by a search. Defaults to 5. */
  topK?: number;
  /** Stored-snippet cap, guarding Vectorize's ~10 KiB/vector. Defaults to 2000. */
  metadataTextMax?: number;
  /** Test override; skips the provider entirely. */
  embed?: Embed;
}

export function recall(config: RecallConfig): AgentPlugin {
  const {
    ai,
    index,
    namespace,
    aiGatewayId,
    embeddingModelId = DEFAULT_EMBEDDING_MODEL_ID,
    topK = DEFAULT_TOP_K,
    metadataTextMax = DEFAULT_METADATA_TEXT_MAX
  } = config;

  /**
   * Built on first use, never at module scope. Cloudflare evaluates module scope
   * during `wrangler deploy` to validate the new version, and bindings are not
   * populated at that point — constructing eagerly makes `createWorkersAI` throw
   * "you must provide either a binding or credentials".
   */
  let provider: ReturnType<typeof createWorkersAI> | undefined;
  const embed: Embed =
    config.embed ??
    (async (texts) => {
      if (texts.length === 0) return [];
      provider ??= createWorkersAI({
        binding: ai,
        ...(aiGatewayId ? { gateway: { id: aiGatewayId } } : {})
      });
      const { embeddings } = await embedMany({
        model: provider.embedding(embeddingModelId),
        values: texts,
        // Failures surface to the caller; archival is best-effort and the SDK's
        // backoff would only add latency in front of a compaction.
        maxRetries: 0
      });
      return embeddings;
    });

  return definePlugin({
    key: "recall",

    /**
     * Offered only once this caller's history has actually been compacted.
     *
     * Before the first compaction the archive is empty by construction, and a
     * tool whose only possible answer is "nothing here yet" costs the model a
     * call to discover that — plus the tokens to describe it, every round.
     */
    mainAgentTools: async (ctx): Promise<ToolSet> => {
      if ((await ctx.session.getCompactions()).length === 0) return {};
      return {
        recall: tool({
          description:
            "Search your own older conversation history with this caller that has scrolled out of the live context window (it was summarized during compaction). Use this to recall specific past details — quotes, decisions, facts — that you no longer have verbatim. Returns the most semantically similar archived messages with their author/channel/timestamp when known.",
          inputSchema: z.object({
            query: z
              .string()
              .describe("What to look for in the archived history"),
            limit: z
              .number()
              .int()
              .min(1)
              .max(20)
              .optional()
              .describe(`Max number of matches to return (default ${topK})`)
          }),
          // The index, the namespace and the embedder all come from the closure.
          // The model can only ever supply a query string and a count.
          execute: async ({ query, limit }) => ({
            results: await recallSearch(
              index,
              namespace(),
              query,
              embed,
              limit ?? topK
            )
          })
        })
      };
    },

    capability:
      "You can search your own older history with this caller — everything that has scrolled out of your live context window and been summarized. Use `recall` when you need a specific past detail verbatim (a quote, a decision, a number) rather than the gist you already have in your summary. It searches by meaning, so describe what you are looking for rather than guessing exact words.",

    /**
     * Compaction is about to fold these into a summary; embed and store them
     * first. Failures are the runtime's to swallow — it fans out with
     * `allSettled` and never lets a listener abort compaction, because history
     * must still shorten when a side store is briefly unavailable.
     */
    onMessagesDisplaced: (messages) =>
      archiveMessages(index, namespace(), messages, embed, metadataTextMax),

    requires: { bindings: ["VECTORIZE"] }
  });
}
