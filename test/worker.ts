import { Agent } from "agents";

/**
 * The Worker under test.
 *
 * `@loopingai/plugins` is a library, not a Worker — but a `PluginStore` can only
 * be exercised against real `ctx.storage.sql`, which exists nowhere but inside
 * workerd. So this file is the minimal host that gives the pool something to
 * bind: one SQLite-backed Durable Object whose storage a spec can reach through
 * `runInDurableObject`.
 *
 * Deliberately thin, and deliberately carrying no plugin wiring. A plugin is
 * *composed* by an app, and the app that composes them is `looping-starter`;
 * anything richer than "somewhere to put a table" belongs there.
 */
export class TestAgent extends Agent<Cloudflare.Env> {
  /** The DO's raw SQLite, for a store's DDL and its drizzle handle. */
  storage(): DurableObjectStorage {
    return this.ctx.storage;
  }
}

export default {
  fetch: () => new Response("looping-plugins test host", { status: 200 })
} satisfies ExportedHandler<Cloudflare.Env>;
