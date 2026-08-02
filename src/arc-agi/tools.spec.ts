/**
 * The `arc-game` tool family (src/recipes/arc-game/tools.ts): act / inspect,
 * with session state in an in-memory workspace.
 *
 * These specs script *synthetic* responses per request to exercise the
 * state-transition branches (level-up, GAME_OVER, unavailable action, replay) —
 * cases that can't be captured without actually solving a game. Coverage against
 * the *real* ARC API's response shapes lives in `recorded.spec.ts`, which drives
 * the deterministic flow through the undici SnapshotAgent VCR
 * (test/helpers/vcr.ts) instead of stubbing `fetch`.
 *
 * The family plays; it never opens or closes a scorecard, and it never offers a
 * reset. Several specs here assert those negatives directly, because it used to
 * do all three: one execution is now one play, and a GAME_OVER is the result the
 * card recorded rather than something to retry away.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildArcGameTools } from "./tools.js";
import type { ToolFamilyContext } from "@loopingai/core";
import { parseGrid } from "./analysis.js";
import type { ArcSession, FrameResponse } from "./types.js";
import { ctx, callTool } from "../../test/arc-agi/helpers.js";
import {
  LS20_LEVEL1_BEFORE,
  LS20_LEVEL1_BLOCKED
} from "../../test/arc-agi/ls20-level1.js";

/**
 * The API key is now an argument rather than something read off `ctx.env` — a
 * published package cannot name a consumer's ambient `Env`. Its value is
 * irrelevant here: every request is stubbed.
 */
const build = (c: ToolFamilyContext) => buildArcGameTools("test-key", c);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const FRAME = (over: Partial<FrameResponse> = {}): FrameResponse => ({
  game_id: "ls20-abc",
  guid: "gid-1",
  frame: [
    [
      [0, 1],
      [2, 3]
    ]
  ],
  state: "NOT_FINISHED",
  levels_completed: 0,
  win_levels: 5,
  available_actions: [1, 2, 6],
  ...over
});

/** A mid-play session; `over` sets whatever the spec under test cares about. */
const SESSION = (over: Partial<ArcSession> = {}): ArcSession => ({
  cardId: "card-1",
  gameId: "ls20-abc",
  guid: "gid-1",
  cookies: {},
  winLevels: 5,
  levelsCompleted: 0,
  state: "NOT_FINISHED",
  availableActions: [1, 2],
  actionsSent: 0,
  levelsReported: [],
  lastGridHex: "0",
  pendingAction: null,
  ...over
});

/** `arc_act` with a single step — the shape most specs here want. */
const one = (action: number, x?: number, y?: number) => ({
  steps: [
    {
      action,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y })
    }
  ]
});

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

/** Route requests as {@link stubFetch} does, and capture the JSON bodies posted. */
function stubFetchCapturing(routes: Record<string, () => unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const hits: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      hits.push(path);
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      const handler = routes[path];
      return handler
        ? jsonResponse(handler())
        : new Response("no route", { status: 404 });
    })
  );
  return { bodies, hits };
}

