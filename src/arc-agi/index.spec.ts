import { describe, it, expect, vi, afterEach } from "vitest";
import { arcAgi } from "./index.js";
import { memStore } from "../../test/arc-agi/helpers.js";
import type { RecipeExecutionResult } from "@loopingai/core/subtasks";

/**
 * The plugin's own seams — leasing and enrichment — as the parent drives them.
 *
 * These are the four leaks the predecessor kept in its Durable Object, so what
 * is asserted here is the behaviour that used to live there: that concurrent
 * branches share one card, that a play is opened once, and that a report never
 * carries a score belonging to a different card.
 */

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** A stub ARC API that counts what it was asked to do. */
function stubArc(options: { cardIds?: string[] } = {}) {
  const cards = options.cardIds ?? ["card-1", "card-2", "card-3"];
  let opens = 0;
  let resets = 0;
  const scoreReads: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" }
      });

    if (url.includes("/api/scorecard/open")) {
      return json({ card_id: cards[opens++] });
    }
    if (url.includes("RESET")) {
      resets += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        game_id: string;
        card_id: string;
      };
      return json({
        game_id: body.game_id,
        guid: `guid-${body.card_id}-${body.game_id}`,
        frame: [[[0]]],
        state: "NOT_FINISHED",
        levels_completed: 0,
        available_actions: [1]
      });
    }
    if (url.includes("/api/scorecard/")) {
      const cardId = url.split("/api/scorecard/")[1];
      scoreReads.push(cardId);
      return json({
        card_id: cardId,
        score: 3,
        total_actions: 9,
        total_environments: 1,
        total_environments_completed: 0,
        total_levels: 4,
        total_levels_completed: 1,
        environments: [
          {
            id: "gameA",
            actions: 9,
            completed: false,
            level_count: 4,
            levels_completed: 1,
            resets: 1,
            score: 3,
            runs: [
              {
                guid: "g",
                actions: 9,
                completed: false,
                levels_completed: 1,
                resets: 1,
                score: 3,
                state: "NOT_FINISHED"
              }
            ]
          }
        ]
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  return {
    opens: () => opens,
    resets: () => resets,
    scoreReads: () => scoreReads
  };
}

const plugin = (store = memStore()) =>
  arcAgi({ apiKey: "k", storage: {} as DurableObjectStorage, store });

const resolveCtx = (subtaskId: number, gameId: string) => ({
  taskId: "t1",
  subtaskId,
  type: "arc-game",
  params: { game_id: gameId },
  toolFamilies: ["arc-game"]
});

const completed = (): RecipeExecutionResult => ({
  status: "completed",
  resultParts: [{ kind: "text", text: "Played the game." }],
  modelId: "m"
});

describe("leasing", () => {
  it("puts two games delegated together on one card", async () => {
    // All of a round's ready Subtasks execute concurrently, and opening a card
    // is a `fetch` — which opens the DO's input gate, so both branches observe
    // an empty ledger before either has written to it. Resolving each play's
    // card independently would open one card per game.
    const arc = stubArc();
    const p = plugin();

    const [a, b] = await Promise.all([
      p.resolveRuntime!(resolveCtx(1, "gameA")),
      p.resolveRuntime!(resolveCtx(2, "gameB"))
    ]);

    expect(arc.opens()).toBe(1);
    expect(a.cardId).toBe(b.cardId);
    // Different games are still different plays on that one card.
    expect(a.guid).not.toBe(b.guid);
    expect(arc.resets()).toBe(2);
  });

  it("opens one play when the same game is delegated twice at once", async () => {
    // RESET is the only way to mint a guid, and a second RESET is a second
    // scored run that discards whatever the first reached. The store settles the
    // race anyway (first guid written wins), but only after a wasted run is
    // already recorded on the card — collapsing is what keeps the card's history
    // honest, not merely what makes it cheap.
    const arc = stubArc();
    const p = plugin();

    const [a, b] = await Promise.all([
      p.resolveRuntime!(resolveCtx(1, "gameA")),
      p.resolveRuntime!(resolveCtx(2, "gameA"))
    ]);

    expect(arc.opens()).toBe(1);
    expect(arc.resets()).toBe(1);
    expect(a.guid).toBe(b.guid);
  });

  it("rejoins a recorded play instead of resetting again", async () => {
    // A re-dispatched Subtask, or simply a later chunk, must land on the play
    // the card already has.
    const arc = stubArc();
    const p = plugin();

    const first = await p.resolveRuntime!(resolveCtx(1, "gameA"));
    const second = await p.resolveRuntime!(resolveCtx(1, "gameA"));

    expect(arc.resets()).toBe(1);
    expect(second.guid).toBe(first.guid);
    // The opening frame is handed over only to whoever opened the play; there is
    // no ARC endpoint that reads a board back, so a later chunk learns it from
    // its first ACTION.
    expect(first.frame).toBeDefined();
    expect(second.frame).toBeUndefined();
  });
});

describe("enrichResult", () => {
  it("appends the score for the card the play ran on", async () => {
    const arc = stubArc();
    const p = plugin();
    const runtime = await p.resolveRuntime!(resolveCtx(1, "gameA"));

    const result = await p.enrichResult!(
      {
        request: { ...resolveCtx(1, "gameA"), prompt: "", recipe: {} } as never,
        runtime
      },
      completed()
    );

    expect(arc.scoreReads()).toEqual([runtime.cardId]);
    expect(result.status).toBe("completed");
    const text = (result as { resultParts: { text: string }[] }).resultParts
      .map((p) => p.text)
      .join("\n");
    expect(text).toContain("Score for gameA");
  });

  it("omits the score when the lease rolled over mid-execution", async () => {
    // The reuse window elapsing between two chunks leases a fresh card and
    // RESETs on it, while the tool family deliberately keeps playing the session
    // it already has — joining the new play would throw away every level the
    // real one reached. The parent cannot read that session, and the old card is
    // idle-closed by then anyway, so the play is unrecoverable. What must not
    // happen is reporting the *new* card's empty run: it renders as a perfectly
    // plausible "score 0, 0 levels", which reads as a play that achieved nothing
    // rather than as a score that could not be read.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const arc = stubArc();
    const store = memStore();
    const p = plugin(store);

    const first = await p.resolveRuntime!(resolveCtx(1, "gameA"));
    // Age every card past the reuse window, as a >14-minute chunk gap would.
    for (const card of store.all()) {
      card.lastUsedAt = Date.now() - 20 * 60_000;
    }
    const second = await p.resolveRuntime!(resolveCtx(1, "gameA"));
    expect(second.cardId).not.toBe(first.cardId);

    const result = await p.enrichResult!(
      {
        request: { ...resolveCtx(1, "gameA"), prompt: "", recipe: {} } as never,
        runtime: second
      },
      completed()
    );

    // No score read attempted, and the child's report stands as written.
    expect(arc.scoreReads()).toEqual([]);
    expect(result).toEqual(completed());
    expect(warn.mock.calls[0][0]).toContain("rolled over");
    warn.mockRestore();
  });

  it("leaves a failed execution alone", async () => {
    const arc = stubArc();
    const p = plugin();
    const runtime = await p.resolveRuntime!(resolveCtx(1, "gameA"));
    const failed: RecipeExecutionResult = {
      status: "failed",
      error: "budget exhausted",
      modelId: "m"
    };

    expect(
      await p.enrichResult!(
        {
          request: {
            ...resolveCtx(1, "gameA"),
            prompt: "",
            recipe: {}
          } as never,
          runtime
        },
        failed
      )
    ).toEqual(failed);
    expect(arc.scoreReads()).toEqual([]);
  });
});
