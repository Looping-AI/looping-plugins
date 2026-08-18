/**
 * Where a repository URL points, and which branch names are safe to act on.
 *
 * Parsing, and nothing else — no `exec`, no token, no network. That is what makes
 * this the file to read when the question is "could a model get somewhere it
 * should not by naming it": every regex here exists because a plausible-looking
 * string once resolved to something other than what it appeared to name.
 */

/**
 * The forges a clone URL may name when a host configures none.
 *
 * Lives here rather than with the other defaults because it is an input to
 * {@link parseRepo}, and because "which hosts may be named" is this file's whole
 * subject. `RepoConfig.allowedHosts` overrides it.
 */
export const DEFAULT_ALLOWED_HOSTS = ["github.com"];

/** Branch names a push must never target, whatever the model believes. */
export const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop"
]);

/**
 * A branch name git would accept but this plugin must not, because it can
 * resolve to something other than the branch it appears to name.
 *
 * `git push origin <name>` treats `<name>` as a refspec, so a `:` makes it
 * `<src>:<dst>` and a leading `+` makes it a force push — either one steps
 * around {@link PROTECTED_BRANCHES}, which only ever sees the literal string.
 * `git checkout -B` happens to reject some of these already; "happens to" is not
 * a guarantee worth depending on.
 */
export const UNSAFE_BRANCH =
  /[:^~?*[\\\x00-\x20\x7f]|^[+-]|^refs\/|\.\.|@\{|\.lock$|\/$/;

/**
 * Where a repository URL points, in a form that cannot be spoofed by a path.
 *
 * **https only, on every branch.** This used to accept scp-like syntax as well —
 * `git@github.com:owner/repo.git` — and that branch returned before the protocol
 * check below, so the one invariant this function exists to state was quietly
 * false for the syntax most likely to carry an SSH URL. `repo_clone`'s own
 * refusal promises "only clone over https", and it was letting one through.
 *
 * Nothing can act on such a URL any more. The three credentialed operations run
 * host-side over isomorphic-git, which has no SSH transport, so an scp URL that
 * passed the gate reached the host and failed there instead — a worse error, one
 * step further from the model that could have fixed it. Origins are written by
 * `repo_clone` from a URL that came through here, so a checkout cannot acquire
 * one this refuses without somebody rewriting `.git/config` by hand.
 */
export function repoLocation(
  url: string
): { host: string; path: string } | undefined {
  try {
    const parsed = new URL(url.trim());
    // https only. Not pedantry: git accepts `ext::<command>`, `file://` and
    // more, and `ext::` in particular runs an arbitrary command as a "remote".
    if (parsed.protocol !== "https:") return undefined;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    return undefined;
  }
}

/**
 * A name a forge would actually issue — and, more to the point, one that is safe
 * to use as a path segment and as a key.
 *
 * GitHub's own rule for both an owner and a repository is alphanumerics, `-`,
 * `_` and `.`, so nothing legitimate is turned away by insisting on it. What it
 * turns away is the reason it exists: `..` and `.` are valid matches for "a path
 * segment that is not a slash", and {@link buildRepoTools} builds a checkout
 * directory out of the repository name — so `https://github.com/o/..` produced a
 * `dir` of `/workspace/..`, which is `/`.
 *
 * The key half matters as much and is less visible. `beforeCheckout` hands
 * `owner` and `repo` to the host, and this plugin's README tells that host to
 * derive a per-repository workspace name from them. A name carrying `|`, `:` or
 * a space is then a separator in somebody else's key format, which is how two
 * callers end up sharing one workspace.
 */
const FORGE_NAME = /^[A-Za-z0-9._-]+$/;

function isForgeName(name: string): boolean {
  // `.` and `..` pass the character class and are exactly the two that must not.
  return name !== "." && name !== ".." && FORGE_NAME.test(name);
}

/**
 * `owner/repo` out of a GitHub URL, or `undefined` if it is not one.
 *
 * Anchored on the parsed **host**, which the previous unanchored regex was not:
 * `github.com` appearing anywhere in the string was enough, so
 * `https://evil.example.com/github.com/owner/repo` parsed as that owner and
 * repo. Nothing gated on this at the time, which is exactly why it was worth
 * fixing before something did.
 *
 * Both names are then checked against {@link isForgeName}, so a name that could
 * traverse a path or split somebody else's key never gets as far as being one.
 *
 * `undefined` is a refusal at every caller. `repo_clone` used to treat it as
 * "clone anyway, into `${workdir}/repo`, without telling the host which
 * repository this is" — which put the checkout in whichever workspace was
 * already open. It now says so and stops.
 */
export function parseRepo(
  url: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS
): { owner: string; repo: string } | undefined {
  const location = repoLocation(url);
  if (!location || !allowedHosts.includes(location.host)) return undefined;

  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(location.path);
  if (!match) return undefined;

  const [, owner, repo] = match as unknown as [string, string, string];
  if (!isForgeName(owner) || !isForgeName(repo)) return undefined;
  return { owner, repo };
}
