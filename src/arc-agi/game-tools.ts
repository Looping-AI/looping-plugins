import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ArcClient } from "./client.js";

/**
 * The **main agent's** ARC tool: the game catalogue, and nothing else.
 *
 * It used to also own the scorecard lifecycle — open a card, name it in each
 * play's params, close it for the score. That modelled a lifecycle the API
 * already manages (it auto-closes an idle card), and made every play depend on
 * the model getting the bookkeeping right. The card is now leased by the recipe
 * (see {@link file://./scorecard.ts}) and never named here, so the only thing the
 * main agent still needs from ARC is the exact game id to delegate a play with.
 *
 * Handlers are exported separately from the `tool()` wiring so they unit-test
 * without an LLM, and the client is closed over so it is never model input.
 */

export interface ArcGamesDeps {
  client: ArcClient;
}

/** One line per game: id, title, and how it is played. */
export function renderGames(
  games: { game_id: string; title?: string; tags?: string[] }[]
): string {
  if (games.length === 0) return "(the API listed no games)";
  return games
    .map((g) => {
      const title = g.title ? ` (${g.title})` : "";
      const tags = g.tags?.length ? ` [${g.tags.join(", ")}]` : "";
      return `- ${g.game_id}${title}${tags}`;
    })
    .join("\n");
}

export function buildArcGamesTools(deps: ArcGamesDeps): ToolSet {
  return {
    arc_list_games: tool({
      description:
        "List the ARC-AGI-3 games available to play, with their exact game ids and tags describing how each is played. Use this to find the full game id before delegating a play.",
      inputSchema: z.object({}),
      execute: async () => {
        const { games } = await deps.client.listGames({});
        return renderGames(games);
      }
    })
  };
}
