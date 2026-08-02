import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import type { RecipeExecutionResult } from "@loopingai/core/subtasks";
import { makeArcClient } from "./client.js";
import { buildArcGamesTools } from "./game-tools.js";
import { arcGameSpec, ARC_GAME_TYPE, type ArcRecipeModels } from "./recipe.js";
import {
  gameScoreReport,
  resolvePlay,
  resolveScorecard,
  type ArcScorecardDeps,
  type ResolvedPlay,
  type ResolvedScorecard,
  type ScorecardStore
} from "./scorecard.js";
import { arcScorecardStore, makeScorecardStore } from "./store.js";
import { ARC_GAME_FAMILY, buildArcGameTools } from "./tools.js";
import type { ArcRuntime } from "./types.js";

/**
 * `@loopingai/plugins/arc-agi` — play ARC-AGI-3 games.
 *
 * The stress test for the whole plugin contract, and the reason three of its
 * hooks exist. In the predecessor these were four leaks in the agent's Durable
 * Object — `resolveRuntime`, `arcScorecardDeps`, `leaseScorecard`/`leasePlay`,
 * and `enrichResult` — each a piece of ARC-specific policy living in code that
 * had no other reason to know what a scorecard was. Inverted, they are this
 * file.
 *
 * What the split makes visible: the *only* thing the agent still knows is that
 * it installed a plugin. Nothing in a loop, a workflow, or a DO names a card, a
 * guid, or a game.
 */

/** Everything this plugin needs from its host. */
export interface ArcAgiConfig extends ArcRecipeModels {
  /** `ARC_API_KEY` — a secret the host must set. */
  apiKey: string;
  /**
   * The Durable Object's storage, for the `arc_scorecards` ledger.
   *
   * `DurableObjectStorage` rather than the `SqlStorage` that `ensureTables`
   * receives, because the query side builds a drizzle handle over it. The host
   * has it as `this.ctx.storage`.
   */
  storage: DurableObjectStorage;
  /**
   * Test override: an in-memory {@link ScorecardStore}. Supplying this skips the
   * table entirely, which is what lets the policy specs run with no SQLite.
   */
  store?: ScorecardStore;
}

export function arcAgi(config: ArcAgiConfig): AgentPlugin<ArcRuntime> {
  const { apiKey, storage, primaryModelId, fallbackModelId } = config;

  // Built once per DO instance, like the plugin itself. `makeScorecardStore`
  // only constructs a drizzle handle — it issues no query until something asks —
  // so this is safe before `AgentDB` has run the store's DDL.
  let store: ScorecardStore | undefined = config.store;
  const deps = (): ArcScorecardDeps => ({
    store: (store ??= makeScorecardStore(storage)),
    client: makeArcClient(apiKey)
  });

  /**
   * In-flight leases, collapsed so concurrent branches share one call.
   *
   * These were DO instance fields in the predecessor, and the plugin is built
   * per DO instance, so this closure is the same scope — but it is now the scope
   * of the thing that *cares*, rather than of the agent that merely hosted it.
   *
   * Load-bearing, not an optimization. All of a round's ready Subtasks execute
   * concurrently, and opening a card is a `fetch`, which opens the DO's input
   * gate — so without this, two branches starting together each find no live
   * card and each open one. It matters more for a play: RESET is also a `fetch`,
   * so two Subtasks for one game would each find no recorded guid and each open
   * a play. The store settles that race anyway (first guid written wins), but
   * only after a wasted run is already recorded on the card, so collapsing is
   * what keeps the card's history honest rather than merely cheap.
   */
  let leasingCard: Promise<ResolvedScorecard> | undefined;
  const leasingPlays = new Map<string, Promise<ResolvedPlay>>();

  const leaseScorecard = (): Promise<ResolvedScorecard> =>
    (leasingCard ??= resolveScorecard(deps()).finally(() => {
      leasingCard = undefined;
    }));

  const leasePlay = (gameId: string): Promise<ResolvedPlay> => {
    const inFlight = leasingPlays.get(gameId);
    if (inFlight) return inFlight;
    // Keyed per game: different games legitimately open different plays on the
    // same card.
    const pending = resolvePlay(deps(), gameId).finally(() => {
      leasingPlays.delete(gameId);
    });
    leasingPlays.set(gameId, pending);
    return pending;
  };

  return definePlugin<ArcRuntime>({
    key: "arc-agi",

    subtaskType: arcGameSpec({ primaryModelId, fallbackModelId }),

    toolFamilies: {
      [ARC_GAME_FAMILY]: (ctx) => buildArcGameTools(apiKey, ctx)
    },

    /**
     * The **game catalogue only**. Playing is a subagent's job, and the card it
     * plays on is leased below and never reaches a model — so the only thing the
     * main agent needs from ARC is the exact id to delegate a play with.
     */
    mainAgentTools: () => buildArcGamesTools({ client: makeArcClient(apiKey) }),

    // No `capability` here: it is on the subtask type, with the delegation
    // guidance it has to agree with. See `arcGameSpec`.

    /**
     * Resolve the session state an execution needs and no model can supply: the
     * card, and the play on it.
     *
     * Neither is a decision. Which card is live is a fact about the clock, and a
     * guid is mintable only by RESET — a call a subagent must never make, since a
     * second RESET is a second run on the card that discards whatever the first
     * reached. Both are settled here and handed down.
     *
     * Called once per **chunk**, not once per run, and the repetition is
     * load-bearing twice over: each call restarts the card's reuse clock (which
     * keeps a long play's card alive), and each call re-resolves the same guid
     * from the store rather than opening anything.
     */
    async resolveRuntime(ctx) {
      const gameId = ctx.params.game_id;
      // A Subtask whose params never validated still reaches here. Resolve the
      // card alone and let the recipe's own validation report the missing game,
      // rather than RESETting on it and turning a clean failure into an API error.
      if (!gameId) return leaseScorecard();
      return leasePlay(gameId);
    },

    /**
     * Append what only the parent can know to a completed execution's report:
     * the score.
     *
     * Nothing closes a scorecard any more, so the score is *read* from the card
     * once the play that earned it is done — which only this side can do, since
     * it alone knows the leased card and holds the jar pinned to it. The score
     * lands as an extra text part, and result parts are joined on delivery, so it
     * reaches the user and any dependent Subtask with no other change.
     *
     * Never fails the execution: a play that succeeded is not retroactively
     * broken by a rate-limited score read, so `gameScoreReport` swallows its own
     * errors and a null leaves the report as the child wrote it. Safe to repeat
     * on a Workflow step replay — the read is a GET.
     */
    async enrichResult(ctx, result): Promise<RecipeExecutionResult> {
      const gameId = ctx.request.params.game_id;
      const cardId = ctx.runtime.cardId;
      if (result.status !== "completed" || !cardId || !gameId) return result;

      const score = await gameScoreReport(deps(), cardId, gameId);
      if (!score) return result;
      return {
        ...result,
        resultParts: [...result.resultParts, { kind: "text", text: score }]
      };
    },

    // No `onAbort`. There is deliberately nothing to release: the ARC API
    // auto-closes an idle card, so an abandoned play needs no cleanup at all.
    // Declaring an empty hook would imply otherwise.

    store: arcScorecardStore,

    requires: { secrets: ["ARC_API_KEY"] }
  });
}

export { ARC_GAME_FAMILY, ARC_GAME_TYPE };
export type { ArcRuntime, ScorecardStore };
export { arcScorecardStore, makeScorecardStore } from "./store.js";
export { arcGameRecipe, arcGameSpec } from "./recipe.js";
