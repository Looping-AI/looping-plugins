import { describe, it, expect } from "vitest";
import {
  createAgentRuntime,
  validateRecipe,
  DEFAULT_CORE_CONFIG,
  MAX_CHUNKS_PER_BRANCH
} from "@loopingai/core";
import { ARC_GAME_RECIPE, ARC_GAME_SPEC, ARC_GAME_TYPE } from "./recipe.js";
import { arcAgi } from "./index.js";

/**
 * The recipe used to be reached through a module-level registry keyed by type.
 * It now arrives on the plugin's `subtaskType`, so these specs resolve it the
 * way a host does — through a runtime built from the installed plugins — which
 * exercises the composition rather than asserting on a constant beside it.
 */

const SUBAGENT_LIMITS = DEFAULT_CORE_CONFIG.subagentLimits;

const runtime = () =>
  createAgentRuntime({
    plugins: [
      arcAgi({
        apiKey: "k",
        storage: {} as DurableObjectStorage,
        store: {} as never
      })
    ]
  });

describe("ARC_GAME_RECIPE", () => {
  it("is the enabled arc-game recipe, playing and nothing else", () => {
    const rt = runtime();
    const recipe = rt.types.resolveRecipe(ARC_GAME_TYPE);

    expect(recipe.key).toBe(ARC_GAME_TYPE);
    expect(recipe.enabled).toBe(true);
    expect(recipe.reportMetrics).toBe(true);
    // It used to carry `workspace` too, so the model could keep notes in files.
    // Across two logged plays it wrote three and read none, at a turn apiece; the
    // `note` field of `arc_act` carries a plan for free instead. The session file
    // is untouched by this — the family reaches the workspace through its context,
    // not through tools a model can call.
    expect(recipe.toolFamilies).toEqual(["arc-game"]);
  });

  it("names a tool family the plugin actually registers", () => {
    // `validateRecipe` silently drops a family no installed plugin provides, so a
    // typo here would produce a subagent with no tools rather than an error.
    const rt = runtime();
    expect(validateRecipe(ARC_GAME_RECIPE, rt.policy).toolFamilies).toEqual([
      "arc-game"
    ]);
  });

  it("buys more turns than the baseline, and stops short of the chunk cap", () => {
    // It used to be "the long recipe" at 1,000 turns, sliced 25 to a chunk on the
    // theory that made 40 durable chunks. Real turns here — a reasoning model plus
    // an ARC HTTP round trip — are far slower than that arithmetic assumed, so runs
    // took 70-100 chunks, blew the per-branch cap, and were killed after hours
    // instead of reporting. The correction was not to leave a play on the baseline:
    // 20 turns bought about ten game actions once inspection was paid for. It is
    // the *shape* of the old number that was wrong, and 39 is the most a recipe can
    // ask for while a yielding chunk still costs a turn.
    expect(ARC_GAME_RECIPE.limits.maxTurns).toBeGreaterThan(
      SUBAGENT_LIMITS.maxTurns
    );
    expect(ARC_GAME_RECIPE.limits.maxTurns).toBeLessThan(MAX_CHUNKS_PER_BRANCH);
    // Time is not overridden: turns are what a play is short of, and the two
    // ceilings end a run identically, so the baseline stands until a run is
    // observed ending on the clock.
    expect(ARC_GAME_RECIPE.limits.maxWallMs).toBeUndefined();
    expect(
      validateRecipe(ARC_GAME_RECIPE, runtime().policy).limits.maxWallMs
    ).toBe(SUBAGENT_LIMITS.maxWallMs);
  });

  it("keeps a context window smaller than its budget, since it is now the only memory", () => {
    // The one thing it genuinely tunes as a property of the domain. It counts
    // assistant messages, so a play spends it faster than the number looks — and
    // with the workspace tools gone, a plan that scrolls out of it is gone.
    expect(ARC_GAME_RECIPE.historyWindow).toBeLessThan(
      validateRecipe(ARC_GAME_RECIPE, runtime().policy).limits.maxTurns
    );
    // The floor a documented regression put here: at 12 the model could not see a
    // couple of moves back and spent turns re-inspecting to compensate. It holds
    // at 24 rather than the 32 it briefly needed because `elideToolOutputs` made a
    // window slot cheap — an aged-out turn keeps its reasoning and its `note` and
    // loses only the board render. Reach is what this number buys, and the
    // elision does not touch reach.
    expect(ARC_GAME_RECIPE.historyWindow).toBeGreaterThanOrEqual(24);
  });

  it("states a model preference the host's config is free to override", () => {
    // A plugin cannot know what models its host runs on. `validateRecipe`
    // substitutes the configured default for any id outside the allowlist, so
    // naming one here is a preference rather than a demand — and an agent on a
    // different pair gets its own models instead of a validation error.
    const rt = createAgentRuntime({
      config: { model: { chatModelId: "@cf/some/other-model" } },
      plugins: [
        arcAgi({
          apiKey: "k",
          storage: {} as DurableObjectStorage,
          store: {} as never
        })
      ]
    });

    expect(validateRecipe(ARC_GAME_RECIPE, rt.policy).primaryModelId).toBe(
      "@cf/some/other-model"
    );
  });

  it("runs a play on a model pair the host names explicitly", () => {
    // The other direction: a play is a long sequence of cheap spatial decisions,
    // which is a different workload from conversation, so a host may deliberately
    // want it somewhere other than its chat model.
    const rt = createAgentRuntime({
      config: {
        model: {
          chatModelId: "@cf/chat/model",
          fallbackChatModelId: "@cf/reasoning/model"
        }
      },
      plugins: [
        arcAgi({
          apiKey: "k",
          storage: {} as DurableObjectStorage,
          store: {} as never,
          primaryModelId: "@cf/reasoning/model"
        })
      ]
    });

    const recipe = rt.types.resolveRecipe(ARC_GAME_TYPE);
    expect(validateRecipe(recipe, rt.policy).primaryModelId).toBe(
      "@cf/reasoning/model"
    );
  });
});

