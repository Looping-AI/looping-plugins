import { describe, it, expect } from "vitest";
import { refreshCheckout, resolveDefaultBranch } from "./checkout.js";
import type { GitAnswer } from "./checkout.js";

/**
 * The checkout helpers, driven directly.
 *
 * This is what the seam is for. `refreshCheckout` has more refusal paths than any
 * tool in the plugin and every one of them is a decision about somebody's
 * uncommitted work, so they are asserted here — against a scripted `plain` —
 * rather than through `repo_clone` and a container stub that would make the
 * interesting cases hard to reach. `index.spec.ts` still covers the wiring.
 */

const ok = (stdout = ""): GitAnswer => ({ success: true, stdout, stderr: "" });
const failed = (stderr: string): GitAnswer => ({
  success: false,
  stdout: "",
  stderr
});
/** A command that never ran — which is not the same as one that answered "no". */
const lost = (): GitAnswer => ({
  success: false,
  stdout: "",
  stderr: "the container was replaced",
  unreachable: true
});

/**
 * A `plain` scripted by the git subcommand, and a record of what was run.
 *
 * The record is half the point: several assertions below are that a command was
 * *not* reached, and a refusal that returns the right sentence after already
 * running `reset --hard` would pass a message-only test.
 */
function runner(script: Record<string, GitAnswer> = {}) {
  const ran: string[] = [];
  const plain = async (args: string): Promise<GitAnswer> => {
    ran.push(args);
    for (const [prefix, answer] of Object.entries(script)) {
      if (args.startsWith(prefix)) return answer;
    }
    return ok();
  };
  return { plain, ran };
}

describe("resolveDefaultBranch", () => {
  it("strips the remote prefix git prints", async () => {
    const { plain } = runner({ "symbolic-ref": ok("origin/main\n") });
    expect(await resolveDefaultBranch(plain, "/w/r")).toEqual({
      branch: "main"
    });
  });

  /**
   * The distinction the extraction had to preserve. A repository with no
   * `origin/HEAD` is unusual but legitimate, and `repo_push` stands its
   * empty-branch and default-branch guards down when it sees one — so a container
   * that never answered must not look the same as a repository that answered "I
   * have none".
   */
  it("reports no branch when git says there is none", async () => {
    const { plain } = runner({ "symbolic-ref": failed("no such ref") });
    expect(await resolveDefaultBranch(plain, "/w/r")).toEqual({});
  });

  it("reports an unreachable container separately, not as an absent branch", async () => {
    const { plain } = runner({ "symbolic-ref": lost() });
    const out = await resolveDefaultBranch(plain, "/w/r");
    expect(out.branch).toBeUndefined();
    expect(out.unreachable).toContain("container was replaced");
  });
});

describe("refreshCheckout", () => {
  const url = "https://github.com/owner/repo";
  const fetchOrigin = async () => ok("fetched");

  it("fetches and resets a clean checkout of the same repository", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": ok(""),
      "symbolic-ref": ok("origin/main\n")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.branch).toBe("main");
    expect(out.message).toContain("reused the existing checkout");
    expect(ran.some((c) => c.startsWith("reset --hard"))).toBe(true);
  });

  /**
   * The one loss in this file nobody can recover from. Uncommitted changes are a
   * previous task's work — possibly the thing a human is waiting on — so the tree
   * is left exactly as it is, and no `branch` comes back, which is what stops the
   * host firing `afterCheckout` over a state the model has not looked at.
   */
  it("refuses a dirty tree without fetching or resetting it", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": ok(" M src/a.ts\n")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.branch).toBeUndefined();
    expect(out.message).toContain("uncommitted changes");
    expect(out.message).toContain("repo_diff");
    expect(ran.some((c) => c.startsWith("reset"))).toBe(false);
    expect(ran.some((c) => c.startsWith("checkout"))).toBe(false);
  });

  /**
   * Empty stdout from a `status` that *failed* is not a clean tree, it is no
   * answer at all — and the next two commands would be `fetch` and `reset --hard`.
   */
  it("refuses a tree whose state could not be read", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": failed("permission denied")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.branch).toBeUndefined();
    expect(out.message).toContain("permission denied");
    expect(ran.some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("refuses a directory holding a different repository", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok("https://github.com/someone/else\n")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.branch).toBeUndefined();
    expect(out.message).toContain("someone/else");
    expect(ran.some((c) => c.startsWith("status"))).toBe(false);
  });

  /**
   * A question that went unanswered is not the answer "some other repository".
   * Empty stdout from a failed `remote get-url` used to produce exactly that
   * sentence, sending the model to look for a checkout nobody had mentioned.
   */
  it("says the remote could not be read rather than naming a phantom repository", async () => {
    const { plain } = runner({
      "remote get-url": failed("not a git repository")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.message).toContain("could not read which repository");
    expect(out.message).toContain("Nothing was fetched or reset");
  });

  it("distinguishes an unreachable container from a repository with no default branch", async () => {
    const { plain } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": ok(""),
      "symbolic-ref": lost()
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin
    });

    expect(out.branch).toBeUndefined();
    expect(out.message).toContain("could not read the default branch");
    expect(out.message).toContain("container was replaced");
  });

  it("stops when the fetch fails, leaving the tree on its current branch", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": ok("")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: undefined,
      plain,
      fetchOrigin: async () => failed("could not authenticate")
    });

    expect(out.branch).toBeUndefined();
    expect(out.message).toContain("fetch failed");
    expect(ran.some((c) => c.startsWith("reset"))).toBe(false);
  });

  /**
   * A branch the caller named is not looked up: `repo_clone` passes the model's
   * choice through, and asking the remote what its default is would be a question
   * nobody needs the answer to.
   */
  it("lands on the branch it was given without consulting origin/HEAD", async () => {
    const { plain, ran } = runner({
      "remote get-url": ok(`${url}\n`),
      "status --porcelain": ok("")
    });

    const out = await refreshCheckout({
      dir: "/w/r",
      url,
      branch: "release",
      plain,
      fetchOrigin
    });

    expect(out.branch).toBe("release");
    expect(ran.some((c) => c.startsWith("symbolic-ref"))).toBe(false);
  });
});
