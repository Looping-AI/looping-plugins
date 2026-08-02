/**
 * The `arc_scorecards` data layer, against real SQLite in a real Durable Object.
 *
 * No mocks and no stubs, because the thing under test is precisely whether the
 * hand-written DDL and the drizzle table declaration agree — and only workerd's
 * SQLite can answer that. The scorecard *policy* above this takes the narrow
 * `ScorecardStore` port and is tested against an in-memory fake instead.
 *
 * The table is a recency ledger, not a lifecycle: nothing closes a card (the ARC
 * API retires an idle one on its own), so what these specs pin is the clock —
 * which card `findRecent` picks, and that `touch` moves it.
 */
import { describe, it, expect } from "vitest";
import {
  arcScorecardStore,
  makeScorecardStore,
  SCORECARD_RETENTION_MS
} from "./store.js";
import { withScorecards, withStorage } from "../../test/arc-agi/do.js";

const MINUTE = 60_000;

describe("arc_scorecards DDL", () => {
  it("is idempotent, because core re-runs it on every hibernation wake-up", async () => {
    const rows = await withStorage("ddl-idempotent", (storage) => {
      arcScorecardStore.ensureTables(storage.sql, 0);
      const store = makeScorecardStore(storage);
      store.open("card-1", { AWSALB: "x" });
      // A second wake-up must not throw, and must not drop what is there.
      arcScorecardStore.ensureTables(storage.sql, arcScorecardStore.version);
      return store.get("card-1");
    });
    expect(rows?.cookies).toEqual({ AWSALB: "x" });
  });

  it("creates the index the reuse query reads by", async () => {
    // `findRecent` orders by `last_used_at` on every chunk of every play, so the
    // index is not decoration. It is also the easiest thing to leave out of
    // hand-written DDL after adding it to the drizzle declaration.
    const names = await withStorage("ddl-index", (storage) => {
      arcScorecardStore.ensureTables(storage.sql, 0);
      return [
        ...storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'arc_scorecards'"
          )
          .raw()
      ].flat();
    });
    expect(names).toContain("idx_arc_scorecards_last_used_at");
  });

  it("names its table under the plugin's own prefix", async () => {
    // A plugin's tables share one database with core's and with every other
    // installed plugin's. A bare `scorecards` is a name a second plugin could
    // plausibly want.
    const tables = await withStorage("ddl-prefix", (storage) => {
      arcScorecardStore.ensureTables(storage.sql, 0);
      return [
        ...storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
          .raw()
      ].flat();
    });
    expect(tables).toContain("arc_scorecards");
    expect(tables).not.toContain("scorecards");
  });

  it("declares a version core can record and branch on", () => {
    expect(arcScorecardStore.plugin).toBe("arc-agi");
    expect(Number.isInteger(arcScorecardStore.version)).toBe(true);
    expect(arcScorecardStore.version).toBeGreaterThanOrEqual(1);
  });
});

describe("scorecards.open", () => {
  it("records the card, its jar, and starts its clock", async () => {
    const card = await withScorecards("sc-open", (s) =>
      s.open("card-1", { AWSALB: "abc" })
    );
    expect(card.cardId).toBe("card-1");
    expect(card.cookies).toEqual({ AWSALB: "abc" });
    expect(card.openedAt).toBeGreaterThan(0);
    // A card is usable the instant it exists, so its clock starts already running.
    expect(card.lastUsedAt).toBe(card.openedAt);
  });

  it("round-trips the jar, which is what makes the card reachable at all", async () => {
    // The ARC API pins a card to the session that opened it: without these
    // cookies the card is invisible and RESET reports the game as not found.
    const card = await withScorecards("sc-jar", (s) => {
      s.open("card-1", { AWSALB: "a", AWSALBCORS: "b" });
      return s.get("card-1");
    });
    expect(card?.cookies).toEqual({ AWSALB: "a", AWSALBCORS: "b" });
  });

  it("get returns null for an unknown card", async () => {
    expect(await withScorecards("sc-missing", (s) => s.get("nope"))).toBeNull();
  });

  it("starts with no plays recorded on it", async () => {
    const card = await withScorecards("sc-guids-empty", (s) =>
      s.open("card-1", {})
    );
    expect(card.guids).toEqual({});
  });
});

/**
 * The guid map is what makes RESET happen once per game per card. A guid is
 * mintable only by RESET and a second RESET is a second scored run, so these pin
 * the two properties the policy relies on: a guid survives a round-trip, and an
 * existing one is never overwritten.
 */
describe("scorecards.setGuid", () => {
  it("records a game's guid and round-trips it", async () => {
    const card = await withScorecards("sc-guid-set", (s) => {
      s.open("card-1", {});
      s.setGuid("card-1", "ls20", "guid-1");
      return s.get("card-1");
    });
    expect(card?.guids).toEqual({ ls20: "guid-1" });
  });

  it("keeps several games' plays side by side on one card", async () => {
    // Concurrent plays share a card by design.
    const card = await withScorecards("sc-guid-multi", (s) => {
      s.open("card-1", {});
      s.setGuid("card-1", "ls20", "guid-1");
      s.setGuid("card-1", "ft09", "guid-2");
      return s.get("card-1");
    });
    expect(card?.guids).toEqual({ ls20: "guid-1", ft09: "guid-2" });
  });

  it("keeps the first guid written, never the last", async () => {
    // Two concurrent resolutions of one game can both find no guid and both
    // RESET. The loser's play must not overwrite the guid the winner already
    // handed out, or the two subagents end up on different runs of the same card.
    const card = await withScorecards("sc-guid-race", (s) => {
      s.open("card-1", {});
      s.setGuid("card-1", "ls20", "winner");
      s.setGuid("card-1", "ls20", "loser");
      return s.get("card-1");
    });
    expect(card?.guids.ls20).toBe("winner");
  });

  it("is a silent no-op for a card that does not exist", async () => {
    const card = await withScorecards("sc-guid-unknown", (s) => {
      s.setGuid("nope", "ls20", "guid-1");
      return s.get("nope");
    });
    expect(card).toBeNull();
  });
});

