# `@loopingai/plugins/claude-code`

Subtasks that run the **Claude Code CLI** inside the agent's workspace container,
against the durable checkout.

## Why this exists

A Claude **subscription** credential does not work for raw Messages API calls on
a frontier model. Every Opus call returns `429` in ~10 ms at zero tokens, and
Sonnet follows; Haiku 4.5 is the sole exception, and it rejects the
`output_config.effort` field a reasoning agent is built around. Holding two
credentials on separate accounts does not clear it — both refuse the same request.

The same credential, sent by the Claude Code client, succeeds: Opus 5, Sonnet 5
and Haiku 4.5 all answer, at `service_tier: standard`. **The harness is the
unlock, not the credential.** So the way to reach those models on a subscription
is to run the sanctioned client, which is what this plugin makes delegable.

## The shape: one subtask type, no tools

Unusual for this package, and it is the whole design. Claude Code brings its own
tools, its own loop and its own context management, so there is nothing for
core's resumable runner to drive. The plugin declares a subtask type; the host's
subagent overrides `executeChunk` and drives a session instead.

**One Looping subtask is one `claude -p` session.** Not one turn, and not one
tool call — the unit has to be substantial, because of what an invocation costs
before it does anything (see [Costs](#costs)).

Two nested notions of "subagent" that must never be conflated:

|                                | Looping subtask                                | Claude Code subagent          |
| ------------------------------ | ---------------------------------------------- | ----------------------------- |
| Durable                        | yes                                            | no                            |
| Visible to Looping's scheduler | yes                                            | **no**                        |
| Cancellable by Looping         | yes                                            | **no**                        |
| Bounded by                     | `timeoutMs`, enforced by the container runtime | `CLAUDE_CODE_MAX_*`, advisory |

## The credential never enters the container

The container is an arbitrary-code-execution environment by design: `npm ci` runs
whatever `postinstall` a cloned repository ships, and the agent runs that
repository's own build and test commands. So nothing secret goes in it.

The session launches with `CREDENTIAL_PLACEHOLDER`. `computerd` intercepts every
outbound request and hands it to `claudeCodeEgress` on the **Worker** side, which:

1. **swaps** the placeholder for a real credential, for `api.anthropic.com` only;
2. **strips** every credential header from anything else;
3. optionally **restricts the container to named hosts** — exact hostname match,
   no wildcards, and **off by default** (see below);
4. **rotates** to the next credential when Anthropic says the current one's
   bucket is spent (see below).

A `postinstall` that dumps the environment learns the placeholder and nothing else.

### Egress is unrestricted by default

`restrictToHosts` is three-way, and each value means literally what it says:

| Value                    | Effect                         |
| ------------------------ | ------------------------------ |
| omitted                  | unrestricted — **the default** |
| `["registry.npmjs.org"]` | that host, plus Anthropic      |
| `[]`                     | Anthropic only                 |

An empty array is deliberately _not_ the same as omitting the field: a host
computing the list from config that happens to produce `[]` means "nothing
extra", and reading that as "everything" would hand the widest policy to an
expression that returned nothing.

Open is the default because a curated list is permanently wrong for a coding
agent — `esbuild`, `swc` and `sharp` fetch prebuilt binaries from release CDNs,
Playwright downloads browsers from a third host, corepack fetches package
managers, and reading documentation is part of the job. It also matches
[`/computer`](../computer/), whose egress has always been unrestricted.

**What that gives up is a bound on exfiltration**, and it is worth being plain
about: the container holds the checkout and, unrestricted, can send it anywhere.
It does not weaken the credential — the swap is keyed on the destination and
credential headers are stripped from everything else, whatever the policy says.
So the containment here is _"the container holds no credential"_, and nothing
more. Set `restrictToHosts` if you want the other property; do not assume it.

One rule applies regardless of policy: hosts naming the gateway's **own** side
of the boundary — `computer.internal` and loopback — are always refused. Under
`mode: "direct"` the container's traffic leaves from the container's network
position; under `http-gateway` **the Worker makes the request**, so an
unrestricted policy hands the container the Worker's reach, and bouncing a
request back into the loopback the intercept rides on is never legitimate.

Nothing sets `ANTHROPIC_BASE_URL`. The intercept is transparent, so the client
talks to the real hostname — which means nothing in the container is _told_ to
use a proxy, and nothing in the container can be told not to.

### The 5-hour and weekly limits: rotate, do not predict

A Claude subscription has a rolling 5-hour bucket and a weekly one. Neither is
readable, and an earlier version of this package tried to stay under them by
_estimating_ spend — a dollar counter, a cap, and a gate that refused to start
work when the counter got high. That was the wrong instrument twice over: the
estimate is a guess about a bucket nobody can see, and it only moved when a run
_ended_ (usage is learned from the terminal `result` event), so it was never a
cap on spend at all — only a gate on starting.

The gateway sees Anthropic's actual response, which is the one place the bucket
announces itself, exactly, the moment it is empty. So the credential is a
**pool**:

```
429 (reset 4h out)  →  mark entry 0 spent until its reset
                    →  the lead becomes entry 1
                    →  return the 429 with `retry-after: 1`
                    →  Claude Code's own retry lands on entry 1
```

The `retry-after` rewrite is what turns the client's existing retry into the
rotation, and it is why nothing here buffers a request body. Left at the
upstream's value — four hours — the client would sleep inside the container
holding a chunk open, which is a stall rather than a rotation.

Three behaviours are worth knowing before you rely on it:

- **A short `retry-after` is not exhaustion.** Under a minute is read as an
  ordinary slow-down and forwarded untouched. Rotating on a speed bump would
  retire a working credential for whatever window the header named, and with a
  small pool two of those would empty it.
- **A `401`/`403` retires an entry for good**, rather than until a reset — a
  revoked credential does not heal on a timer. The response is rewritten to a
  `429` on the way out, because a client does not retry a `401` and would
  otherwise fail the run on a credential the gateway has already stopped using.
- **When every entry is spent**, the real wait goes through: a `429` naming the
  earliest reset, so the run ends cleanly having said when to come back. When
  every entry is _rejected_ it is a `500` instead, because that one needs an
  operator and a `429` would hide it behind a retry loop.

State lives wherever the host's {@link CredentialStore} puts it. Keeping it in
the workspace Durable Object's own storage is the intended shape: each workspace
learns a rotation independently, which costs one wasted `429` per workspace per
rotation and saves a Durable Object class, a binding and a migration.

> **The detection rules are inferences, not observations.** No genuine
> subscription-exhaustion `429` has been captured through this path — the
> ones seen during development were the _raw-API_ refusal, which is a different
> response — so `readRefusal` reads `retry-after`, then
> `anthropic-ratelimit-unified-reset`, then falls back to a long default. The
> gateway logs every `401`/`403`/`429` whole, headers and body, precisely so the
> first real one can replace the inference with a fact.

## What the host must provide

```jsonc
// wrangler.jsonc
{
  "containers": [
    {
      "class_name": "ClaudeCoderWorkspaceDO",
      "image": "./Dockerfile",
      // A Docker build arg. One Dockerfile serves both the plain workspace and
      // this one; only the entry naming a version gets the CLI.
      "image_vars": { "CLAUDE_CODE_VERSION": "2.1.238" },
      "instance_type": "standard-2",
      "max_instances": 5
    }
  ],
  // The container is bound to a Durable Object, and the class has to exist as
  // well as be named. Both of these are required: without the binding the
  // backend has nothing to dial, and without the migration the class is never
  // created — which surfaces at runtime, not at deploy time.
  "durable_objects": {
    "bindings": [
      {
        "class_name": "ClaudeCoderWorkspaceDO",
        "name": "CLAUDE_CODER_WORKSPACE"
      }
    ]
  },
  // `new_sqlite_classes`, not `new_classes`: the workspace filesystem *is* the
  // object's SQLite. And a **new tag** — a class appended to a tag you have
  // already deployed is silently never created.
  "migrations": [
    { "tag": "v5", "new_sqlite_classes": ["ClaudeCoderWorkspaceDO"] }
  ],
  // The pool, in priority order. One is valid; more is what makes rotation
  // worth having.
  "secrets": {
    "required": ["CLAUDE_CODE_OAUTH_TOKEN_1", "CLAUDE_CODE_OAUTH_TOKEN_2"]
  }
}
```

The class must also be exported from the Worker entry point, along with
`WorkspaceProxy` from `@cloudflare/computer` — the container dials back through
it, and dropping that export breaks the container with no compile error.

Pin the CLI version deliberately: the wire shape this package's gateway and
parser are both written against is version-coupled, so re-run the smoke test on
every bump.

The workspace Durable Object installs the gateway as its egress policy:

```ts
readonly #session = claudeCodeSession({
  // Order is priority. One entry is fine; `.filter(Boolean)` lets a deployment
  // leave the second secret unset.
  credentials: () =>
    [
      this.env.CLAUDE_CODE_OAUTH_TOKEN_1,
      this.env.CLAUDE_CODE_OAUTH_TOKEN_2
    ].filter(Boolean),
  // How a delegated session finds this workspace — see below.
  workspaceName: () => this.#name(),
  // Omit for unrestricted, which is the default.
  restrictToHosts: ["registry.npmjs.org"]
});

/** The pool's `{ index → resetAt }` map, in this object's own storage. */
readonly #credentials: CredentialStore = {
  read: async () => (await this.ctx.storage.get(CREDS_KEY)) ?? [],
  write: (states) => this.ctx.storage.put(CREDS_KEY, states)
};

readonly backend = new CloudflareContainerBackend({
  container: () => this,
  workspace: { binding: "CLAUDE_CODER_WORKSPACE", id: this.ctx.id.toString() },
  egress: {
    mode: "http-gateway",
    gateway: this.#session.egress(this.#credentials)
  }
});
```

`egress` takes the store as an **argument** rather than reading it off the
config, and that is deliberate: the same config object is also held by the
parent's plugin list and by the subagent facet, and neither of those has
storage. Making it a field would force both of them to invent one.

> **`mode: "http-gateway"` intercepts _all_ egress**, so a restriction you do
> configure is load-bearing for `npm ci` too. A restricted gateway that forgets
> the registry does not degrade the agent — it stops the container installing
> anything. This is the main reason the default is open.

And the subagent drives the session:

```ts
protected override async executeChunk(...): Promise<RecipeChunkResult> {
  const outcome = cursor
    ? await session.resume(runtime, cursor)
    : await session.start(runtime, subtaskId, prompt, dir);

  if (!outcome.done) return { done: false, progress: outcome.progress };
  return { done: true, progress: outcome.progress, result: report(outcome) };
}
```

`DrainCursor` is the only state, and the caller persists it. A fresh isolate
resumes from the exact event sequence the last one consumed.

**`subtaskId` namespaces the exec id, and it is not optional.** Subtasks are a
flat concurrent fan-out and a workspace is one container, so two sessions
sharing an id would spawn over each other, each drain would attach to whichever
won, and `stop` would kill the wrong one.

**`runtime` is where the workspace name comes from**, and it is the reason
`workspaceName` is on the config:

```ts
const name = runtime?.[WORKSPACE_RUNTIME_KEY] as string | undefined;
const stub = env.CLAUDE_CODER_WORKSPACE.get(idFromName(name));
using ws = await getWorkspace(stub); // ws.runtime satisfies SessionRuntime
```

The plugin's `resolveRuntime` writes it on the **parent**, where the verified
caller is known; core dispatches that hook to whichever plugin declared the
subtask type, which is this one, so nothing else can supply it. A facet cannot
work the name out for itself — `callerKey()` throws there by design — and it is
deliberately not a subtask param, because those are rendered to the delegating
model and a model-authored workspace name would let it name somebody else's.

`getWorkspace` rebuilds a real `WorkspaceRuntimeExecHandle` on the client side
from the stub's byte stream, so the drain works across a Durable Object boundary
and the container→workspace filesystem sync still fires when the stream reaches
`done`.

## Costs

Two numbers drive the sizing here — not a spend cap, which this package
deliberately does not have, but `timeoutMs`, `maxSubtasks` and how large a brief
is worth writing.

**The harness prefix is ~18.7-27k cached tokens per invocation.** A ten-call
burst billed **twenty** raw input tokens against 187,130 cache reads. On anything
short the prefix is the bill — which is why a subtask must be a substantial unit
of work, and why warm containers and temporally clustered subtasks matter.

**A 5-hour session is worth roughly $10 of Opus-equivalent.** Usage draws the
interactive session bucket, so agent work competes with whoever is using Claude
Code at their desk — expect about one substantial round per window, per
credential in the pool. Rotation does not create allowance; it moves to the next
bucket when one runs out, and then stops cleanly.

## What this deliberately does not do

- **No `--bare`, no `--settings` override, no `CLAUDE_CONFIG_DIR`.** A cloned
  repository's `CLAUDE.md`, skills and hooks are exactly the material that makes
  the agent good at that repository. The container already runs the repo's
  `postinstall` and its test suite, so suppressing `.claude/` closes one door
  while the others stand open by design — it costs the agent its context and buys
  nothing. Containment is the credential swap.
- **No claude.ai login flow, ever.** Credentials are BYO-paste from
  `claude setup-token`. Anthropic does not allow third-party developers to offer
  claude.ai login or subscription rate limits for their products.
- **No metering in the gateway.** Spend estimates were tried and removed; the
  bucket says when it is empty, and rotation acts on that. See above.

> A deployment-wide subscription token means one person's plan backs everyone
> using that deployment. That is fine for a single-operator fork and it is the
> shape Anthropic's terms target for multi-tenant. Per-human scoping is not
> expressible today.