describe("arc-game tool family", () => {
  it("offers no reset tool — the model cannot start or restart a play", () => {
    const { ctx: c } = ctx();
    const { tools } = build(c);
    expect(Object.keys(tools).sort()).toEqual(["arc_act", "arc_inspect"]);
  });

  it("never RESETs — it joins the play the parent resolved", async () => {
    const hits = stubFetch({ "/api/cmd/ACTION1": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7", guid: "gid-parent", frame: FRAME() }
    });
    const { tools } = build(c);

    const out = await callTool(tools.arc_inspect, { view: "shapes" });
    expect(out).toContain("Playing ls20-abc");
    // The card is not the model's business, so it is not narrated back to it.
    expect(out).not.toContain("card-7");

    await callTool(tools.arc_act, one(1));
    // The one thing this family must never do, however it is driven.
    expect(hits).not.toContain("/api/cmd/RESET");
    expect(hits).not.toContain("/api/games");
    expect(hits).not.toContain("/api/scorecard/open");
  });

  it("seeds its session from the resolved play, not from anything it opened", async () => {
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: {
        cardId: "card-7",
        guid: "gid-parent",
        cookies: { GAMESESSION: "abc" },
        frame: FRAME({ guid: "gid-ignored" })
      }
    });
    const { tools } = build(c);
    await callTool(tools.arc_inspect, { view: "shapes" });

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.cardId).toBe("card-7");
    // The guid is the parent's, and it outranks anything in the frame body: it
    // is the play this subagent was told to join.
    expect(session?.guid).toBe("gid-parent");
    expect(session?.cookies).toEqual({ GAMESESSION: "abc" });
    expect(session?.availableActions).toEqual([1, 2, 6]);
  });

  it("addresses every action to the resolved guid", async () => {
    const { bodies } = stubFetchCapturing({
      "/api/cmd/ACTION1": () => FRAME()
    });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7", guid: "gid-parent", frame: FRAME() }
    });
    const { tools } = build(c);

    await callTool(tools.arc_act, one(1));
    expect(bodies[0]).toMatchObject({
      game_id: "ls20-abc",
      guid: "gid-parent"
    });
    // A card id would mean this call could open a play; it cannot.
    expect(bodies[0]).not.toHaveProperty("card_id");
  });

  it("keeps playing its own play when a later chunk's lease rolled over", async () => {
    // The only rollover shape production can produce: `guids` is keyed per card,
    // so a fresh card has no recorded guid and the parent RESETs — a new card
    // therefore *always* arrives with a new guid, naming an empty play while the
    // workspace holds the one with every level reached. The stub echoes the guid
    // it was addressed with, as the API does.
    const { bodies, hits } = stubFetchCapturing({
      "/api/cmd/ACTION1": () => FRAME({ guid: "gid-parent" })
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx: first } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-old", guid: "gid-parent", frame: FRAME() }
    });
    await callTool(build(first).tools.arc_inspect, {
      view: "shapes"
    });

    const second: typeof first = {
      ...first,
      runtime: { cardId: "card-new", guid: "gid-rollover" }
    };
    await callTool(build(second).tools.arc_act, one(1));

    // The play outlives the lease: neither the new card nor the new guid pulls it.
    expect(bodies.at(-1)).toMatchObject({ guid: "gid-parent" });
    expect(hits).not.toContain("/api/cmd/RESET");
    const session =
      await first.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.cardId).toBe("card-old");
    expect(session?.guid).toBe("gid-parent");

    // Nothing here can undo the parent's RESET or correct the score it will read
    // from the new card, so the divergence has to be visible in the logs.
    expect(warn).toHaveBeenCalledWith(
      "[arc-game] play/lease divergence",
      expect.objectContaining({
        playing: "gid-parent",
        resolved: "gid-rollover",
        playCard: "card-old",
        leaseCard: "card-new"
      })
    );
  });

  it("says nothing about a lease that resolved onto the play it is already on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ guid: "gid-parent" }) });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7", guid: "gid-parent", frame: FRAME() }
    });
    await callTool(build(c).tools.arc_act, one(1));
    await callTool(build(c).tools.arc_act, one(1));
    expect(warn).not.toHaveBeenCalled();
  });

  it("joins a play it has no frame for, and learns the board from the first action", async () => {
    // A re-dispatched Subtask or a lost workspace: the parent resolved the guid
    // it already had, so there is no opening frame to hand over and no endpoint
    // that could fetch one.
    const hits = stubFetch({ "/api/cmd/ACTION1": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7", guid: "gid-parent" }
    });
    const { tools } = build(c);

    const look = await callTool(tools.arc_inspect, { view: "shapes" });
    expect(look).toContain("No board received yet");
    // Level/state/actions are unknown here, and saying "available actions: none"
    // would read as "you may do nothing".
    expect(look).not.toContain("available actions: none");

    // An unknown action list must not read as "nothing is legal", or the play
    // would be stuck with no way to ever learn otherwise.
    const acted = await callTool(tools.arc_act, one(1));
    expect(acted).not.toContain("not available");
    expect(hits).toContain("/api/cmd/ACTION1");
    expect(hits).not.toContain("/api/cmd/RESET");
    // A reply that cannot carry the orientation must not spend it either: the
    // inspect above had no board to describe, so this call is where the chunk
    // still owes the model its bearings.
    expect(acted).toContain("Playing ls20-abc");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.availableActions).toEqual([1, 2, 6]);
    expect(session?.lastGridHex).not.toBeNull();
  });

  it("fails loudly when no play was resolved for it", async () => {
    const { ctx: c } = ctx("test-key", { runtime: { cardId: "card-7" } });
    const { tools } = build(c);
    // Minting a guid is precisely the power this family does not have, so there
    // is nothing to fall back to.
    await expect(callTool(tools.arc_act, one(1))).rejects.toThrow(
      "no play was resolved for this subtask (missing runtime.guid)"
    );
  });

  it("names every part of the play the parent failed to resolve", async () => {
    // `buildRecipeTools` gates the family on the card, so an unset one means the
    // family was built past its gate; the error says which piece is missing
    // rather than writing a session around an absent card id.
    const { ctx: c } = ctx("test-key", { runtime: { guid: "gid-1" } });
    await expect(callTool(build(c).tools.arc_act, one(1))).rejects.toThrow(
      "missing runtime.cardId"
    );

    const { ctx: bare } = ctx("test-key", { runtime: {} });
    await expect(callTool(build(bare).tools.arc_act, one(1))).rejects.toThrow(
      "missing runtime.guid and runtime.cardId"
    );
  });

  it("rejects an action that is not currently available", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", SESSION());

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(5));
    expect(out).toContain("not available");
  });

  it("emits a level-up progress event", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ levels_completed: 1 }) });
    const { ctx: c, events } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(1));
    expect(out).toContain("level 1/5");
    expect(events).toEqual([
      {
        key: "arc:ls20-abc:level:1",
        text: expect.stringContaining("reached level 1/5") as string
      }
    ]);
  });

  it("never closes the scorecard when a play reaches GAME_OVER", async () => {
    const hits = stubFetch({
      "/api/cmd/ACTION1": () => FRAME({ state: "GAME_OVER" })
    });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(1));
    expect(hits).not.toContain("/api/scorecard/close");
    // A GAME_OVER is the card's result for this game: report it, do not retry it.
    expect(out).toContain("write your final report");
    expect(out).not.toContain("reset");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.state).toBe("GAME_OVER");
  });

  it("sends nothing and asks for the report when acting on a finished play", async () => {
    const hits = stubFetch({});
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", SESSION({ state: "WIN" }));

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(1));
    expect(out).toContain("Write your final report");
    expect(out).not.toContain("reset");
    expect(hits).toEqual([]);
  });

  it("never opens a second play after a terminal state", async () => {
    // The exact behaviour the reset tool used to provide, now impossible: a
    // finished play stays finished, so the scorecard's GAME_OVER stands.
    const hits = stubFetch({});
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ state: "GAME_OVER", levelsCompleted: 2, actionsSent: 17 })
    );

    const { tools } = build(c);
    await callTool(tools.arc_act, one(1));
    await callTool(tools.arc_inspect, { view: "shapes" });
    expect(hits).not.toContain("/api/cmd/RESET");

    // Untouched: no new guid, and the counters still describe the play that ran.
    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.guid).toBe("gid-1");
    expect(session?.state).toBe("GAME_OVER");
    expect(session?.actionsSent).toBe(17);
  });

  it("has no abort hook — the scorecard is not the subagent's to release", () => {
    const { ctx: c } = ctx();
    expect(build(c).abort).toBeUndefined();
  });
});

