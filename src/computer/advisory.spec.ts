import { describe, it, expect } from "vitest";
import {
  deriveAdvisories,
  renderAdvisory,
  sessionAdvisory,
  shapeOf,
  type WorkspaceAdvisory
} from "./advisory.js";

/**
 * The claims this file exists to hold.
 *
 * Two of them are about what the type system does rather than what the code
 * returns, and they are the load-bearing ones — `shapeOf` and `renderAdvisory`
 * are the only exhaustive switches, and everything downstream is correct only
 * because adding a kind cannot skip them. That cannot be asserted from inside
 * the suite; it is checked by adding a kind and watching `tsc` fail, which the
 * README records.
 */

const full: WorkspaceAdvisory = {
  kind: "storage-exhausted",
  bytes: 8.6e9,
  capBytes: 8e9
};

describe("what each advisory means", () => {
  /**
   * The combination that justifies three separate axes rather than one severity
   * scale: a full workspace is permanent *and* reaches every command *and* is
   * the only one that loses writes. Any collapsing of the axes hides it.
   */
  it("marks a full workspace permanent, universal and write-losing", () => {
    expect(shapeOf(full)).toEqual({
      transient: false,
      universal: true,
      writesPersist: false
    });
  });

  /**
   * Only an install in flight may block a command, and this is the assertion
   * that keeps it that way. Anything permanent that blocked would disable the
   * shell for the rest of the session while telling the model to fix it with the
   * tool that is refusing to run.
   */
  it("makes an install in flight the only thing worth waiting for", () => {
    const kinds: WorkspaceAdvisory[] = [
      { kind: "deps-building", command: "npm ci", startedAt: Date.now() },
      { kind: "deps-broken", command: "npm ci", error: "boom" },
      { kind: "deps-absent", reason: "no package.json" },
      full
    ];
    expect(
      kinds.filter((a) => shapeOf(a).transient).map((a) => a.kind)
    ).toEqual(["deps-building"]);
  });

  /** A dependency problem is not a reason to interrupt `cat README.md`. */
  it("keeps dependency advisories off commands that need no dependencies", () => {
    expect(
      shapeOf({ kind: "deps-broken", command: "x", error: "y" }).universal
    ).toBe(false);
  });
});

describe("who is being told", () => {
  /**
   * The audience decides the verbs, and naming an action the reader does not
   * have is worse than silence: a session has no command that failed to run, so
   * "call again in a moment" would be an instruction it cannot follow.
   */
  it("offers a tool call a retry and a session a wait", () => {
    const building: WorkspaceAdvisory = {
      kind: "deps-building",
      command: "npm ci",
      startedAt: Date.now()
    };
    expect(renderAdvisory(building, "tool-call")).toContain("call again");
    expect(renderAdvisory(building, "session")).not.toContain("call again");
    expect(renderAdvisory(building, "session")).toContain("Wait and retry");
  });

  /**
   * The one instruction that must survive both renderings: a session that works
   * around a lost-writes workspace produces nothing and reports nothing, and its
   * report is the only way an operator finds out.
   */
  it("tells both readers to stop when writes are being dropped", () => {
    expect(renderAdvisory(full, "tool-call")).toContain("Stop and report");
    expect(renderAdvisory(full, "session")).toContain("Report this and stop");
    expect(renderAdvisory(full, "session")).toContain("8.6 GB");
  });
});

describe("deriving what is true from what the host knows", () => {
  const present = { dependenciesPresent: true };
  const absent = { dependenciesPresent: false };

  it("says nothing when the install succeeded", () => {
    expect(
      deriveAdvisories({
        install: {
          state: "done",
          command: "npm ci",
          exitCode: 0,
          finishedAt: Date.now(),
          ms: 74_000
        },
        ...present
      })
    ).toEqual([]);
  });

  /**
   * Both true at once. The single-slot record this replaced kept whichever was
   * written last, so a workspace that hit its ceiling silently erased the
   * install failure — or the reverse — and no reader could see the pair.
   */
  it("reports a full workspace and a broken install together", () => {
    const advisories = deriveAdvisories({
      install: {
        state: "failed",
        command: "npm ci",
        finishedAt: Date.now(),
        error: "SELF_SIGNED_CERT_IN_CHAIN"
      },
      storage: { bytes: 8.6e9, capBytes: 8e9 },
      ...absent
    });

    // Severity-descending, so a reader that shows one shows the one that matters.
    expect(advisories.map((a) => a.kind)).toEqual([
      "storage-exhausted",
      "deps-broken"
    ]);
  });

  /**
   * The probe corrects the record instead of the record being rewritten.
   *
   * A subagent that runs `npm ci` by hand leaves a `failed` the host cannot
   * update, because the host cannot see an install it did not start. Answering
   * that by writing back a `done` meant inventing an exit code and a duration
   * for a command that never ran, and putting editorial text in the field that
   * holds an install's own output. Reported as an absence, none of that is
   * needed.
   */
  it("drops a stale failure when the dependencies are actually there", () => {
    expect(
      deriveAdvisories({
        install: {
          state: "failed",
          command: "npm ci",
          finishedAt: Date.now(),
          error: "ERESOLVE"
        },
        ...present
      })
    ).toEqual([]);
  });

  /**
   * `skipped` has two writers and only one is routine — a checkout with nothing
   * to install, and a workspace over its ceiling. They were told apart only by
   * reading prose, which is how both readers came to ignore the second. The
   * ceiling now arrives as its own kind, and this is the leftover benign case.
   */
  it("passes a skip reason through as its own kind", () => {
    expect(
      deriveAdvisories({
        install: { state: "skipped", reason: "no package.json in /workspace" },
        ...absent
      })
    ).toEqual([
      { kind: "deps-absent", reason: "no package.json in /workspace" }
    ]);
  });

  it("carries an install in flight, with its output so far", () => {
    const startedAt = Date.now() - 30_000;
    expect(
      deriveAdvisories({
        install: {
          state: "running",
          command: "npm ci",
          startedAt,
          tail: "added 200 packages"
        },
        ...absent
      })
    ).toEqual([
      {
        kind: "deps-building",
        command: "npm ci",
        startedAt,
        tail: "added 200 packages"
      }
    ]);
  });
});

describe("what a session is told", () => {
  /** Silence is the good case, and it is what an empty array has to produce. */
  it("says nothing when there is nothing to say", () => {
    expect(sessionAdvisory([])).toBeUndefined();
  });

  it("joins everything true into one brief", () => {
    const brief = sessionAdvisory([
      full,
      { kind: "deps-broken", command: "npm ci", error: "ERESOLVE" }
    ]);
    expect(brief).toContain("nothing further can be written");
    expect(brief).toContain("ERESOLVE");
  });
});
