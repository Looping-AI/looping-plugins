import type { ToolFamilyContext } from "@loopingai/core";
import type { WorkspaceHandle } from "@loopingai/core";
import type { ProgressEvent, SubtaskRuntime } from "@loopingai/core/subtasks";
import type { SubtaskParams } from "@loopingai/core";
import type { ScorecardStore } from "../../src/arc-agi/scorecard.js";
import type { Scorecard } from "../../src/arc-agi/types.js";

/** In-memory {@link WorkspaceHandle} backed by a Map — no DO/SQLite needed. */
export function memHandle(): WorkspaceHandle {
  const files = new Map<string, string>();
  return {
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    exists: async (p) => files.has(p),
    remove: async (p) => files.delete(p),
    list: async () =>
      [...files.keys()].map((p) => ({
        path: p,
        type: "file" as const,
        size: 0
      })),
    readJson: async (p) => {
      const r = files.get(p);
      return r ? JSON.parse(r) : null;
    },
    writeJson: async (p, v) => void files.set(p, JSON.stringify(v))
  };
}

/**
 * Build a throwaway {@link ToolFamilyContext} for the arc-game tools, plus the
 * captured progress-event log.
 *
 * No `env`. The predecessor's context carried the Worker `env` and the tools
 * read `env.ARC_API_KEY` out of it; a published package cannot do that, so the
 * key is now an argument to `buildArcGameTools` and this context has nowhere to
 * put one. `apiKey` is returned alongside for the caller to pass through —
 * defaulting to a placeholder, since under VCR playback the key header is
 * excluded from the cassette and its value is irrelevant. Pass the real key only
 * when recording.
 */
export function ctx(
  apiKey = "test-key",
  over: { params?: SubtaskParams; runtime?: SubtaskRuntime } = {}
): {
  apiKey: string;
  ctx: ToolFamilyContext;
  events: ProgressEvent[];
} {
  const events: ProgressEvent[] = [];
  return {
    apiKey,
    events,
    ctx: {
      workspace: memHandle(),
      emitProgress: (e) => events.push(e),
      // The arc-game family plays the game its param names, on the play the
      // parent resolved — card and guid both. Default to a usable set; pass
      // `{ params: {} }` or `{ runtime: {} }` to exercise the ungated paths.
      params: over.params ?? { game_id: "ls20-abc" },
      runtime: over.runtime ?? { cardId: "card-1", guid: "gid-1" }
    }
  };
}

/**
 * In-memory {@link ScorecardStore} backed by a Map, with the same recency
 * semantics as `db.scorecards` and no DO. `now` is injected so a spec can place
 * cards on either side of the reuse window without sleeping; `seed` pre-loads
 * cards with an explicit `lastUsedAt`.
 */
export function memStore(
  seed: Scorecard[] = [],
  now: () => number = Date.now
): ScorecardStore & { all: () => Scorecard[] } {
  const cards = new Map<string, Scorecard>(seed.map((c) => [c.cardId, c]));
  return {
    open(cardId, cookies) {
      const card: Scorecard = {
        cardId,
        cookies,
        guids: {},
        openedAt: now(),
        lastUsedAt: now()
      };
      cards.set(cardId, card);
      return card;
    },
    get: (cardId) => cards.get(cardId) ?? null,
    // First writer wins, exactly as the real model does — the race it settles is
    // the whole reason the column exists.
    setGuid(cardId, gameId, guid) {
      const card = cards.get(cardId);
      if (!card || card.guids[gameId] !== undefined) return;
      cards.set(cardId, {
        ...card,
        guids: { ...card.guids, [gameId]: guid }
      });
    },
    findRecent: (since) =>
      [...cards.values()]
        .filter((c) => c.lastUsedAt >= since)
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
    touch(cardId) {
      const card = cards.get(cardId);
      if (card) cards.set(cardId, { ...card, lastUsedAt: now() });
    },
    all: () => [...cards.values()]
  };
}

/** Invoke a tool's `execute` with a throwaway options object. */
export function callTool(tool: unknown, input: unknown): Promise<string> {
  const t = tool as { execute: (i: unknown, o: unknown) => Promise<string> };
  return t.execute(input, {});
}
