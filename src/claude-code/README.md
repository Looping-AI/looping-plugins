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

|                                | Looping subtask        | Claude Code subagent          |
| ------------------------------ | ---------------------- | ----------------------------- |
| Durable                        | yes                    | no                            |
| Visible to Looping's scheduler | yes                    | **no**                        |
| Cancellable by Looping         | yes                    | **no**                        |
| Bounded by                     | the egress budget gate | `CLAUDE_CODE_MAX_*`, advisory |

## The credential never enters the container

The container is an arbitrary-code-execution environment by design: `npm ci` runs
whatever `postinstall` a cloned repository ships, and the agent runs that
repository's own build and test commands. So nothing secret goes in it.

The session launches with `CREDENTIAL_PLACEHOLDER`. `computerd` intercepts every
outbound request and hands it to `claudeCodeEgress` on the **Worker** side, which:

1. **swaps** the placeholder for the real credential, for `api.anthropic.com` only;
2. **strips** every credential header from anything else;
3. optionally **restricts the container to named hosts** — exact hostname match,
   no wildcards, and **off by default** (see below);
4. can **refuse** a model call that is over budget, with a `429` the client renders
   as `system/api_retry`.

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

### The gateway is the only ceiling that holds

`--max-turns` and the subagent caps are advisory, and the inner agent tree
multiplies both. Every inner call still crosses the gateway, so a budget refused
there is a budget refused. Meter from the `result` event — it carries `usage` and
a per-model cost breakdown, and it is parsed anyway — and let the gate read the
counter.

## What the host must provide

```jsonc
// wrangler.jsonc
{
  "containers": [
    {
      "class_name": "ClaudeCoderWorkspaceDO",
      "image": "./Dockerfile.claude-code",
      "instance_type": "standard-2",
      "max_instances": 5
    }
  ],
  "secrets": { "required": ["CLAUDE_CODE_OAUTH_TOKEN"] }
}
```

The image is the workspace image plus a **pinned** `npm i -g
@anthropic-ai/claude-code@X.Y.Z`. Pin it deliberately: the wire shape this
package's gateway and parser are both written against is version-coupled, so
re-run the smoke test on every bump.

The workspace Durable Object installs the gateway as its egress policy:

```ts
readonly #session = claudeCodeSession({
  credential: () => this.env.CLAUDE_CODE_OAUTH_TOKEN,
  // Omit for unrestricted, which is the default.
  restrictToHosts: ["registry.npmjs.org"],
  budget: { check: () => this.#budgetRemaining() }
});

readonly backend = new CloudflareContainerBackend({
  container: () => this,
  workspace: { binding: "CLAUDE_CODER_WORKSPACE", id: this.ctx.id.toString() },
  egress: { mode: "http-gateway", gateway: this.#session.egress() }
});
```

> **`mode: "http-gateway"` intercepts _all_ egress**, so a restriction you do
> configure is load-bearing for `npm ci` too. A restricted gateway that forgets
> the registry does not degrade the agent — it stops the container installing
> anything. This is the main reason the default is open.

And the subagent drives the session:

```ts
protected override async executeChunk(...): Promise<RecipeChunkResult> {
  const outcome = cursor
    ? await session.resume(runtime, cursor)
    : await session.start(runtime, prompt, dir);

  if (!outcome.done) return { done: false, progress: outcome.progress };
  return { done: true, progress: outcome.progress, result: report(outcome) };
}
```

`DrainCursor` is the only state, and the caller persists it. A fresh isolate
resumes from the exact event sequence the last one consumed.

## Costs

Two numbers drive every budget here.

**The harness prefix is ~18.7-27k cached tokens per invocation.** A ten-call
burst billed **twenty** raw input tokens against 187,130 cache reads. On anything
short the prefix is the bill — which is why a subtask must be a substantial unit
of work, and why warm containers and temporally clustered subtasks matter.

**A 5-hour session is worth roughly $10 of Opus-equivalent.** Usage draws the
interactive session bucket, so agent work competes with whoever is using Claude
Code at their desk. Budget for about one substantial round per window.

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
- **No metering in the gateway.** The `result` event already carries it.

> A deployment-wide subscription token means one person's plan backs everyone
> using that deployment. That is fine for a single-operator fork and it is the
> shape Anthropic's terms target for multi-tenant. Per-human scoping is not
> expressible today.