/**
 * Completing a level emits progress, and progress is a chunk-end boundary, so
 * the model resumes every new level with its recent turns trimmed out of context
 * — the board included. The tool family is rebuilt per chunk, which is what makes
 * "once per chunk" expressible here at all: one `buildArcGameTools` call is one
 * chunk. Leading that chunk's first result with the board costs no game action
 * and no turn, where re-inspecting to get oriented costs a turn per level.
 */
describe("chunk orientation", () => {
  it("leads this chunk's first arc_act with the status and the board", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME() });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [1],
        levelsCompleted: 2,
        lastGridHex: "9b\n00"
      })
    );

    const { tools } = build(c);
    const first = await callTool(tools.arc_act, one(1));
    expect(first).toContain("Playing ls20-abc");
    expect(first).toContain("level 2/5");
    expect(first).toContain("blue: row 0, col 0 (1 cell)");

    // Still the same chunk: the model has all of that in context already, and
    // repeating it every call would be the context window's problem, not a fix.
    const second = await callTool(tools.arc_act, one(1));
    expect(second).not.toContain("Playing ls20-abc");
    expect(second).not.toContain("Board:");
  });

  it("leads the first arc_inspect with the status line and no second board", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_inspect, { view: "shapes" });
    expect(out).toContain("Playing ls20-abc");
    expect(out).toContain("state NOT_FINISHED");
    // The view already IS the board; orienting with shapes too would print it
    // twice in one result.
    expect(out.match(/blue: row 0, col 0/g)).toHaveLength(1);
    expect(out).not.toContain("Board:");
  });

  it("orients again in the next chunk, which is where a level-up lands", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ levels_completed: 1 }) });
    const { ctx: c, events } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1], lastGridHex: "9b\n00" })
    );

    // The level-up. Its progress event is what ends the chunk.
    const before = build(c);
    await callTool(before.tools.arc_act, one(1));
    expect(events).toHaveLength(1);

    // The next chunk: same workspace, family rebuilt, context window trimmed.
    // The model has to be told where it is, and it must not cost it a turn.
    const after = build(c);
    const resumed = await callTool(after.tools.arc_inspect, { view: "shapes" });
    expect(resumed).toContain("Playing ls20-abc");
    expect(resumed).toContain("level 1/5");
  });

  it("says where a finished play ended before asking for the report", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        state: "GAME_OVER",
        levelsCompleted: 3,
        lastGridHex: "9b\n00"
      })
    );

    // Resuming onto a terminal play: the report has to name what it reached, and
    // by now that may be the only place the model can read it.
    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(1));
    expect(out).toContain("level 3/5");
    expect(out).toContain("state GAME_OVER");
    expect(out).toContain("Write your final report");
  });
});

