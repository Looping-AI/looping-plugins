import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { existsSync } from "node:fs";
import path from "node:path";
import { createVcr, recordFromEnv } from "@loopingai/core/testing/node";

/**
 * Specs run **inside workerd**, not Node.
 *
 * Most of what lives here is pure and would run anywhere, but two things are not:
 * a `PluginStore` drives `ctx.storage.sql`, and the recorded ARC spec issues real
 * `fetch` calls that have to flow through Miniflare to reach the VCR recorder. So
 * the pool boots the real runtime with the Durable Object declared in
 * `wrangler.jsonc`, and `test/worker.ts` is the host that owns it.
 */

// Real secrets for `npm run test:record`, loaded from a local, gitignored
// .env.test so recording never requires pasting a key on the shell. Values
// already in process.env (CI/shell) win — Node's loader never overwrites an
// existing var. A no-op when the file is absent, which is the ordinary case:
// playback needs no key at all.
const ENV_TEST = path.resolve(import.meta.dirname, ".env.test");
if (existsSync(ENV_TEST)) process.loadEnvFile(ENV_TEST);

/**
 * One recorder serves the whole suite. It record/replays per-test cassettes,
 * announced by each recorded spec over an in-band control channel — the spec
 * runs in workerd and has no filesystem, so it cannot reach the recorder any
 * other way. Generic: recorded specs key their own cassettes per test, so adding
 * one touches only that spec file, never this config.
 *
 * `recordFromEnv()` is `RECORD=1`, compared rather than coerced — every
 * non-empty string is truthy, so `RECORD=0` and `RECORD=false`, the two things
 * someone reaches for to turn recording *off*, would otherwise turn it on and
 * overwrite committed cassettes with live traffic.
 *
 * `excludeHeaders` is the reason a committed cassette is safe: the ARC API key
 * never reaches the snapshot file, which is also why playback works with no key
 * configured at all.
 *
 * There is no `disableNetConnect()` any more. A request with no active cassette
 * is blocked by default and names itself, instead of failing as an unnamed
 * `internal error; reference = …`.
 */
const vcr = createVcr({
  snapshotsDir: path.resolve(import.meta.dirname, "./test/snapshots"),
  record: recordFromEnv(),
  excludeHeaders: ["x-api-key", "cookie", "set-cookie"]
});

// Placeholder so the pool has something to source `ARC_API_KEY` from. A real key
// in .env.test takes precedence and is what `npm run test:record` needs.
process.env.ARC_API_KEY ??= "test-key";

export default defineConfig({
  resolve: {
    /**
     * Force one copy of every shared peer.
     *
     * `@loopingai/core` is installed as `file:../looping-core` for the inner
     * loop, which npm satisfies with a symlink — and Vite resolves through
     * realpath, so core's imports land in *its* `node_modules` while this
     * package's land in ours. Two copies of `agents` in one Worker breaks
     * `instanceof` and makes `Session`/`SessionMessage` two unrelated types,
     * which is precisely the failure a published install cannot have and a
     * linked checkout silently can.
     *
     * Harmless once core is installed from the registry, where these hoist anyway.
     */
    dedupe: ["agents", "ai", "zod", "drizzle-orm", "workers-ai-provider"]
  },
  plugins: [
    cloudflareTest({
      // Bindings come from the one wrangler config, so the test host and the
      // snippets in each plugin's README cannot drift apart.
      wrangler: { configPath: "./wrangler.jsonc" },
      // Required, not merely the documented default: Workers AI has no local
      // execution mode, so leaving this unset makes the pool eagerly establish a
      // remote connection per test file — seconds of startup plus a reproducible
      // teardown hang.
      remoteBindings: false,
      // The hook Miniflare 4 and 5 both have. `fetchMock` was removed in pool
      // 0.20, and an unknown key here is ignored rather than rejected — which
      // is exactly how the previous wiring failed silently.
      miniflare: { outboundService: vcr.outboundService }
    })
  ],
  test: {
    // Node realm. Flushes cassettes and stops the recorder after the run;
    // without it a `RECORD=1` run hangs on open sockets.
    globalSetup: ["@loopingai/core/testing/vcr-global-setup"],
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"]
  }
});
