import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { doStorage, makeDoHelpers } from "@loopingai/core/testing";
import {
  arcScorecardStore,
  makeScorecardStore,
  type ArcScorecardStore
} from "../../src/arc-agi/store.js";

/**
 * Real SQLite, in a real Durable Object, for the `arc_scorecards` specs.
 *
 * The store is the one part of this plugin that cannot be tested against a fake:
 * its whole point is that hand-written DDL and drizzle-built queries agree about
 * a table, and only workerd's SQLite can say whether they do. Everything above
 * it — the scorecard *policy* — takes the narrow `ScorecardStore` port and is
 * tested against `memStore` with no DO at all.
 */

const ns = (env as unknown as { TEST_AGENT: DurableObjectNamespace })
  .TEST_AGENT;

export const { freshStub } = makeDoHelpers(ns);

/**
 * Run `fn` against a store in a fresh DO, with the plugin's DDL already applied.
 *
 * `from: 0` is the first-ever run, which is what a new consumer gets. The
 * version bookkeeping itself is core's (`plugin_migrations`), not re-tested here.
 */
export function withScorecards<T>(
  label: string,
  fn: (store: ArcScorecardStore, storage: DurableObjectStorage) => T
): Promise<T> {
  return runInDurableObject(freshStub(label), (instance) => {
    const storage = doStorage(instance);
    arcScorecardStore.ensureTables(storage.sql, 0);
    return fn(makeScorecardStore(storage), storage);
  });
}

/** Same, but hands over raw storage before any DDL has run. */
export function withStorage<T>(
  label: string,
  fn: (storage: DurableObjectStorage) => T
): Promise<T> {
  return runInDurableObject(freshStub(label), (instance) =>
    fn(doStorage(instance))
  );
}