describe("scorecards.findRecent", () => {
  it("returns nothing before any card is opened", async () => {
    const card = await withScorecards("sc-empty", (s) =>
      s.findRecent(Date.now() - 14 * MINUTE)
    );
    expect(card).toBeNull();
  });

  it("finds a card inside the window and ignores one outside it", async () => {
    const result = await withScorecards("sc-window", (store, storage) => {
      store.open("stale", {});
      store.open("live", {});
      // Backdate `stale` past any plausible window. Raw SQL because the data
      // layer deliberately offers no way to write a past timestamp.
      storage.sql.exec(
        "UPDATE arc_scorecards SET last_used_at = ? WHERE card_id = 'stale'",
        Date.now() - 20 * MINUTE
      );
      return {
        inWindow: store.findRecent(Date.now() - 14 * MINUTE)?.cardId,
        // A window that excludes everything must return null rather than the
        // least-old card — "nothing is live" is a real answer.
        none: store.findRecent(Date.now() + MINUTE)
      };
    });
    expect(result.inWindow).toBe("live");
    expect(result.none).toBeNull();
  });

  it("picks the most recently used card, not the most recently opened", async () => {
    // The two orders differ exactly when an older card is still being played,
    // which is the case the reuse policy exists for.
    const cardId = await withScorecards("sc-mru", (store, storage) => {
      store.open("older", {});
      store.open("newer", {});
      storage.sql.exec(
        "UPDATE arc_scorecards SET last_used_at = ? WHERE card_id = 'older'",
        Date.now() + 5 * MINUTE
      );
      return store.findRecent(Date.now() - 14 * MINUTE)?.cardId;
    });
    expect(cardId).toBe("older");
  });
});

describe("scorecards.touch", () => {
  it("moves the clock forward without touching openedAt", async () => {
    const result = await withScorecards("sc-touch", (store, storage) => {
      const opened = store.open("card-1", {});
      storage.sql.exec(
        "UPDATE arc_scorecards SET last_used_at = ? WHERE card_id = 'card-1'",
        Date.now() - 20 * MINUTE
      );
      // Expired by the clock, then touched: this is how a long play keeps its
      // own card alive across chunks.
      const beforeTouch = store.findRecent(Date.now() - 14 * MINUTE);
      store.touch("card-1");
      return {
        beforeTouch,
        afterTouch: store.findRecent(Date.now() - 14 * MINUTE)?.cardId,
        openedAt: store.get("card-1")?.openedAt,
        originalOpenedAt: opened.openedAt
      };
    });
    expect(result.beforeTouch).toBeNull();
    expect(result.afterTouch).toBe("card-1");
    expect(result.openedAt).toBe(result.originalOpenedAt);
  });

  it("is a silent no-op on an unknown card", async () => {
    await expect(
      withScorecards("sc-touch-unknown", (s) => {
        s.touch("nope");
        return s.get("nope");
      })
    ).resolves.toBeNull();
  });
});

describe("scorecards.cleanup", () => {
  it("deletes cards untouched past the retention window", async () => {
    // Safe in a way the predecessor's shape was not: a row holds no score, only
    // a dead card id and its jar, and a score is read back from the API on demand.
    const remaining = await withScorecards("sc-cleanup", (store, storage) => {
      store.open("old", {});
      store.open("new", {});
      storage.sql.exec(
        "UPDATE arc_scorecards SET last_used_at = ? WHERE card_id = 'old'",
        Date.now() - SCORECARD_RETENTION_MS - MINUTE
      );
      store.cleanup();
      return [
        ...storage.sql.exec("SELECT card_id FROM arc_scorecards").raw()
      ].flat();
    });
    expect(remaining).toEqual(["new"]);
  });

  it("keeps a long-lived card that is still being used", async () => {
    // The two clocks diverge for exactly the card this ledger exists for: an
    // agent playing regularly touches one card every chunk and keeps it open
    // indefinitely. Sweeping on `openedAt` would delete a card that is live, in
    // use, and holding the jar its in-flight plays need to read their scores.
    const remaining = await withScorecards(
      "sc-cleanup-live",
      (store, storage) => {
        store.open("ancient-but-live", {});
        storage.sql.exec(
          "UPDATE arc_scorecards SET opened_at = ? WHERE card_id = 'ancient-but-live'",
          Date.now() - SCORECARD_RETENTION_MS - MINUTE
        );
        store.touch("ancient-but-live");
        store.cleanup();
        return [
          ...storage.sql.exec("SELECT card_id FROM arc_scorecards").raw()
        ].flat();
      }
    );
    expect(remaining).toEqual(["ancient-but-live"]);
  });
});
