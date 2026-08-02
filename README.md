# @loopingai/plugins

**Optional, composable capabilities for Looping agents.**

One subpath per plugin, one factory per subpath, config passed at instantiation. Your bundle
grows only with what you import.

```bash
npm install @loopingai/plugins
```

> Part of a three-package split:
> [`@loopingai/core`](https://github.com/Looping-AI/looping-core) (the mandatory foundation) ·
> **`@loopingai/plugins`** (this) ·
> [`looping-starter`](https://github.com/Looping-AI/looping-starter) (a working agent that composes them).

---

## The one file you edit

```ts
// src/plugins.ts
import { arcAgi } from "@loopingai/plugins/arc-agi";
import { browser } from "@loopingai/plugins/browser";
import { recall } from "@loopingai/plugins/recall";

export const plugins = (env: Env, ctx: DurableObjectState) => [
  arcAgi({ apiKey: env.ARC_API_KEY, storage: ctx.storage }),
  browser({ binding: env.BROWSER }),
  recall({ ai: env.AI, index: env.VECTORIZE, namespace: () => callerKey })
];
```

Delete a line and that module leaves your bundle entirely. Nothing in core imports a plugin,
and there is **no root barrel** — `@loopingai/plugins` on its own does not resolve — so the
guarantee is structural rather than a tree-shaker's opinion. `npm run verify:exports` asserts
it on the built graph before every publish.

`plugins` is a function, not a module-level array: on Workers `env` does not exist at module
scope, and core's registry is built per Durable Object instance in `onStart()`.

```ts
this.runtime = createAgentRuntime({
  config,
  plugins: plugins(this.env, this.ctx),
  env: this.env // verify every plugin's declared bindings exist, at startup
});
```

---

## The plugins

| Subpath                        | What it adds                                                                          | Needs                         |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------- |
| [`/arc-agi`](src/arc-agi/)     | Play ARC-AGI-3 games — a delegable subtask type, a catalogue tool, a scorecard ledger | `ARC_API_KEY`                 |
| [`/browser`](src/browser/)     | Read web pages via Browser Rendering Quick Actions                                    | `BROWSER` (paid plan)         |
| [`/recall`](src/recall/)       | Episodic memory over Vectorize — search history that compaction folded away           | `VECTORIZE` (1024-dim/cosine) |
| [`/triage`](src/triage/)       | A pre-turn gate: is this message even for me?                                         | —                             |
| [`/workspace`](src/workspace/) | A durable file store for long subagent runs, plus tools over it                       | `@cloudflare/shell`           |

Each directory has its own README with the config shape and a paste-ready `wrangler.jsonc`
snippet — a plugin cannot add its own binding, which is why it declares what it needs.

---

## Writing one

```ts
import { definePlugin, type AgentPlugin } from "@loopingai/core";

export function scraper(config: { apiKey: string }): AgentPlugin {
  return definePlugin({
    key: "scraper",
    mainAgentTools: () => ({ fetchPage: /* … */ }),
    capability: "You can fetch and summarize a page.",
    requires: { secrets: ["SCRAPER_API_KEY"] }
  });
}
```

Three rules the whole design rests on:

- **Never name a consumer's `Env`.** It is an ambient interface `wrangler types` generates
  into _their_ app. Take bindings and secrets as config, which is also the only thing that
  works on Workers, where `env` has no module scope.
- **`definePlugin` sets `contractVersion`** from the core you compiled against. Never write
  that number as a literal — the point is that it moves, so a version train that leaves one
  repo behind fails at startup with a sentence instead of a structural-type error.
- **Declare a capability block in exactly one place.** If your plugin has a `subtaskType`, put
  it there; otherwise on the plugin. Both are rendered, by different call sites.

## Testing

Specs run inside real workerd via `@cloudflare/vitest-pool-workers`, with the harness from
`@loopingai/core/testing`. Two peer versions are pinned rather than open, because both fail
unreadably — see [PLAN.md](PLAN.md#the-two-version-pins-that-are-not-preferences).

```bash
npm test          # 222 specs
npm run check     # prettier + eslint + tsc + build
npm run verify:exports
```

## License

GPL-3.0-only
