# looping-plugins — plan

> Sibling repos: [`looping-core`](https://github.com/Looping-AI/looping-core) ·
> [`looping-starter`](https://github.com/Looping-AI/looping-starter)

**Status: built.** Five subpaths, ported from the two predecessor repos, 222 specs green
including a recorded VCR cassette against the live ARC API. What remains is the starter.

## What this repo is

`@loopingai/plugins` — independent capability modules for Looping agents. One subpath export
per plugin, config passed at instantiation.

**The promise:** a project's bundle grows only with what it actually imports, never with
the size of this library. That promise is structural (no root barrel, no `core → plugin`
imports), not a tree-shaker's opinion — and `npm run verify:exports` proves it on the built
graph before every publish.

**Rule of admission.** A module belongs here if an agent can sensibly _not_ have it.
Anything mandatory is `@loopingai/core`. Anything opinionated is the starter's.

---

## The contract

Each subpath exports **one factory taking config, never `env`**:

```ts
// src/browser/index.ts
export function browser(config: { binding: QuickActionBinding }): AgentPlugin;
```

Config-at-instantiation is deliberate on two counts: `Env` is the ambient global
`wrangler types` generates into `worker-configuration.d.ts` and a published package cannot
reference it; and on Workers `env` doesn't exist at module scope anyway — the same
constraint that forces core's runtime registry. One design, both problems.

Everything comes from `@loopingai/core` itself — there is **no `/contract` subpath**:

```ts
import { definePlugin, type AgentPlugin } from "@loopingai/core";
```

`definePlugin` pins `contractVersion` from the core the plugin compiled against. Never write
that number as a literal; the point is that it moves.

```ts
interface AgentPlugin<TRuntime = SubtaskRuntime> {
  key: string;
  contractVersion: number; // definePlugin sets this

  // subagent side
  subtaskType?: SubtaskTypeSpec;
  toolFamilies?: Record<string, ToolFamilyBuilder<TRuntime>>;

  // main-agent side
  mainAgentTools?: (ctx: MainAgentToolContext) => ToolSet | Promise<ToolSet>;
  capability?: string;

  // parent-DO lifecycle hooks
  resolveRuntime?: (ctx: ResolveRuntimeContext) => Promise<TRuntime>;
  enrichResult?: (ctx, result) => Promise<RecipeExecutionResult>;
  onAbort?: (ctx: ResolveRuntimeContext) => Promise<void>;

  // session lifecycle
  shouldHandleTurn?: (ctx: TurnGateContext) => Promise<boolean>;
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>;

  // storage, workspace + requirements
  store?: PluginStore;
  workspaceBacking?: (sql, name) => WorkspaceBacking;
  requires?: { secrets?: string[]; bindings?: string[] };
}
```

### Not every subpath is a plugin

`/triage` and `/workspace` export a factory **and** plain functions, because part of what
they own does not fit any hook: triage's `no_reply` needs turn-local loop state
(`prepareStep`/`stopWhen` over `repliedAny`), and a host assembling its own `SubagentRuntime`
may want `durableWorkspaceBacking` directly. Say so rather than pretending the contract
covers everything.

### Where a capability block goes

`AgentPlugin.capability` and `SubtaskTypeSpec.capability` are rendered by **different call
sites** (`runtime.renderCapabilities()` and `runtime.types.renderCapabilities()`). A plugin
that declares a subtask type must put its block on the **type** and leave the plugin's unset,
or the main agent reads the same advice twice per round — the exact drift the type's prompt
fields were introduced to end. Tool-only plugins use `plugin.capability`.

---

## Packaging rules — non-negotiable, or isolation silently rots

1. **Subpath `exports` per plugin. No root barrel.** There is no `@loopingai/plugins` import;
   only `@loopingai/plugins/<name>`.
2. **`"sideEffects": false`.**
3. **Heavy/unique deps are optional peers** — `@cloudflare/shell`. Cheap here: nearly every
   plugin is pure code.
4. **Zero `core → plugins` imports.** Plugins import core type-only wherever possible.
5. **A plugin's module graph stays inside its own directory.** A helper used by exactly one
   plugin lives _inside_ that plugin — which is why grid analysis is internal to `/arc-agi`
   rather than a subpath of its own. (The predecessor plan said "declare it an optional peer",
   which is unworkable: they are the same package.)
6. **`verify:exports` proves 1, 5 and realm isolation** on the built `dist/` graph, at
   `prepack` and `prepublishOnly`. A cross-plugin re-export typechecks, lints and tests
   perfectly while quietly doubling every consumer's bundle; only a check on the built graph
   catches it.

---

## Plugin-owned storage — drizzle for queries, hand-written DDL

What a plugin cannot share is the **migrator**. `drizzle-orm/durable-sqlite/migrator` keeps
one flat integer journal and one global `__drizzle_migrations` table, and two
independently-versioned packages cannot share that index space — the two predecessor agents,
both consuming the same `notify_tasks` module, had already forked it at index 1
(`0001_unusual_nova` vs `0001_great_goliath`). And `drizzle-kit generate` diffs against a
snapshot in a single `out` dir, so a plugin in its own repo cannot produce a correct diff.

**None of that touches the query builder.** `drizzle(storage, { schema })` is a typed wrapper
over the same `DurableObjectStorage`, holding no journal and no connection state. So the rule
is one import, not a whole library:

- Declare tables with `sqliteTable`, under the plugin's own prefix (`arc_scorecards`).
- Emit idempotent `CREATE TABLE IF NOT EXISTS` in `PluginStore.ensureTables` — core re-runs
  it on every hibernation wake-up.
- Query through drizzle. A second handle beside core's `AgentDB` is safe.
- **Never import `drizzle-orm/durable-sqlite/migrator`.** An eslint `no-restricted-imports`
  rule states that where it cannot be forgotten.

Cost, stated plainly: ~8 lines of DDL per table, written by hand and kept in step with the
declaration beside it. `store.spec.ts` pins that they agree, against real SQLite in a real
Durable Object — which is the only thing that can say.

---

## The five

Paths are relative to `../reactive-agent` (R) and `../proactive-agent` (P).

| Subpath      | Source                                                       | Requires                             | Notes                                                                                                   |
| ------------ | ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `/browser`   | `R:src/agent/tools.ts` browser family                        | `BROWSER` (paid plan)                | ~60 lines, one optional peer. The packaging proof — shipped first, before any contract complexity       |
| `/arc-agi`   | `R:src/recipes/arc-game/*` + `R:src/db/models/scorecards.ts` | `ARC_API_KEY`; owns `arc_scorecards` | The stress test. Two lifecycle hooks, a `PluginStore`, the VCR cassette, and grid analysis internalized |
| `/workspace` | `R:src/subagent/workspace.ts` + `R:src/agent/tools.ts`       | —                                    | ~65 lines across two files. Everything else already ships in core                                       |
| `/recall`    | `R:src/agent/recall.ts` + `R:src/agent/model.ts`             | `VECTORIZE` (1024-dim/cosine)        | Owns its whole embedding path; namespace is a thunk                                                     |
| `/triage`    | `P:src/agent/triage.ts` + `P:src/agent/tools.ts`             | —                                    | Harvested from the deprecated proactive repo; reactive has no analog                                    |

`/arc-agi` has **no `onAbort`**: nothing closes a scorecard any more — the API retires an idle
card on its own — so an abandoned play needs no cleanup. Declaring an empty hook would imply
otherwise.

---

## What this cost core (0.1.2)

Three capabilities the v1 contract had no hook for, plus two harness bugs.
`PLUGIN_CONTRACT_VERSION` stayed at **1**: the rule against re-typing exists to protect a
_published_ plugin from a structural-type error several frames from its cause, and no plugin
had been published.

- **`shouldHandleTurn`** — the pre-turn gate `/triage` is. AND across plugins, fails open.
- **`workspaceBacking`** — `/workspace` had no way to deliver core's one missing backend.
  At most one plugin may declare it; core falls back to `memoryWorkspaceBacking`.
- **`mainAgentTools(ctx)`, possibly async** — `/recall` gates its tool on
  `await ctx.session.getCompactions()`.
- **`cassetteNameFor`** named cassettes after the developer's home directory for any spec
  outside `test/` (`.pop()` of a split that never matched returns the input unchanged).
- **The VCR harness pinned its test-runner peers.** See below — it cost an afternoon, and
  core 0.3.0 removed both pins.

---

## The two version pins that are not preferences — both now gone (core 0.3.0)

They were real, they each cost an afternoon, and they are recorded here because the
_shape_ of the failure recurs even though these two instances are fixed.

**`@cloudflare/vitest-pool-workers@^0.18`.** The VCR recorder installed as Miniflare's
`fetchMock`, an option Miniflare 5 dropped and pool 0.20 removed from its overrides. An
unknown key in `miniflare` is **ignored rather than rejected**, so on a newer pool nothing
intercepted anything: `disableNetConnect()` never applied, every request hit the real
network, and each one failed as `internal error; reference = …` naming nothing at all.

**`undici@7.28.0`.** `fetchMock` was validated with `instanceof MockAgent` against
Miniflare's _own_ undici, so two copies in one `node_modules` failed with `Input not
instance of MockAgent`.

Core 0.3.0 moved the recorder onto `outboundService` — the hook `fetchMock` was one line of
sugar over, identical in Miniflare 4 and 5, with no `instanceof` check in either direction.
Both pins went with it: the pool peer is `>=0.18` and core declares no `undici`.
`setupRecording()` also asserts the recorder answered before a test runs, so a silently
ignored option now fails by name instead of as an unnamed internal error.

Cassettes changed too, and for the same reason: they now match on method + URL + body and
never on headers. The old key hashed every non-excluded request header, including
`cf-worker` and `user-agent: undici`, so a committed cassette stopped matching the moment
miniflare or workerd changed what it sent — version-locking the whole suite.

A corollary for local development still stands: **install core from a tarball, not a
symlink.** A `file:` dependency is a symlink, Vite resolves through realpath, and core's
imports then land in _its_ `node_modules` while this package's land in ours — two copies of
`agents`, which breaks `instanceof` and makes `Session`/`SessionMessage` two unrelated
types. `npm pack` in core, `npm i --no-save ../looping-core/loopingai-core-*.tgz` here.

### The cassette this repo owns

`test/arc-agi/recorded.spec.ts` replays a committed cassette, re-recorded from scratch
against the live API when core 0.3.1 dropped the old format:

```bash
npm run test:record      # real ARC_API_KEY in .env.test, currently-listed RECORD_GAME
```

The old cassette could not be converted. undici's recorder keyed on `String(opts.body)`, and
a Worker's POST body reaches the dispatcher as a `ReadableStream`, so **every POST in it
stored the literal `[object ReadableStream]` instead of its payload** — bodies that were
simply not in the file. Such entries could only ever be matched on method + URL alone, which
meant the old harness **could not tell two POSTs to one URL apart**: its single
`POST /api/cmd/RESET` entry held two responses for resets of two _different_ games, replayed
by call order. The new one has two entries with distinct bodies. That difference is the whole
point of the format change.

**`.env.test` only reaches Node, so the key needs an explicit binding.** `vitest.config.ts`
loads the file into `process.env` — but a spec runs in **workerd**, which has no
`process.env`, so the value has to be handed across as a Miniflare binding
(`miniflare.bindings.ARC_API_KEY`). Without that line the spec reads `env.ARC_API_KEY` as
`undefined`, falls back to `"replay-only"`, and every recording attempt dies on an ARC auth
error however valid the key is. Miniflare also picks a key up from a `.dev.vars` beside
`wrangler.jsonc` on its own — that is how the first cassette was recorded, and relying on it
is what left `.env.test` wired to nothing.

Two more things when re-recording. `RECORD_GAME` must name a game the ARC catalog currently
lists — assertions are on response _shape_, not exact values, so a different game does not
churn them. And the key never reaches the file: `excludeHeaders` drops `x-api-key` and the
cookie jar on the way in, which is why playback needs no credentials at all.

---

## Verification

- `npm run check` — prettier, eslint (including the type-aware `no-deprecated` pass and the
  migrator ban), `tsc`, build. `npm test` alone typechecks nothing.
- `npm test` — 222 specs in real workerd.
- `npm run verify:exports` — subpaths resolve, no spec reached `dist/`, no missing `.js`
  extension, realms isolated, **and no plugin's graph leaves its own directory**.
- `/arc-agi` replays its recorded cassette hermetically, with no `ARC_API_KEY` configured —
  the key header is excluded from the snapshot, which is what makes it safe to commit.

The remaining proof is `looping-starter`: three example bundles, cross-plugin absence at the
bundler level, size budgets, and a live ARC game.
