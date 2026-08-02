import { desc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { PluginStore } from "@loopingai/core";
import type { ScorecardStore } from "./scorecard.js";
import type { CookieJar, Scorecard } from "./types.js";

/**
 * The `arc_scorecards` table — cards this agent opened, as a **recency ledger**
 * rather than a lifecycle.
 *
 * The ARC API auto-closes a card after ~15 minutes idle, so nothing here ever
 * closes one and there is no open/closed state worth keeping: a card used
 * recently is live, an older one is gone. `last_used_at` is that clock, bumped
 * every time a play resolves onto the card, and the only column anything queries
 * by — see `resolveScorecard` in {@link file://./scorecard.ts}.
 *
 * ## Why the DDL is hand-written and the queries are not
 *
 * A plugin must never run drizzle's durable-sqlite **migrator**: it keeps one
 * flat integer journal and one global `__drizzle_migrations` table, which two
 * independently-versioned packages cannot share — the two predecessor agents,
 * both consuming the same `notify_tasks` module, had already forked that journal
 * at index 1. And `drizzle-kit generate` diffs against a snapshot in a single
 * output directory, so a plugin shipping from its own repo cannot produce a
 * correct diff at all.
 *
 * None of that touches the **query builder**, which is a typed wrapper over the
 * same `DurableObjectStorage` holding no journal and no connection state. So the
 * split is: `CREATE TABLE IF NOT EXISTS` by hand in {@link arcScorecardStore},
 * every read and write through drizzle below. A second handle alongside core's
 * `AgentDB` is safe — neither carries state the other can disturb.
 *
 * The table is prefixed `arc_` because a plugin's tables share one SQLite
 * database with core's and with every other installed plugin's. An unprefixed
 * `scorecards` is a name a second plugin could plausibly want.
 */
export const arcScorecards = sqliteTable(
  "arc_scorecards",
  {
    /** The ARC-assigned card id (a uuid). */
    cardId: text("card_id").primaryKey(),
    /**
     * JSON cookie jar from `POST /api/scorecard/open`. The ARC API pins a card to
     * the session that opened it: without these cookies the card is invisible —
     * RESET reports the game as not found — so the jar is part of the card's
     * identity, not an optimization.
     */
    cookiesJson: text("cookies_json").notNull().default("{}"),
    /**
     * JSON `{ [gameId]: guid }` — the play this card already opened per game.
     *
     * This is what makes RESET happen **once per game per card**. A guid is the
     * only handle the ARC API gives to a play, and it is mintable only by RESET,
     * so a second RESET is a second play: a new run on the card, scored
     * separately, discarding whatever the first reached. Recording the guid here
     * means a re-dispatched Subtask or a subagent that lost its workspace resumes
     * the play this card already has instead of starting another one.
     */
    guidsJson: text("guids_json").notNull().default("{}"),
    openedAt: integer("opened_at").notNull(),
    /** Last time a play resolved onto this card — the reuse clock. */
    lastUsedAt: integer("last_used_at").notNull()
  },
  (table) => [index("idx_arc_scorecards_last_used_at").on(table.lastUsedAt)]
);

/** The DDL, matching the declaration above. Idempotent; re-run on every wake-up. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS arc_scorecards (
     card_id TEXT PRIMARY KEY NOT NULL,
     cookies_json TEXT NOT NULL DEFAULT '{}',
     guids_json TEXT NOT NULL DEFAULT '{}',
     opened_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_arc_scorecards_last_used_at
     ON arc_scorecards (last_used_at)`
];

/** How long a scorecard row is kept before a maintenance sweep removes it. */
export const SCORECARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const cookiesSchema = z.record(z.string(), z.string());
const guidsSchema = z.record(z.string(), z.string());

type ScorecardRow = typeof arcScorecards.$inferSelect;

/**
 * This plugin's `PluginStore` — the DDL half, handed to `new AgentDB(storage,
 * { stores })` by the host through `runtime.stores`.
 *
 * `version` bumps whenever {@link PluginStore.ensureTables} needs to do
 * something it did not do before; `from` is the version last recorded on disk,
 * so an upgrade path branches on it without re-running earlier DDL.
 */
export const arcScorecardStore: PluginStore = {
  plugin: "arc-agi",
  version: 1,
  ensureTables(sql) {
    for (const statement of DDL) sql.exec(statement);
  }
};

/** Everything the scorecard policy needs, plus the sweep the ledger needs. */
export interface ArcScorecardStore extends ScorecardStore {
  /** Delete cards older than {@link SCORECARD_RETENTION_MS}. */
  cleanup(): void;
}

/**
 * Query methods for `arc_scorecards`, over the plugin's **own** drizzle handle.
 *
 * durable-sqlite is synchronous, so these return plain values. The narrow
 * {@link ScorecardStore} port is what `resolveScorecard`/`resolvePlay` consume,
 * so a spec can pass an in-memory fake and never touch SQLite at all.
 */
export function makeScorecardStore(
  storage: DurableObjectStorage
): ArcScorecardStore {
  const db = drizzle(storage, { schema: { arcScorecards } });

  const rowToScorecard = (row: ScorecardRow): Scorecard => ({
    cardId: row.cardId,
    cookies: cookiesSchema.parse(JSON.parse(row.cookiesJson)),
    guids: guidsSchema.parse(JSON.parse(row.guidsJson)),
    openedAt: row.openedAt,
    lastUsedAt: row.lastUsedAt
  });

  return {
    /**
     * Record a freshly opened card together with the cookie jar the open call
     * returned. The jar is not optional bookkeeping: the ARC API pins the card to
     * that session, so a row without it names a card nobody can reach.
     */
    open(cardId: string, cookies: CookieJar): Scorecard {
      const now = Date.now();
      const row = db
        .insert(arcScorecards)
        .values({
          cardId,
          cookiesJson: JSON.stringify(cookies),
          openedAt: now,
          lastUsedAt: now
        })
        .returning()
        .get();
      return rowToScorecard(row);
    },

    /** Load one card by id. */
    get(cardId: string): Scorecard | null {
      const row = db
        .select()
        .from(arcScorecards)
        .where(eq(arcScorecards.cardId, cardId))
        .get();
      return row ? rowToScorecard(row) : null;
    },

    /**
     * The most recently used card still inside the caller's reuse window, or null
     * if every card is older than `since`. The single read the resolution path
     * makes — see `resolveScorecard` in {@link file://./scorecard.ts}, which owns
     * the window itself.
     */
    findRecent(since: number): Scorecard | null {
      const row = db
        .select()
        .from(arcScorecards)
        .where(gte(arcScorecards.lastUsedAt, since))
        .orderBy(desc(arcScorecards.lastUsedAt))
        .get();
      return row ? rowToScorecard(row) : null;
    },

    /**
     * Record the guid a RESET minted for one game on one card, so the next
     * resolution of that game rejoins the play instead of opening another.
     *
     * Read-modify-write of a JSON map rather than a `(card_id, game_id)` table:
     * durable-sqlite is synchronous and single-threaded within the DO, so this
     * cannot interleave, and every reader already loads the whole row.
     *
     * First writer wins. Two concurrent resolutions of the same game can both
     * find no guid and both RESET, and the loser's play must not overwrite the
     * guid the winner already handed out — keeping the first keeps everyone
     * afterwards on one play.
     */
    setGuid(cardId: string, gameId: string, guid: string): void {
      const row = db
        .select()
        .from(arcScorecards)
        .where(eq(arcScorecards.cardId, cardId))
        .get();
      if (!row) return;
      const guids = guidsSchema.parse(JSON.parse(row.guidsJson));
      if (guids[gameId] !== undefined) return;
      db.update(arcScorecards)
        .set({ guidsJson: JSON.stringify({ ...guids, [gameId]: guid }) })
        .where(eq(arcScorecards.cardId, cardId))
        .run();
    },

    /**
     * Restart a card's reuse clock. Called once per durable chunk of every play
     * running on the card, which is what keeps a long play's card alive: chunks
     * are bounded well under the window (see core's `CHUNK_SOFT_MS`), so an
     * active card is always re-touched before it can expire.
     */
    touch(cardId: string): void {
      db.update(arcScorecards)
        .set({ lastUsedAt: Date.now() })
        .where(eq(arcScorecards.cardId, cardId))
        .run();
    },

    /**
     * Delete scorecards older than the retention window. Safe in a way the old
     * shape was not: a row holds no score, only a dead card id and its jar, and
     * a score is read back from the API on demand.
     *
     * Not called from anywhere in this plugin — a maintenance cron is the host's,
     * and a plugin has no way to schedule one. Each README says so.
     */
    cleanup(): void {
      const cutoff = Date.now() - SCORECARD_RETENTION_MS;
      db.delete(arcScorecards).where(lt(arcScorecards.openedAt, cutoff)).run();
    }
  };
}
