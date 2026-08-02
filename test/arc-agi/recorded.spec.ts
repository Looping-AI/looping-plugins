/**
 * Integration coverage for the arc tools against the **real** ARC-AGI-3 API,
 * recorded once and replayed on CI (VCR pattern via undici SnapshotAgent — see
 * test/helpers/vcr.ts). `setupRecording()` gives each test its own cassette,
 * auto-named from the file + describe + test names (test/helpers/vcr-spec.ts),
 * stored under test/snapshots/.
 *
 * Unlike tools.spec.ts, this spec does NOT stub `fetch`: the tools' real global
 * fetch flows workerd → Miniflare → the VCR agent, which records real responses
 * (`npm run test:record`, needs a real `ARC_API_KEY` in `.env.test` — see
 * .env.test.example; add `-- -t "<name>"` to record one test) and replays them
 * from the committed cassette otherwise. Assertions are on response *shape*, not
 * exact values, so re-recording a different game doesn't churn them.
 *
 * A missing cassette **fails** the test with a "record it" message (never skips),
 * so an unrecorded spec is visible in CI.
 *
 * This drives the whole flow in the order it really happens: the main agent
 * lists games, the recipe leases a card, a subagent plays on it, and the score
 * is read back **while the card is still open**. That last step is the one
 * assumption the whole design rests on — nothing closes a card any more — so it
 * is pinned here against the live API rather than a stub.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { buildArcGameTools } from "../../src/arc-agi/tools.js";
import { buildArcGamesTools } from "../../src/arc-agi/game-tools.js";
import {
  gameScoreReport,
  resolvePlay,
  resolveScorecard
} from "../../src/arc-agi/scorecard.js";
import { makeArcClient } from "../../src/arc-agi/client.js";
import { parseGrid } from "../../src/arc-agi/analysis.js";
import type { ArcSession } from "../../src/arc-agi/types.js";
import { ctx, callTool, memStore } from "./helpers.js";
import { setupRecording } from "@loopingai/core/testing";

setupRecording();

/**
 * The recording key, from `.dev.vars`.
 *
 * Read through a cast rather than off a typed `Env`, because this package
 * deliberately does not generate one: a published plugin must never name a
 * consumer's ambient bindings, so `wrangler.jsonc` here exists only to give the
 * test pool something to bind. Under playback the value is irrelevant — the key
 * header is excluded from the cassette — so an absent secret still replays.
 */
const ARC_API_KEY =
  (env as unknown as { ARC_API_KEY?: string }).ARC_API_KEY ?? "replay-only";

/**
 * The game to exercise. Its prefix must match a game in the ARC catalog at
 * record time; change it to a currently-available game when re-recording.
 */
const RECORD_GAME = "r11l";

/** Every game id in a rendered `- <id> (Title) [tags]` listing. */
function listedIds(listing: string): string[] {
  return listing
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.trim().split(" ")[1]);
}

/** Pull the exact game id out of a rendered listing. */
function firstIdMatching(listing: string, prefix: string): string {
  const id = listedIds(listing).find((g) => g.startsWith(prefix));
  if (!id) throw new Error(`no game matching ${prefix} in:\n${listing}`);
  return id;
}

/** Any other game, to put a second environment on the same card. */
function secondIdOtherThan(listing: string, taken: string): string {
  const id = listedIds(listing).find((g) => g !== taken);
  if (!id) throw new Error(`only one game listed in:\n${listing}`);
  return id;
}

