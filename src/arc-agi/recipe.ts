import { z } from "zod";
import { DEFAULT_CORE_CONFIG } from "@loopingai/core";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@loopingai/core";
import { ARC_GAME_SOUL } from "./soul.js";
import { ARC_CAPABILITY, arcDelegationGuidance } from "./main-agent.js";

/** Semantic Subtask type the decomposer emits for a "play this game" request. */
export const ARC_GAME_TYPE = "arc-game";

/**
 * Recipe for playing an ARC-AGI-3 game. Runs on the repo's default model pair;
 * what distinguishes it is its tool family, its soul, its context discipline, and
 * a turn budget twice the baseline — a play is a long sequence of cheap decisions,
 * and 20 turns bought roughly ten game actions once inspection was paid for.
 *
 * It used to be "the long recipe", budgeted at 1,000 turns on the reasoning that
 * 25 turns per chunk made 40 durable chunks. That arithmetic assumed a turn under
 * ten seconds. A turn here is a reasoning model plus an ARC HTTP round trip, so
 * real runs took 70-100 chunks, blew the per-branch cap, and were *failed* after
 * hours of unattended play rather than being asked to report. The budget is now
 * time and turns, both enforced directly, and a play ends through the graceful
 * summary — a terminal report with the metrics footer.
 *
 * - `historyWindow` bounds context, and it is now the model's *only* memory: the
 *   workspace tools are gone (see below), so a plan that scrolls out of it is
 *   gone. Note it counts *assistant messages* — one per tool call, not one per
 *   game action — so a play spends it several times faster than the number
 *   suggests.
 * - `reportMetrics` appends the turns/model-calls/wall-clock footer the user
 *   asked to see.
 *
 * Tool family: `arc-game` alone (act/inspect against the ARC REST API, session
 * state kept in the workspace), code-validated by
 * `validateRecipe`/`buildRecipeTools`.
 *
 * It used to also carry `workspace`, on the theory that a small history window
 * needs a file store behind it. Two logged plays say otherwise: `ws_read` was
 * never called once, and the three `ws_write` calls between them were a
 * scratchpad for arithmetic — a use that costs a turn per note and now belongs in
 * `arc_act`'s `note` field, which costs none and stays in the model's own history.
 * The session file is unaffected: the family reaches the workspace through its
 * {@link file://../../agent/tools.ts ToolFamilyContext}, not through the tools the
 * model can see.
 */
/** Which models a play runs on, when the host wants something other than its own. */
export interface ArcRecipeModels {
  primaryModelId?: string;
  fallbackModelId?: string;
}

/**
 * Build the recipe, optionally on a model pair of the host's choosing.
 *
 * The defaults are core's, and naming them is a *preference*, not a demand:
 * `validateRecipe` substitutes the host's configured model for any id outside
 * its allowlist, so an agent running on different models gets its own and
 * nothing fails. Pass ids here only to deliberately run a play on something
 * other than the agent's chat model — a play is a long sequence of cheap spatial
 * decisions, which is not the same workload as conversation.
 */
export function arcGameRecipe(models: ArcRecipeModels = {}): ResolvedRecipe {
  return { ...ARC_GAME_RECIPE, ...stripUndefined(models) };
}

/** Drop absent keys so a spread cannot overwrite a default with `undefined`. */
function stripUndefined(models: ArcRecipeModels): ArcRecipeModels {
  return Object.fromEntries(
    Object.entries(models).filter(([, v]) => v !== undefined)
  );
}

export const ARC_GAME_RECIPE: ResolvedRecipe = {
  key: ARC_GAME_TYPE,
  version: 1,
  primaryModelId: DEFAULT_CORE_CONFIG.model.chatModelId,
  fallbackModelId: DEFAULT_CORE_CONFIG.model.fallbackChatModelId,
  soul: ARC_GAME_SOUL,
  toolFamilies: ["arc-game"],
  enabled: true,
  // Twice the baseline turns, and the largest number that keeps
  // `MAX_CHUNKS_PER_BRANCH` unreachable: a yielding chunk always advanced at least
  // one turn, so a run takes at most `maxTurns` chunks and the cap is 40. Asserted
  // in `test/agent/subtasks/subtask-types.spec.ts` — raising this past 39 is a
  // platform change, not a recipe one.
  //
  // `maxWallMs` deliberately stays at the 30-minute baseline. Measured turns run
  // ~15s but reach 165s, so time may well end a play before turn 39 does; both
  // ceilings end it the same way, through the graceful summary, so the cost of
  // guessing wrong here is a shorter play rather than lost work.
  limits: { maxTurns: 39 },
  // Counts assistant messages (tool calls), so an inspect + act cycle spends two
  // or three of these per game action; 12 left the model unable to see more than a
  // couple of moves back, which it answered by re-inspecting.
  //
  // Lowered from 32 because `elideToolOutputs` changed what a slot *costs*, not
  // how many there are: a turn that has aged past the detail window now carries
  // its reasoning and its `note` but not the board render that was nearly all of
  // its tokens. 32 was the compensation for losing the workspace tools, and the
  // thing it was compensating for — reach — is unaffected by the elision.
  historyWindow: 24,
  reportMetrics: true
};

/**
 * The arc-game type. Its one param is an id the model quotes back from a tool
 * result it already saw, so the contract is checkable before anything runs: a
 * play with no game cannot succeed, and refusing it here costs no model call.
 *
 * There is deliberately no `card_id`. Which scorecard a play runs on is not a
 * choice — the API auto-closes an idle card, so the live card is whichever one
 * was used recently — and the parent leases it per chunk (see
 * {@link file://./scorecard.ts}), handing it to the execution as runtime state.
 */
export const ARC_GAME_SPEC: SubtaskTypeSpec = {
  key: ARC_GAME_TYPE,
  description: "Play one ARC-AGI-3 game.",
  params: z.object({
    game_id: z.string().min(1).describe("An exact game id from arc_list_games")
  }),
  paramsHelp: "requires param `game_id` (an exact id from `arc_list_games`)",
  // Everything the main agent is told about ARC is declared here, never written
  // inside a runtime — see {@link file://./main-agent.ts}. Both blocks live on
  // the *type* rather than on the plugin, because a plugin that declares a
  // subtask type has two places it could put a capability block and they are
  // rendered by different call sites: setting both makes the main agent read the
  // same advice twice per round, which is the exact drift these fields ended.
  capability: ARC_CAPABILITY,
  delegationGuidance: arcDelegationGuidance,
  recipe: ARC_GAME_RECIPE
};

/** {@link ARC_GAME_SPEC} on a caller-chosen model pair. See {@link arcGameRecipe}. */
export function arcGameSpec(models: ArcRecipeModels = {}): SubtaskTypeSpec {
  return { ...ARC_GAME_SPEC, recipe: arcGameRecipe(models) };
}
