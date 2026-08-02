# `@loopingai/plugins/triage`

Decide whether an inbound message deserves a reply **before** the tool loop runs.

```ts
import { triage } from "@loopingai/plugins/triage";

triage({ ai: env.AI, aiGatewayId: "my-gateway" });
```

An agent in a shared channel sees every message, and most are not for it. Left to the main
loop, that judgement is made by a model simultaneously trying to be helpful, with memory,
history and half a dozen tools in view — and it degrades exactly there, and degrades
**invisibly**: failing to call a decline-tool looks identical to deciding not to.

A structured-output call has no "just answer instead" escape hatch — the schema must be
filled — so the question is always actually asked.

**Fails open.** A classify failure answers `true`. The two mistakes are not symmetric: a
wrong reply is noise the user can see and ignore, while a wrong silence is invisible to the
person who needed an answer.

## Config

| Field             | Default                      |                                                                                        |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `ai`              | —                            | The `AI` binding. Read lazily, never at module scope.                                  |
| `aiGatewayId`     | —                            | Pass your agent's value so classify calls stay correlated with chat calls.             |
| `modelId`         | `@cf/qwen/qwen3-30b-a3b-fp8` | Small and fast. No fallback: triage fails open, so a retry buys nothing.               |
| `historyMessages` | `12`                         | A bare message is often unclassifiable — "yes", "thanks" only resolve against context. |
| `messageMaxChars` | `500`                        | Keeps the classify call small.                                                         |

## Declining _late_

The gate judges the message. Sometimes an agent only discovers there is nothing worth adding
after looking something up — so this subpath also exports the pieces for a `no_reply` tool:

```ts
import {
  noReplyTool,
  isNoReplyTurn,
  NO_REPLY_TOOL_NAME
} from "@loopingai/plugins/triage";
```

Wiring is your loop's: offer the tool until the agent has spoken, withdraw it after, and stop
the run when `isNoReplyTurn(repliedAny, steps)` holds. That `repliedAny` flag is
load-bearing — hiding a tool only hides it, and the SDK still resolves a call against the
unfiltered map, so a model that names `no_reply` after speaking would otherwise discard a
turn the user has already seen.

## wrangler.jsonc

Only core's own `AI` binding. This plugin declares no `requires` of its own — doing so would
report a core misconfiguration under this plugin's name.