describe("arc (recorded real API)", () => {
  // Real network round-trips (plus the client's own 429 backoff, up to ~8s per
  // retried request) comfortably blow past Vitest's 5s default when actually
  // hitting the live API to record — only matters for `npm run test:record`;
  // playback replays the cassette in milliseconds.
  it(
    "leases a card, plays a real game on it, and reads the score while it is open",
    { timeout: 60_000 },
    async () => {
      const store = memStore();
      const client = makeArcClient(ARC_API_KEY);
      const deps = { store, client };

      // 1. The main agent finds the exact game id — its whole ARC surface.
      const listing = await callTool(
        buildArcGamesTools({ client }).arc_list_games,
        {}
      );
      const gameId = firstIdMatching(listing, RECORD_GAME);

      // 2. The recipe leases a card. Nothing chose it: with an empty store there
      //    is no live card, so this opens one.
      const leased = await resolveScorecard(deps);
      expect(leased.cardId).toBeTruthy();
      expect(store.get(leased.cardId)).not.toBeNull();

      // 3. The parent opens the play — the one RESET in the system — and records
      //    the guid on the card. Resolving the same game again returns that guid
      //    against the real API, with no second RESET and so no second run.
      const opened = await resolvePlay(deps, gameId);
      expect(opened.cardId).toBe(leased.cardId);
      expect(opened.guid).toBeTruthy();
      expect(opened.frame).toBeDefined();
      expect(store.get(leased.cardId)?.guids[gameId]).toBe(opened.guid);

      const rejoined = await resolvePlay(deps, gameId);
      expect(rejoined.guid).toBe(opened.guid);
      expect(rejoined.frame).toBeUndefined();

      // 4. The subagent plays: the game arrives as its Subtask's param, the card,
      //    guid and the session they are pinned to as the runtime the parent
      //    resolved. Without that jar the ARC API cannot see the card at all.
      const { ctx: c } = ctx(ARC_API_KEY, {
        params: { game_id: gameId },
        runtime: {
          cardId: opened.cardId,
          cookies: opened.cookies,
          guid: opened.guid,
          frame: opened.frame
        }
      });
      const play = buildArcGameTools(ARC_API_KEY, c);
      // The subagent joins the play; it has no way to open one.
      const started = await callTool(play.tools.arc_inspect, {
        view: "shapes"
      });
      expect(started).toContain("Playing");

      const session =
        await c.workspace.readJson<ArcSession>("arc/session.json");
      expect(session).not.toBeNull();
      expect(session?.cardId).toBe(leased.cardId);
      expect(session?.guid).toBeTruthy();
      expect(session?.availableActions.length).toBeGreaterThan(0);
      expect(typeof session?.state).toBe("string");

      // The board is stored as hex rows; parsing it back must yield the real
      // ARC frame's 64×64 grid of color indices.
      expect(typeof session?.lastGridHex).toBe("string");
      const grid = parseGrid(session?.lastGridHex ?? "");
      expect(grid).toHaveLength(64);
      expect(grid[0]).toHaveLength(64);
      expect(
        grid.flat().every((c) => Number.isInteger(c) && c >= 0 && c < 16)
      ).toBe(true);

      // 5. A SECOND game onto the same card, driven straight through the client.
      //    Sharing a card is the normal case now, and it is what makes the
      //    card-wide/game-specific distinction below observable at all: this game
      //    spends actions, the one above spent none.
      const otherId = secondIdOtherThan(listing, gameId);
      const jar = store.get(leased.cardId)?.cookies ?? {};
      const { frame: otherFrame, cookies: otherJar } = await client.reset(
        { gameId: otherId, cardId: leased.cardId },
        jar
      );
      const move = otherFrame.available_actions.find((a) => a !== 6) ?? 6;
      await client.act(
        { action: move, gameId: otherId, guid: otherFrame.guid, x: 32, y: 32 },
        otherJar
      );

      // 6. The result, read off the card with no close anywhere in sight. This
      //    is the assumption the whole design rests on: a scorecard reports a
      //    game's result while it is still open.
      const report = await gameScoreReport(deps, leased.cardId, gameId);
      expect(report).not.toBeNull();
      expect(report).toContain(`Score for ${gameId}`);
      expect(report).toContain(leased.cardId);
      expect(report).toContain("play 1");

      const { summary } = await client.getScorecard(leased.cardId, jar);
      const mine = summary.environments.find((e) => e.id === gameId);
      const other = summary.environments.find((e) => e.id === otherId);
      expect(mine).toBeDefined();
      // Both games really are on the one card — otherwise the check below is
      // vacuous and would keep passing after a regression.
      expect(other).toBeDefined();
      expect(summary.total_actions).toBeGreaterThan(mine!.actions);

      // The report must quote this game's own actions, never the card's total.
      // Every top-level field here (`score`, `total_actions`, …) spans both
      // games; only `environments[]` is game-scoped.
      expect(report).toContain(`${mine!.actions} actions across`);
      expect(mine!.runs.length).toBeGreaterThan(0);
      expect(typeof mine!.score).toBe("number");
    }
  );
});
