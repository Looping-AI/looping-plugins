import { describe, it, expect } from "vitest";
import { guardPath, isContainerOnly, isGitInternal } from "./paths.js";

/**
 * The guard, on its own terms.
 *
 * It became a pure function when it stopped resolving symlinks, so this asserts
 * it directly rather than through a tool and a workspace stub. What that cannot
 * show is that each tool actually calls it — `index.spec.ts` keeps those, and
 * both halves are needed: a guard nobody calls passes every test here.
 */

describe("segments, not substrings", () => {
  it("matches node_modules as a whole segment, not as a substring", () => {
    expect(isContainerOnly("/workspace/repo/node_modules/zod/index.js")).toBe(
      true
    );
    expect(isContainerOnly("/workspace/repo/node_modules")).toBe(true);
    expect(isContainerOnly("/workspace/repo/src/node_modules_old/a.ts")).toBe(
      false
    );
    expect(isContainerOnly("/workspace/repo/src/my_node_modules.ts")).toBe(
      false
    );
  });

  it("matches .git as a whole segment, sparing the dotfiles that merely start with it", () => {
    expect(isGitInternal("/workspace/repo/.git/config")).toBe(true);
    expect(isGitInternal("/workspace/repo/.git")).toBe(true);
    // The trap: these are ordinary tracked files and must stay readable.
    expect(isGitInternal("/workspace/repo/.gitignore")).toBe(false);
    expect(isGitInternal("/workspace/repo/.gitattributes")).toBe(false);
    expect(isGitInternal("/workspace/repo/.github/workflows/ci.yml")).toBe(
      false
    );
    expect(isGitInternal("/workspace/repo/src/git/index.ts")).toBe(false);
  });
});

describe("guardPath", () => {
  it("clears an ordinary path", () => {
    expect(guardPath("/workspace/repo/src/a.ts", "sb_read")).toBeUndefined();
  });

  /**
   * The two refusals are not interchangeable and the difference is the whole
   * reason there are two lists. `node_modules` is absent — so the note explains a
   * file the model can plainly see and names the tool that reaches it. `.git` is
   * present and refused — so the note names where repository work belongs and,
   * emphatically, does *not* offer `sb_exec`, which would hand back the exact
   * capability the refusal withholds in the one place the model is looking for a
   * way around it.
   */
  it("explains an absent path by naming the shell that can see it", () => {
    const note = guardPath(
      "/workspace/repo/node_modules/zod/index.js",
      "sb_read"
    )!;
    expect(note).toContain("only in the container");
    expect(note).toContain("sb_exec");
  });

  it("redirects a .git path to the repo tools, and never to sb_exec", () => {
    const note = guardPath("/workspace/repo/.git/config", "sb_write")!;
    expect(note).toContain("repo_status");
    expect(note).not.toContain("sb_exec");
  });

  /**
   * The verb is the calling tool's own name. A refusal that says "sb_read cannot
   * see it" while the model called `sb_grep` reads like a bug in the plugin.
   */
  it("names the tool that was called", () => {
    expect(guardPath("/workspace/repo/.git", "sb_grep")).toContain("sb_grep");
    expect(guardPath("/workspace/repo/node_modules", "sb_ls")).toContain(
      "sb_ls"
    );
  });
});
