/**
 * Where a repository URL points, and which branch names are safe to act on.
 *
 * Parsing, and nothing else — no `exec`, no token, no network. Which makes it the
 * file to read when the question is "could a model get somewhere it should not by
 * naming it": every pattern here turns away a string that resolves to something
 * other than what it appears to name.
 */

/** The forges a clone URL may name. `RepoConfig.allowedHosts` overrides it. */
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
 * **https only**, with no exception for scp-like syntax (`git@host:owner/repo`):
 * that spelling is the one most likely to carry an SSH URL, and this is the only
 * place the protocol is decided. Origins are written by `repo_clone` from a URL
 * that came through here, so a checkout cannot acquire one this refuses without
 * somebody rewriting `.git/config` by hand.
 */
export function repoLocation(
  url: string
): { host: string; path: string; url: string } | undefined {
  try {
    const parsed = new URL(url.trim());
    // https only. Not pedantry: git accepts `ext::<command>`, `file://` and
    // more, and `ext::` in particular runs an arbitrary command as a "remote".
    if (parsed.protocol !== "https:") return undefined;
    // Refused rather than dropped: the allowlist reads `hostname`, and every
    // other part of the URL travels on to the host's git. A password in a clone
    // URL is a credential the model is asking to have offered to a server, and
    // userinfo is where URL parsers disagree — `https://a@b@github.com/o/r`
    // reads as one host here and can read as another wherever it lands.
    if (parsed.username || parsed.password || parsed.port) return undefined;
    const host = parsed.hostname.toLowerCase();
    // A canonical form for callers to travel with. `search` and `hash` mean
    // nothing to git and would otherwise ride along into `.git/config`, where
    // they make two spellings of one repository compare unequal.
    return {
      host,
      path: parsed.pathname,
      url: `https://${host}${parsed.pathname}`
    };
  } catch {
    return undefined;
  }
}

/**
 * One spelling of a repository URL, so two of them can be compared.
 *
 * `https://github.com/o/r`, `.../o/r.git` and `.../o/r/` name one repository,
 * and git writes whichever it was given into `.git/config`. A checkout is
 * matched against the URL a later call asks for, so without this a clone written
 * with a different suffix looks like a different repository — and the refusal
 * that follows is one no repository tool can clear.
 */
export function sameRepoUrl(a: string, b: string): boolean {
  const canonical = (raw: string) => {
    const location = repoLocation(raw);
    // Unparseable on either side falls back to the trimmed string: this decides
    // whether two things match, and inventing an equality for input it cannot
    // read is the wrong direction to be wrong in.
    if (!location) return raw.trim();
    // Trailing slashes first: `.../o/r.git/` is one repository written two ways
    // at once, and stripping `.git` from a string that ends in `/` matches
    // nothing.
    return location.url.replace(/\/+$/, "").replace(/\.git$/, "");
  };
  return canonical(a) === canonical(b);
}

/**
 * A name a forge would actually issue — and one that is safe to use as a path
 * segment and as a key.
 *
 * GitHub's rule for an owner and a repository alike is alphanumerics, `-`, `_`
 * and `.`, so nothing legitimate is turned away. What it turns away is why it
 * exists. `buildRepoTools` builds a checkout directory out of the repository
 * name, and `.` and `..` are valid matches for "a path segment that is not a
 * slash" — so `https://github.com/o/..` gives a `dir` of `/workspace/..`, which
 * is `/`. And `beforeCheckout` hands both names to the host, which the README
 * tells to derive a workspace name from them: one carrying `|`, `:` or a space
 * is a separator in somebody else's key format, which is how two callers end up
 * sharing one workspace.
 */
const FORGE_NAME = /^[A-Za-z0-9._-]+$/;

function isForgeName(name: string): boolean {
  // `.` and `..` pass the character class and are exactly the two that must not.
  return name !== "." && name !== ".." && FORGE_NAME.test(name);
}

/**
 * `owner/repo` out of a repository URL, or `undefined` if it is not one.
 *
 * Anchored on the **parsed host** rather than matched in the string, so
 * `https://evil.example.com/github.com/owner/repo` is not a github.com URL.
 * Both names are then checked against {@link isForgeName}, so a name that could
 * traverse a path or split somebody else's key never gets as far as being one.
 *
 * `undefined` is a refusal at every caller, never a reason to carry on with a
 * default.
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
