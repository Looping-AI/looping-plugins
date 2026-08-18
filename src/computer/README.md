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

The filesystem **is** a Durable Object's SQLite, mounted into the container over
FUSE. Commands see a normal `/workspace`, the Worker reads the same tree over RPC,
and when the container is replaced the tree is pushed into the new one — so the
checkout outlives the container that held it.

Install exactly one filesystem plugin. An agent holding this and
[`/workspace`](../workspace/) gives the model no way to know which one a path refers
to.

## `node_modules` is not in the workspace

The one thing to internalise. `computerd` excludes it from the sync by design, and the
exclusion is right: pushing a real one (429 MB, 22,470 files) into the object exceeds
the Durable Object's 128 MB isolate limit, leaving the tree silently short.

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

## The container is the trust boundary

Two things run in it that nobody reviewed: the commands the model writes, and the
repository it was asked to clone. `npm ci` executes that repository's lifecycle
scripts, so "we only ran the install" is still running a stranger's code. Treat
anything inside the container as reachable by both.

Two consequences worth stating outright:

- **No secret belongs in `ComputerConfig.env`.** It is merged into every command
  these tools run, and `sb_exec`'s command is model-authored — `sb_exec("printenv")` prints the lot,
  and so does a `postinstall`. Use it for a registry host or a `CI` flag, not a key.
  When an agent needs to _act_ with a credential, keep the credential on the Worker
  and give the agent one tool that makes the call:
  [`/repo`](../repo/)'s `repo_open_pr` is the worked example, and its token never
  enters the container at all.
- **Egress is unrestricted.** `@cloudflare/computer`'s `WorkspaceEgressPolicy` is
  `mode: "direct"` here, so anything in the container can reach anything on the
  network. That is deliberate for now — a build needs a registry, and a coding
  agent needs the web — but it means the two paragraphs above are the whole of the
  containment. Narrowing it to an allowed-host list, with a small classifier for
  the requests that fall outside, is possible future work rather than something
  this plugin does today.
- **`sb_grep`'s `regex` compiles a model-authored pattern** and runs it over every
  file under `path`, inside the Durable Object. A catastrophic-backtracking pattern
  therefore spends that object's CPU budget rather than the container's. The
  runtime's own limits bound it, and it costs the agent its own turn, but it is the
  one value a model supplies here that reaches a compiler.

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
git on a real container without either importing the other. What runs through it is
`/repo`'s **unauthenticated** half: `status`, `diff`, `add`, `commit`, `checkout`. The
three operations that authenticate — clone, fetch, push — never reach the container,
so no command here carries a forge token.

It does **not** merge `env` into what it runs, deliberately: those commands are
another plugin's, and it pins the git environment they need. A host environment
underneath would let through the keys it does not pin — `GIT_CONFIG_GLOBAL`,
`GIT_EXEC_PATH` — which change what git reads and which binaries it runs. A host
that wants one anyway composes it at the call site, where the merge is visible —
see the export's own comment.

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
