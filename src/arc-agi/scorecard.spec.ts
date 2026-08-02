/**
 * The arc-game recipe's scorecard policy (src/recipes/arc-game/scorecard.ts):
 * which card a play leases, and what that play scored.
 *
 * The store is the in-memory fake from ./helpers, so these exercise the policy's
 * own arithmetic — the reuse window and the clock — without a Durable Object.
 * Coverage of the real API response shapes lives in recorded.spec.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  gameScoreReport,
  renderGameScore,
  resolvePlay,
  resolveScorecard,
  SCORECARD_REUSE_MS,
  type ArcScorecardDeps
} from "./scorecard.js";
import { makeArcClient } from "./client.js";
import type { Scorecard, ScorecardSummary } from "./types.js";
import { memStore } from "../../test/arc-agi/helpers.js";

afterEach(() => vi.unstubAllGlobals());

const MINUTE = 60_000;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** Route requests by path to canned responses; records which paths were hit. */
function stubFetch(routes: Record<string, () => unknown>) {
  const hits: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      hits.push(path);
      const handler = routes[path];
      return handler
        ? jsonResponse(handler())
        : new Response("no route", { status: 404 });
    })
  );
  return hits;
}

/**
 * The real full-card shape, as recorded from the live API. `environments` holds
 * one entry per game on the card; the top-level totals cover the whole card,
 * which is exactly why the renderer must not read them.
 */
const SUMMARY = (over: Partial<ScorecardSummary> = {}): ScorecardSummary => ({
  card_id: "card-1",
  score: 3,
  total_actions: 41,
  total_environments: 1,
  total_environments_completed: 0,
  total_levels: 6,
  total_levels_completed: 2,
  environments: [
    {
      id: "ls20-abc",
      actions: 41,
      completed: false,
      level_count: 6,
      levels_completed: 2,
      resets: 1,
      score: 3,
      runs: [
        {
          guid: "gid-1",
          actions: 41,
          completed: false,
          levels_completed: 2,
          resets: 0,
          score: 3,
          state: "GAME_OVER"
        }
      ]
    }
  ],
  ...over
});

/** A second game's entry on the same card — the shared-card case. */
const OTHER_GAME = {
  id: "px7-def",
  actions: 999,
  completed: true,
  level_count: 9,
  levels_completed: 9,
  resets: 0,
  score: 99,
  runs: [
    {
      guid: "gid-x",
      actions: 999,
      completed: true,
      levels_completed: 9,
      resets: 0,
      score: 99,
      state: "WIN" as const
    }
  ]
};

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  cardId: "card-1",
  cookies: { AWSALB: "x" },
  guids: {},
  openedAt: Date.now(),
  lastUsedAt: Date.now(),
  ...over
});

/** A RESET response body; `guid` is the handle the whole policy turns on. */
const FRAME = (over: Record<string, unknown> = {}) => ({
  game_id: "ls20-abc",
  guid: "gid-new",
  frame: [[[0, 1]]],
  state: "NOT_FINISHED",
  levels_completed: 0,
  win_levels: 5,
  available_actions: [1, 2],
  ...over
});

function deps(seed: Scorecard[] = []): ArcScorecardDeps & {
  store: ReturnType<typeof memStore>;
} {
  return { store: memStore(seed), client: makeArcClient("test-key") };
}