describe("what ARC_GAME_SPEC tells the main agent", () => {
  const guidance = ARC_GAME_SPEC.delegationGuidance!({
    delegateTool: "delegate",
    finalReplyTool: "final_reply"
  });

  it("owns both halves of it, so neither can drift from the other", () => {
    // Both used to be hand-written in `agent/` — the capability in the soul, the
    // guidance in the round contract — and they ended up disagreeing: one said to
    // delegate a subtask per game, the other said exactly one subtask and nothing
    // else. They are declared together now, and they agree.
    expect(ARC_GAME_SPEC.capability).toContain(
      "one `arc-game` subtask per game"
    );
    expect(guidance).toContain("per game");
    expect(guidance).not.toContain("exactly one");
  });

  it("declares its capability on the type, never also on the plugin", () => {
    // The two are rendered by different call sites (`runtime.renderCapabilities`
    // and `runtime.types.renderCapabilities`), so declaring both would make the
    // main agent read the same advice twice per round — the exact drift above.
    const plugin = arcAgi({
      apiKey: "k",
      storage: {} as DurableObjectStorage,
      store: {} as never
    });
    expect(plugin.capability).toBeUndefined();
    expect(plugin.subtaskType!.capability).toBe(ARC_GAME_SPEC.capability);

    const rt = runtime();
    expect(rt.renderCapabilities()).toBe("");
    expect(rt.types.renderCapabilities()).toContain("arc_list_games");
  });

  it("names the param that starts a play and the tool that supplies it", () => {
    for (const text of [ARC_GAME_SPEC.capability!, guidance]) {
      expect(text).toContain("game_id");
      expect(text).toContain("arc_list_games");
      // The card is leased per chunk by the recipe; naming one here would invite
      // the model to pass a param the type does not declare.
      expect(text).not.toContain("card_id");
    }
  });

  it("leaves the params schema to the delegate tool description", () => {
    expect(guidance).not.toContain(ARC_GAME_SPEC.paramsHelp);
  });
});
