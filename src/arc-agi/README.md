# `@loopingai/plugins/arc-agi`

Play [ARC-AGI-3](https://arcprize.org) games.

```ts
import { arcAgi } from "@loopingai/plugins/arc-agi";

arcAgi({ apiKey: env.ARC_API_KEY, storage: this.ctx.storage });
```

The stress test for the plugin contract, and the reason three of its hooks exist. In the
predecessor these were four leaks in the agent's Durable Object — `resolveRuntime`,
`arcScorecardDeps`, `leaseScorecard`/`leasePlay`, and `enrichResult` — each a piece of
ARC-specific policy living in code that had no other reason to know what a scorecard was.

What the split makes visible: the only thing the agent still knows is that it installed a
plugin. Nothing in a loop, a workflow, or a DO names a card, a guid, or a game.

## What it contributes

|                  |                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `subtaskType`    | `arc-game`, taking one param: `game_id`. Carries both prompt blocks — capability and delegation guidance — so they cannot drift apart. |
| `mainAgentTools` | `arc_list_games`, the catalogue and nothing else.                                                                                      |
| `toolFamilies`   | `arc-game` — act/inspect against the REST API, session state in the workspace.                                                         |
| `resolveRuntime` | Leases the card and the play, once per **chunk**.                                                                                      |
| `enrichResult`   | Appends the score, read from the card once the play is done.                                                                           |
| `store`          | `arc_scorecards`, a recency ledger.                                                                                                    |

## Config

| Field                                | Default      |                                                                                                                                                                                     |
| ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                             | —            | `ARC_API_KEY`. Closed over, never model input.                                                                                                                                      |
| `storage`                            | —            | `this.ctx.storage`. `DurableObjectStorage`, not `SqlStorage` — the query side builds a drizzle handle over it.                                                                      |
| `primaryModelId` / `fallbackModelId` | your agent's | A _preference_: `validateRecipe` substitutes your configured model for any id outside its allowlist. Pass one only to deliberately run a play somewhere other than your chat model. |

## Storage

Owns one table, `arc_scorecards`, outside core's migration journal. Register the store:

```ts
new AgentDB(this.ctx.storage, {
  maxSubtasks: runtime.config.maxSubtasks,
  stores: runtime.stores
});
```

Rows hold a card id and its cookie jar — no score, which is read back from the API on demand
— so they are safe to sweep. `makeScorecardStore(storage).cleanup()` deletes cards past 30
days; scheduling that is the host's, since a plugin cannot add a cron.

## wrangler.jsonc

```bash
wrangler secret put ARC_API_KEY
```

No bindings beyond core's own. Startup fails with a readable message if the secret is missing
— pass `env` to `createAgentRuntime` to switch that check on.

## Grid analysis

The ~1,000-line grid-diff / connected-components / shape-tracking module lives **inside** this
plugin rather than beside it. It names ARC nowhere and operates on plain `number[][]`, so it
is genuinely generic — but only arc-agi consumes it, and a separate subpath would have been
a package boundary invented for one caller. If a second grid domain ever appears, promoting
it is a one-line `exports` addition.