describe("resolveScorecard", () => {
  it("opens a card when there is none, and records it with its jar", async () => {
    const hits = stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-new" })
    });
    const d = deps();

    const resolved = await resolveScorecard(d);

    expect(resolved.cardId).toBe("card-new");
    expect(hits).toEqual(["/api/scorecard/open"]);
    expect(d.store.get("card-new")).not.toBeNull();
  });

  it("reuses a card inside the window instead of opening another", async () => {
    const now = Date.now();
    const hits = stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-new" })
    });
    const d = deps([card({ cardId: "card-live", lastUsedAt: now - MINUTE })]);

    const resolved = await resolveScorecard(d, now);

    expect(resolved.cardId).toBe("card-live");
    // The jar travels with the card: the API pins the card to the session that
    // opened it, so reusing an id without its cookies would reach nothing.
    expect(resolved.cookies).toEqual({ AWSALB: "x" });
    expect(hits).toEqual([]);
  });

  it("opens a fresh card once the last one falls outside the window", async () => {
    const now = Date.now();
    stubFetch({ "/api/scorecard/open": () => ({ card_id: "card-new" }) });
    const d = deps([
      card({ cardId: "card-stale", lastUsedAt: now - SCORECARD_REUSE_MS - 1 })
    ]);

    const resolved = await resolveScorecard(d, now);
    expect(resolved.cardId).toBe("card-new");
  });

  it("treats a card at exactly the window edge as still live", async () => {
    // The boundary decides whether a play about to start joins the card its
    // siblings are on, so pin it rather than leaving it to rounding.
    const now = Date.now();
    const hits = stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-new" })
    });
    const d = deps([
      card({ cardId: "card-edge", lastUsedAt: now - SCORECARD_REUSE_MS })
    ]);

    const resolved = await resolveScorecard(d, now);
    expect(resolved.cardId).toBe("card-edge");
    expect(hits).toEqual([]);
  });

  it("restarts the clock on reuse, which is what keeps a long play alive", async () => {
    const now = Date.now();
    const store = memStore(
      [card({ cardId: "card-live", lastUsedAt: now - 13 * MINUTE })],
      () => now
    );
    const d = { store, client: makeArcClient("test-key") };
    stubFetch({});

    await resolveScorecard(d, now);

    expect(store.get("card-live")?.lastUsedAt).toBe(now);
  });

  it("shares one card between two plays resolving back to back", async () => {
    // Two concurrent arc-game subtasks are the normal case; both must land on
    // the same card so their runs aggregate together.
    const hits = stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-new" })
    });
    const d = deps();

    const first = await resolveScorecard(d);
    const second = await resolveScorecard(d);

    expect(second.cardId).toBe(first.cardId);
    expect(hits).toEqual(["/api/scorecard/open"]);
  });
});

/**
 * The one RESET in the system, and the rule that keeps it one: a guid recorded
 * per (card, game) is what stops a retry, a fresh workspace, or a second chunk
 * from opening a play the first one already opened. Every extra RESET would be a
 * separately-scored run on the card that discards what the first play reached.
 */
describe("resolvePlay", () => {
  it("RESETs once and records the guid against the card", async () => {
    const hits = stubFetch({ "/api/cmd/RESET": () => FRAME() });
    const d = deps([card()]);

    const play = await resolvePlay(d, "ls20-abc");
    expect(play.cardId).toBe("card-1");
    expect(play.guid).toBe("gid-new");
    // The opening frame goes only to whoever opened the play.
    expect(play.frame).toBeDefined();
    expect(hits.filter((h) => h === "/api/cmd/RESET")).toHaveLength(1);
    expect(d.store.get("card-1")?.guids["ls20-abc"]).toBe("gid-new");
  });

  it("reuses the recorded guid instead of opening a second play", async () => {
    const hits = stubFetch({ "/api/cmd/RESET": () => FRAME() });
    const d = deps([card({ guids: { "ls20-abc": "gid-existing" } })]);

    const play = await resolvePlay(d, "ls20-abc");
    expect(play.guid).toBe("gid-existing");
    expect(hits).not.toContain("/api/cmd/RESET");
    // Nothing to hand over: the board belongs to a play already in progress.
    expect(play.frame).toBeUndefined();
  });

  it("resolves the same play on every later chunk", async () => {
    stubFetch({ "/api/cmd/RESET": () => FRAME() });
    const d = deps([card()]);

    const first = await resolvePlay(d, "ls20-abc");
    const second = await resolvePlay(d, "ls20-abc");
    const third = await resolvePlay(d, "ls20-abc");
    expect([second.guid, third.guid]).toEqual([first.guid, first.guid]);
    expect([second.frame, third.frame]).toEqual([undefined, undefined]);
  });

  it("opens a separate play per game on one shared card", async () => {
    let n = 0;
    stubFetch({ "/api/cmd/RESET": () => FRAME({ guid: `gid-${++n}` }) });
    const d = deps([card()]);

    const a = await resolvePlay(d, "ls20-abc");
    const b = await resolvePlay(d, "px7-def");
    // Sharing a card is the normal case; sharing a play would be a bug.
    expect(a.guid).not.toBe(b.guid);
    expect(d.store.get("card-1")?.guids).toEqual({
      "ls20-abc": a.guid,
      "px7-def": b.guid
    });
  });

  it("hands every racing caller the guid that won, and no frame to the loser", async () => {
    let n = 0;
    stubFetch({ "/api/cmd/RESET": () => FRAME({ guid: `gid-${++n}` }) });
    const d = deps([card()]);

    // Both find no recorded guid and both RESET. The store keeps the first, and
    // the loser must not hand out a play nobody else will ever join.
    const [first, second] = await Promise.all([
      resolvePlay(d, "ls20-abc"),
      resolvePlay(d, "ls20-abc")
    ]);
    expect(second.guid).toBe(first.guid);
    const winner = d.store.get("card-1")?.guids["ls20-abc"];
    expect(winner).toBe(first.guid);
    const loser = [first, second].find((p) => p.frame === undefined);
    expect(loser).toBeDefined();
  });

  it("opens the card first when there is none, then the play on it", async () => {
    const hits = stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-fresh" }),
      "/api/cmd/RESET": () => FRAME()
    });
    const d = deps();

    const play = await resolvePlay(d, "ls20-abc");
    expect(play.cardId).toBe("card-fresh");
    expect(hits).toEqual(["/api/scorecard/open", "/api/cmd/RESET"]);
    expect(d.store.get("card-fresh")?.guids["ls20-abc"]).toBe("gid-new");
  });

  it("opens a new play when the card rolled over, since a guid is card-bound", async () => {
    const now = Date.now();
    stubFetch({
      "/api/scorecard/open": () => ({ card_id: "card-2" }),
      "/api/cmd/RESET": () => FRAME({ guid: "gid-on-card-2" })
    });
    // The old card is past the reuse window, so its guid is unreachable: a play
    // belongs to the card it was opened on.
    const d = deps([
      card({
        guids: { "ls20-abc": "gid-on-card-1" },
        lastUsedAt: now - SCORECARD_REUSE_MS - MINUTE
      })
    ]);

    const play = await resolvePlay(d, "ls20-abc", now);
    expect(play.cardId).toBe("card-2");
    expect(play.guid).toBe("gid-on-card-2");
  });
});

