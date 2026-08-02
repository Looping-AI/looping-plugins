# `@loopingai/plugins/recall`

Episodic memory over Cloudflare Vectorize.

```ts
import { recall } from "@loopingai/plugins/recall";

recall({
  ai: env.AI,
  index: env.VECTORIZE,
  namespace: () => this.identityKey,
  aiGatewayId: "my-gateway"
});
```

When the Session compacts, the raw messages it folds into a summary would otherwise be lost.
Core announces that moment (`onMessagesDisplaced`) because core is what performs the lossy
operation; this plugin embeds the displaced range and upserts it, so a `recall` tool can
later semantically search history that has scrolled out of the live context window.

Core carries **no embedding code at all** — no `Embed` type, no `embeddingModelId`. It used
to, without a caller, which fixed the shape of embedding for every future plugin. The whole
embedding path lives here.

## Config

| Field              | Default           |                                                                                      |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------ |
| `ai`               | —                 | The `AI` binding, for embeddings. Built lazily.                                      |
| `index`            | —                 | The `VECTORIZE` binding. Must be **1024-dim, cosine**.                               |
| `namespace`        | —                 | **A thunk.** See below.                                                              |
| `aiGatewayId`      | —                 | Pass your agent's value so embedding calls stay correlated with chat calls.          |
| `embeddingModelId` | `@cf/baai/bge-m3` | Must match the index's dimension.                                                    |
| `topK`             | `5`               |                                                                                      |
| `metadataTextMax`  | `2000`            | Vectorize allows ~10 KiB of metadata per vector and the snippet is nearly all of it. |

### Why `namespace` is a thunk

It derives from the verified caller's identity, which is not known when `plugins(env)` runs
in `onStart`. The Durable Object is keyed 1:1 by that caller, so the value is constant once
known; a thunk is what lets the host supply it late while both hooks read the same one.

It is bound in code and never model input — that is the whole isolation boundary. One caller
can never read another's archive.

The `recall` tool is withheld until this caller's history has actually been compacted: before
that the archive is empty by construction, and a tool whose only possible answer is "nothing
yet" costs the model a call to find out and costs every round the tokens to describe it.

## wrangler.jsonc

```jsonc
{
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "agent-recall" }]
}
```

```bash
wrangler vectorize create agent-recall --dimensions=1024 --metric=cosine
```
