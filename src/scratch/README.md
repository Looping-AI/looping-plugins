# `@dynamicagents/plugins/scratch`

A throwaway git repository with no remote, for work that needs a container but
not a checkout.

```ts
import { scratch } from "@dynamicagents/plugins/scratch";
import { computerExec } from "@dynamicagents/plugins/computer";

scratch({
  // Runs in the container. Nothing here ever needs a credential.
  exec: computerExec({ binding: env.WORKSPACE, workspaceName: () => name })
});
```

One tool: `scratch_open`, with an optional `reset`.

## Why this exists

An agent with a container and a git plugin can do a great deal, and all of it
starts with a clone. That is right for most of the work such an agent does and
wrong for the rest of it: "check what this actually returns", "write a script and
run it", "try that regex against these twenty lines" each need a container, and
none of them needs a repository.

With no way to say so, an agent asks for one. The deployment this was written for
had a coding agent ask its user for an **empty repository to clone** so it could
run a script in the checkout. That is a workaround for a missing verb, and a good
sign the verb is missing.

## A scratchpad is a repository whose remote is nowhere

That framing is the design, and it is why this plugin is small. Everything a host
already does for a checkout applies unchanged:

- It is a real git repository, so a host's `git reset --hard && git clean -fdx`
  discards a cancelled task's edits out of it.
- It lives in the workspace, so it is durable across tasks and is reclaimed by
  whatever already reclaims the workspace.
- It goes through the host's own workspace selection, so it is keyed, routed and
  cleaned up by machinery that exists rather than by a second mechanism alongside
  it.

It has no `origin`. That is the property that makes it safe to let a session do as
it likes in one: nothing here is ever pushed anywhere, so there is no branch to
protect and no pull request to open.

### The empty initial commit

`scratch_open` makes one on creation, and it is load-bearing rather than tidy.
Without it the repository has no `HEAD`, and `git reset --hard` fails outright —
which is what a host runs to discard a cancelled task's edits. That cleanup is
best-effort in every host that has one, so the failure is a logged warning plus a
cancelled run's files surviving into the next task as its starting point.

## What the host owns

The same split [`/repo`](../repo/) makes: this plugin knows what a scratchpad
_is_, the host knows how it addresses one.

```ts
scratch({
  exec: computerExec(config),
  // Select the workspace, before any command runs. Synchronous; a throw fails
  // the open, because a host that could not choose has not chosen.
  beforeOpen: () => active.set(SCRATCH),
  // Record it, and say whether you can see it.
  afterOpen: async ({ dir }) => {
    const { present } = await workspace().noteCheckout({
      dir,
      kind: "scratch"
    });
    return { ready: present };
  }
});
```

A host that wires neither still gets a working scratchpad, as long as its
workspace is not keyed per repository.

**`afterOpen` returns readiness where `RepoConfig.afterCheckout` returns `void`,
and a throw in it reaches the model rather than being logged.** Both differences
are deliberate. This plugin knows `git init` exited 0; whether the host's durable
record agrees is host knowledge, and a tool that reports success followed by a
delegation that refuses to start is the worst version of that failure — the two
are reported in different places and nothing connects them. And where a clone is
still useful to an agent whose follow-up hook failed, a scratchpad the host did
not record cannot be delegated into at all.

## Selection, not a capability

`scratch_open` is a **main-agent tool only** — no tool family, so it is never lent
to a subagent. Opening a scratchpad _selects a workspace_, exactly as `repo_clone`
does. A subagent holding it could re-point the workspace its parent prepared
half-way through its own run; a delegated run works in whatever it was given.

For the same reason, the capability block tells the model that a task works in a
cloned repository **or** in the scratchpad and not both. A host that keys one
workspace selection per caller points every other workspace tool at whatever was
selected last, so an agent that opens a scratchpad mid-checkout has quietly moved
its own `repo_diff` and `repo_commit` with it. That is a property of the host's
routing rather than something this plugin can prevent, which is why the model is
told the rule instead of being left to discover it.

## Requirements

None of its own. It needs a shell in a container — `exec` is injected, so
[`/computer`](../computer/)'s `computerExec` is one source of it and a host with
its own container is another. No credential, no binding, no secret.