describe("gameScoreReport", () => {
  it("reads the game's score off an open card", async () => {
    const hits = stubFetch({ "/api/scorecard/card-1": () => SUMMARY() });
    const d = deps([card()]);

    const out = await gameScoreReport(d, "card-1", "ls20-abc");

    expect(hits).toEqual(["/api/scorecard/card-1"]);
    expect(out).toContain("Score for ls20-abc on scorecard card-1: 3");
    expect(out).toContain("2/6 levels");
  });

  it("returns null rather than throwing when the read fails", async () => {
    // This runs after a play already succeeded — a rate-limited score read must
    // not turn a completed run into a failed one.
    stubFetch({});
    const d = deps([card()]);

    await expect(gameScoreReport(d, "card-1", "ls20-abc")).resolves.toBeNull();
  });

  it("returns null when the response is not a scorecard at all", async () => {
    stubFetch({ "/api/scorecard/card-1": () => ({ nope: true }) });
    const d = deps([card()]);

    await expect(gameScoreReport(d, "card-1", "ls20-abc")).resolves.toBeNull();
  });
});

describe("renderGameScore", () => {
  it("renders the game's aggregate and a line per play", () => {
    const out = renderGameScore(SUMMARY(), "ls20-abc");
    expect(out).toContain(
      "Score for ls20-abc on scorecard card-1: 3 — 2/6 levels, 41 actions across 1 play(s)."
    );
    expect(out).toContain(
      "- play 1: GAME_OVER, 2 level(s), 41 actions, score 3"
    );
  });

  it("reports only this game's numbers when the card holds several games", () => {
    // The regression this guards: every top-level field of the response is
    // card-wide, so a shared card would otherwise report its neighbours' actions
    // and score as this game's own. Verified against the live API.
    const out = renderGameScore(
      SUMMARY({
        environments: [OTHER_GAME, SUMMARY().environments[0]],
        score: 102,
        total_actions: 1040,
        total_levels_completed: 11
      }),
      "ls20-abc"
    );
    expect(out).toContain("Score for ls20-abc on scorecard card-1: 3");
    expect(out).toContain("41 actions across 1 play(s)");
    // None of the card-wide or neighbour numbers may appear.
    expect(out).not.toContain("999");
    expect(out).not.toContain("1040");
    expect(out).not.toContain("102");
  });

  it("matches the game by id rather than taking the sole entry on trust", () => {
    // A mislabeled result is worse than none, so a card that somehow lacks our
    // game must not borrow another's entry.
    const out = renderGameScore(
      SUMMARY({ environments: [OTHER_GAME] }),
      "ls20-abc"
    );
    expect(out).toBe("Scorecard card-1 recorded no plays of ls20-abc.");
  });

  it("says so plainly when the card recorded no plays of the game", () => {
    const out = renderGameScore(SUMMARY({ environments: [] }), "ls20-abc");
    expect(out).toBe("Scorecard card-1 recorded no plays of ls20-abc.");
  });
});
