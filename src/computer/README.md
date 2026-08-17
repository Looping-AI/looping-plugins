# `@loopingai/plugins/computer`

A Linux container whose filesystem outlives it.

```ts
import { computer } from "@loopingai/plugins/computer";

computer({
  binding: env.WORKSPACE,
  workspaceName: () => `${callerKey()}|${owner}/${repo}`,
  shell: "bash"
});
```

Tools: `sb_exec`, `sb_read`, `sb_write`, `sb_edit`, `sb_ls`, `sb_grep`, `sb_exists`.

The successor to `/sandbox`, and the difference is where the files live. A
`@cloudflare/sandbox` container held its work on a disk that died with it; keeping
anything meant snapshotting to R2, which needed S3 credentials a Workers binding
cannot supply. Here the filesystem **is** a Durable Object's SQLite, mounted into the
container over FUSE. Commands see a normal `/workspace`, the Worker reads the same
tree over RPC, and when the container is replaced the tree is pushed into the new one.

Install exactly one filesystem plugin. An agent holding this and
[`/workspace`](../workspace/) gives the model no way to know which one a path refers
to.

## `node_modules` is not in the workspace

The one thing to internalise. `computerd` excludes it from the sync by design, and the
exclusion is right: pushing a real one (429 MB, 22,470 files) into the object
reproducibly exceeded the Durable Object's 128 MB isolate limit, leaving the tree
silently short.

So dependencies live in the container and die with it, while source and `.git` are
durable. Two consequences: an install has to be re-run on a cold container, and the
file tools cannot see a path under `node_modules` even though a shell in the same
container can — they say so rather than reporting a missing file.

## `.git` is off limits

Present in the workspace, refused by the file tools anyway, and skipped by `sb_grep`
and recursive `sb_ls`. Reading it tells the model less than [`/repo`](../repo/) does,
and writing it corrupts the checkout. Repository work goes through the repo tools.

## Searching

`sb_grep` and `sb_ls` read the durable workspace rather than the container, so they
keep answering while it restarts or while dependencies install — which is exactly when
a subagent would otherwise be blocked. Both bound their results at the source and
report the `offset` that continues a cut one; `sb_read` takes a byte range for the
same reason, so nothing needs a shell to be reached.

## The host's Durable Object

`binding` points at a class that owns the workspace and exposes two methods:

- `__getWorkspaceStub()` — what `withWorkspace` from `@cloudflare/computer` installs.
- `installStatus()` — how the dependency install is going, or `{ state: "idle" }`.
  Required rather than optional: a host that installs but forgets to expose it would
  otherwise get an `sb_exec` running against a half-built `node_modules`.

One workspace is one container is one repository, so `workspaceName` should derive
from the verified caller and the repository — never from model input, or a model
naming another caller's workspace would get that caller's files.

Subagents reach the parent's checkout through `WORKSPACE_RUNTIME_KEY`: a subagent
execution has no caller identity and cannot compute the name itself, so the parent's
`resolveRuntime` puts it on the runtime state and every tool family reads it back.

`computerExec` exports the shell alone, for [`/repo`](../repo/) — so that plugin gets
git on a real container without either importing the other.

## wrangler.jsonc

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "WORKSPACE", "class_name": "Workspace" }]
  },
  // `new_sqlite_classes`, not `new_classes`: the filesystem is the DO's SQLite.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Workspace"] }]
}
```

The class also needs a container attached — see `@cloudflare/computer` for the image
and `containers` block, which are that package's contract rather than this one's.

## Requirements

The Workers **Paid** plan (containers), and `@cloudflare/computer` installed
alongside — it ships as an optional peer, so an agent that never runs code does not
carry it.

```bash
npm install @cloudflare/computer
```
