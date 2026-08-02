/**
 * The main agent's one remaining ARC tool (src/recipes/arc-game/game-tools.ts):
 * the game catalogue it needs to name a game in a delegated play.
 *
 * The scorecard tools that used to live beside it are gone — the card is leased
 * by the recipe now (see scorecard.spec.ts), not chosen by a model.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildArcGamesTools, renderGames } from "./game-tools.js";
import { makeArcClient } from "./client.js";
import { callTool } from "../../test/arc-agi/helpers.js";

afterEach(() => vi.unstubAllGlobals());

function stubGames(games: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(games, { headers: { "content-type": "application/json" } })
    )
  );
}

describe("arc_list_games", () => {
  it("lists games with their exact ids and tags", async () => {
    stubGames([
      { game_id: "ls20-abc", title: "LS20", tags: ["click"] },
      { game_id: "px7-def" }
    ]);
    const { arc_list_games } = buildArcGamesTools({
      client: makeArcClient("test-key")
    });

    const out = await callTool(arc_list_games, {});
    expect(out).toContain("- ls20-abc (LS20) [click]");
    expect(out).toContain("- px7-def");
  });

  it("says so rather than rendering an empty list", () => {
    expect(renderGames([])).toBe("(the API listed no games)");
  });
});