/**
 * Sequences are only safe if each step's effect is attributable to that step. A
 * batch that reported one lumped diff would be strictly worse than the same
 * actions sent one at a time, because the model would learn that the board moved
 * but not which action moved it — so these specs are mostly about attribution.
 */
describe("arc_act sequences", () => {
  /** Frames whose boards differ per call, so a mis-paired diff is visible. */
  function stubFrames(frames: FrameResponse[]) {
    let i = 0;
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse(frames[Math.min(i++, frames.length - 1)]);
      })
    );
    return paths;
  }

  /** A 2×2 board as a frame response body. */
  const boardFrame = (grid: number[][], over: Partial<FrameResponse> = {}) =>
    FRAME({ frame: [grid], available_actions: [1, 2, 4, 6], ...over });

  it("sends every step in order and attributes each change to its own action", async () => {
    // A single cell walks right one column per action.
    const paths = stubFrames([
      boardFrame([
        [0, 9],
        [0, 0]
      ]),
      boardFrame([
        [0, 0],
        [0, 9]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [1, 4, 6],
        // Board starts with the cell at (0,0).
        lastGridHex: "90\n00"
      })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 2 }]
    });

    expect(paths).toEqual(["/api/cmd/ACTION4", "/api/cmd/ACTION2"]);
    expect(out).toContain("2 steps requested, 2 sent.");
    // Step 1 moved (0,0)->(0,1); step 2 moved (0,1)->(1,1). Each line describes
    // only its own action's shift, matched against the board just before it — the
    // same cell no longer reported twice as a vanishing and an appearing cell.
    expect(out).toContain(
      "1. right → blue 1×1 row 0, col 0 → cols 1-1 (right 1)"
    );
    expect(out).toContain(
      "2. down → blue 1×1 row 0, col 1 → rows 1-1 (down 1)"
    );
    // And where the batch left it, in moves rather than in cells.
    expect(out).toContain("net: blue 1×1 down 1, right 1 over 2 moves");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.actionsSent).toBe(2);
    expect(session?.lastGridHex).toBe("00\n09");
    expect(session?.pendingAction).toBeNull();
  });

  it("nets two identical shapes separately instead of cancelling them out", async () => {
    // Two blue cells, one walking right and one walking left, one column per
    // step. Netted by color and size alone the two cancel and the batch claims
    // nothing moved — the one thing the model could not have recovered from the
    // per-step lines above it.
    stubFrames([
      boardFrame([
        [0, 9, 0],
        [0, 0, 0],
        [0, 9, 0]
      ]),
      boardFrame([
        [0, 0, 9],
        [0, 0, 0],
        [9, 0, 0]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: "900\n000\n009" })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }]
    });
    expect(out).toContain(
      "net: blue 1×1 right 2 over 2 moves, right 1 per move; " +
        "blue 1×1 left 2 over 2 moves, left 1 per move"
    );
    expect(out).not.toContain("back where it started");
  });

  it("reports a step that changed nothing as a real result, not a gap", async () => {
    stubFrames([
      boardFrame([
        [9, 0],
        [0, 0]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: "90\n00" })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, { steps: [{ action: 4 }] });
    expect(out).toContain("0 cells changed (no effect at all)");
  });

  // The failure this whole rendering exists for. A move into a wall on a board
  // with a step counter changes exactly the counter, so the cell diff reports a
  // change and reads as a move that worked; one logged play spent eleven actions,
  // eight of them into walls, and never noticed. The shape view has to name what
  // *moved*, and say when nothing did.
  it("calls a blocked move blocked even when a counter ticked", async () => {
    // Row 0 is the player, pinned against the left wall; row 1 is a counter that
    // loses one cell per action. It starts at three cells and ends at one.
    stubFrames([
      boardFrame([
        [9, 0, 0, 0],
        [11, 11, 0, 0]
      ]),
      boardFrame([
        [9, 0, 0, 0],
        [11, 0, 0, 0]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: "9000\nbbb0" })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }]
    });

    // Neither step moved the player, and the counter's shrinking is reported as
    // exactly that rather than as a change of position.
    expect(out).toContain("1. right → nothing moved");
    expect(out).toContain("2. right → nothing moved");
    expect(out).toContain(
      "yellow row 1, cols 0-2 → row 1, cols 0-1 (3→2 cells)"
    );
    expect(out).toContain("yellow row 1, cols 0-1 → row 1, col 0 (2→1 cells)");
    // And the net line says the same thing about the batch, in the register the
    // steps earned: nothing travelled, on a board that changed both times. It
    // does not call them refusals — a renderer that has not been told whether
    // this game moves anything cannot know that, and saying it anyway is what
    // told a click game its every click had been blocked.
    expect(out).toContain("no shape travelled");
    expect(out).toContain(
      "2 of 2 step(s) changed the board without moving a shape"
    );
    // The cell diff is not what the model reads here — the counter's four cells
    // would have been the whole story.
    expect(out).not.toContain("cells changed");
  });

  // The mirror-image failure, and the one the click games produce. Nothing on a
  // click board ever travels, so every step used to be counted as having moved
  // nothing and the batch summarised as "every one of them was refused or
  // blocked" — over clicks that had each toggled a block. What separates a refusal
  // from a move here is the cell diff, not the shape delta.
  it("does not call a click that changed the board a refusal", async () => {
    // A blue block that clicking toggles to red, a bar that gives up a cell to a
    // yellow counter when it does — then a click that lands on nothing.
    const toggled = boardFrame(
      [
        [8, 8, 0, 0],
        [8, 8, 0, 0],
        [0, 0, 0, 0],
        [12, 12, 12, 11]
      ],
      { available_actions: [6] }
    );
    stubFrames([toggled, toggled]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [6],
        lastGridHex: "9900\n9900\n0000\ncccc"
      })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [
        { action: 6, x: 0, y: 0 },
        { action: 6, x: 3, y: 2 }
      ]
    });

    // The toggle is named as a toggle — one shape, repainted where it stood,
    // rather than as one shape vanishing and another materializing in its place.
    expect(out).toContain("blue 2×2 at rows 0-1, cols 0-1 turned red");
    expect(out).toContain("no shape travelled, but the board changed");
    expect(out).not.toContain("is gone");
    // Only the second click did nothing, and only it is counted as a refusal.
    expect(out).toContain("2. click(3,2) → 0 cells changed (no effect at all)");
    expect(out).toContain("1 of 2 step(s) changed not one cell");
    expect(out).toContain(
      "1 of 2 step(s) changed the board without moving a shape"
    );
    expect(out).not.toContain("refused or blocked");
  });

  // The same claim, on the board that actually produced the failure: 64×64, two
  // dozen regions, a selector pinned against a wall and a bar that ticks anyway.
  // A synthetic 2×4 board proves the rendering; this proves the *matching* holds up
  // at real scale — that two dozen static shapes pair off silently and the change
  // count stays under MAX_SHAPE_CHANGES, rather than the whole view standing aside.
  it("reads a real blocked ls20 action as blocked", async () => {
    stubFrames([boardFrame(parseGrid(LS20_LEVEL1_BLOCKED))]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [1, 2, 3, 4],
        lastGridHex: LS20_LEVEL1_BEFORE
      })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, { steps: [{ action: 4 }] });

    const step = out.split("\n").find((l) => l.startsWith("1. right"));
    expect(step).toContain("nothing moved");
    // The selector is where it was — the claim the play got wrong about itself.
    expect(step).not.toContain("orange");
    expect(step).not.toContain("rows 40-41");
    // The bar is named as a bar giving up cells, which is all it did — three
    // actions' worth, four cells each — and the spent stretch behind it as one
    // growing by the same amount. Two changes on a board of two dozen regions:
    // everything else paired off silently, which is why this stays readable.
    expect(step).toContain(
      "yellow rows 61-62, cols 25-54 → rows 61-62, cols 31-54 (60→48 cells)"
    );
    expect(step).toContain(
      "neutral rows 61-62, cols 13-24 → rows 61-62, cols 13-30 (24→36 cells)"
    );
  });

  it("stops the sequence and names the unsent tail when an action goes unavailable", async () => {
    // The first action succeeds but narrows what is legal next.
    const paths = stubFrames([
      boardFrame([[0]], { available_actions: [1] }),
      boardFrame([[0]])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }, { action: 4 }, { action: 4 }]
    });

    // Only one action reached the API: the rest would have been rejected.
    expect(paths).toEqual(["/api/cmd/ACTION4"]);
    expect(out).toContain("4 steps requested, 1 sent.");
    expect(out).toContain(
      "2-4. not sent: right is not available (available: 1=up)"
    );
  });

  // `available actions: 6` was every result of a logged click-only play, and it
  // reads as a count of six actions at least as readily as it reads as action 6.
  // The number stays, because the number is what `arc_act` takes.
  it("names the legal actions rather than listing bare opcodes", async () => {
    stubFrames([boardFrame([[0]], { available_actions: [6] })]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [6] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, one(6, 1, 1));
    expect(out).toContain("available actions: 6=click");
  });

  it("stops the sequence when the play ends mid-batch", async () => {
    const paths = stubFrames([
      boardFrame([[0]]),
      boardFrame([[1]], { state: "WIN" }),
      boardFrame([[2]])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1, 4, 6] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }, { action: 4 }]
    });

    expect(paths).toHaveLength(2);
    expect(out).toContain("3. not sent: state became WIN");
    expect(out).toContain("This play is over");
  });

  it("carries per-step click coordinates, not one pair for the whole batch", async () => {
    const { bodies } = stubFetchCapturing({
      "/api/cmd/ACTION6": () => FRAME({ available_actions: [6] })
    });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [6] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, {
      steps: [
        { action: 6, x: 12, y: 34 },
        { action: 6, x: 56, y: 7 }
      ]
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ x: 12, y: 34 });
    expect(bodies[1]).toMatchObject({ x: 56, y: 7 });
    // The label carries the coordinates too, so a trace of clicks is readable.
    expect(out).toContain("1. click(12,34)");
    expect(out).toContain("2. click(56,7)");
  });

  it("refuses a click with no coordinates without spending the action", async () => {
    const paths = stubFrames([boardFrame([[0]])]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [6] })
    );

    const { tools } = build(c);
    const out = await callTool(tools.arc_act, { steps: [{ action: 6 }] });
    expect(paths).toEqual([]);
    expect(out).toContain("requires x and y");
  });

  it("budgets cell detail across the batch so a long sequence cannot flood context", async () => {
    // Every action repaints a 5×5 checkerboard in a new color: 13 isolated cells
    // vanish and 13 appear, which is past the point where naming shapes says
    // anything (MAX_SHAPE_CHANGES), so these steps render as cells and the
    // per-step cell cap is what bounds the output.
    const checker = (v: number) =>
      boardFrame(
        Array.from({ length: 5 }, (_, r) =>
          Array.from({ length: 5 }, (_, c) => ((r + c) % 2 === 0 ? v : 0))
        )
      );
    const blank = Array.from({ length: 5 }, () => "00000").join("\n");
    stubFrames([
      checker(1),
      checker(2),
      checker(3),
      checker(4),
      checker(5),
      checker(6)
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: blank })
    );

    const { tools } = build(c);
    const long = await callTool(tools.arc_act, {
      steps: Array.from({ length: 6 }, () => ({ action: 4 }))
    });
    // floor(24/6) = 4 example cells per step. Anchored to the step line's own
    // text rather than its position: the chunk orientation rides in front of it.
    const step1 = long.split("\n").find((l) => l.startsWith("1. right"));
    expect(step1).toContain("cells changed");
    expect(step1?.match(/\(\d,\d\)/g)).toHaveLength(4);

    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: blank })
    );
    const single = await callTool(tools.arc_act, { steps: [{ action: 4 }] });
    // A single step has the whole budget: 24, capped by the 13 cells that changed.
    expect(single.match(/\(\d,\d\)/g)).toHaveLength(13);
  });

  it("orients a fresh play with where the shapes are, not an order to go look", async () => {
    // arc_act joins the play and acts in the same turn, so the opening carries
    // the board the parent handed over — otherwise that first action is blind.
    const board = [
      [0, 0],
      [9, 9]
    ];
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ frame: [board] }) });
    const { ctx: c } = ctx("test-key", {
      runtime: {
        cardId: "card-1",
        guid: "gid-1",
        frame: FRAME({ frame: [board] })
      }
    });
    const { tools } = build(c);

    const out = await callTool(tools.arc_act, one(1));
    expect(out).toContain("Playing ls20-abc");
    expect(out).toContain("blue: row 1, cols 0-1 (2 cells)");
    // The old text ended with "Call arc_inspect to see the board", which bought a
    // guaranteed second turn before the model could act.
    expect(out).not.toContain("Call arc_inspect");
  });

  it("names colors rather than indices in the inspect views", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    const { tools } = build(c);
    expect(await callTool(tools.arc_inspect, { view: "shapes" })).toContain(
      "blue: row 0, col 0 (1 cell)"
    );
    expect(await callTool(tools.arc_inspect, { view: "histogram" })).toContain(
      "white: 2 cells"
    );
    // The grid stays one character per cell — a legend carries the names instead.
    const grid = await callTool(tools.arc_inspect, { view: "grid" });
    expect(grid).toContain("colors: 0=white 9=blue b=yellow");
    expect(grid).toContain("| 9b");
  });

  // A play spent fifteen of nineteen turns looking, four of them at the same
  // `shapes` view of a board nothing had touched. Redrawing it answers a question
  // already answered; saying so is what makes the waste visible to the model.
  it("says a repeated view is unchanged instead of drawing it again", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    const { tools } = build(c);
    expect(await callTool(tools.arc_inspect, { view: "shapes" })).toContain(
      "blue: row 0, col 0"
    );
    const again = await callTool(tools.arc_inspect, { view: "shapes" });
    expect(again).toContain("Unchanged since your last `shapes` view");
    expect(again).not.toContain("blue: row 0, col 0");

    // A different view of the same board is a different question, and answered.
    expect(await callTool(tools.arc_inspect, { view: "histogram" })).toContain(
      "white: 2 cells"
    );
  });

  it("draws the same view again once the board has moved on", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    const { tools } = build(c);
    await callTool(tools.arc_inspect, { view: "shapes" });
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "00\n9b" })
    );
    const moved = await callTool(tools.arc_inspect, { view: "shapes" });
    expect(moved).toContain("blue: row 1, col 0");
    expect(moved).not.toContain("Unchanged");
  });

  it("re-draws for a new chunk rather than pointing at a view that scrolled away", async () => {
    // The dedupe is scoped to one chunk on purpose: across a chunk boundary the
    // earlier render has been trimmed out of the model's context, so telling it
    // "you already saw this" would leave it with nothing.
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    await callTool(build(c).tools.arc_inspect, { view: "shapes" });
    const next = await callTool(build(c).tools.arc_inspect, {
      view: "shapes"
    });
    expect(next).toContain("blue: row 0, col 0");
    expect(next).not.toContain("Unchanged");
  });
});
