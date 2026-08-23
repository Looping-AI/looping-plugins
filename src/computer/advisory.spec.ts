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
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "boom",
        treePresent: false
      },
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
      shapeOf({
        kind: "deps-broken",
        command: "x",
        error: "y",
        treePresent: false
      }).universal
    ).toBe(false);
  });
});

describe("who is being told", () => {
  /**
   * The audience decides the verbs, and naming an action the reader does not
   * have is worse than silence: a session has no command that failed to run, so
   * "call again in a moment" would be an instruction it cannot follow.
   */
  it("tells a session to wait, which a tool call cannot be told", () => {
    const building: WorkspaceAdvisory = {
      kind: "deps-building",
      command: "npm ci",
      startedAt: Date.now()
    };
    expect(renderAdvisory(building, "session")).toContain("Wait and retry");
    expect(renderAdvisory(building, "tool-call")).not.toContain(
      "Wait and retry"
    );
  });

  /**
   * No advisory claims the command ran or did not, in either audience.
   *
   * It is not in a position to know — the verdict comes from the whole set, so
   * two coexisting advisories would contradict each other outright. `execGate`
   * says it once. This is the assertion that keeps the claim from creeping back
   * into the wording.
   */
  it("never says whether the command ran", () => {
    const all: WorkspaceAdvisory[] = [
      { kind: "deps-building", command: "npm ci", startedAt: Date.now() },
      { kind: "deps-broken", command: "npm ci", error: "x", treePresent: true },
      { kind: "deps-absent", reason: "no package.json" },
      full
    ];
    for (const advisory of all) {
      for (const to of ["tool-call", "session"] as const) {
        const text = renderAdvisory(advisory, to);
        expect(text).not.toContain("still ran");
        expect(text).not.toContain("Nothing was run");
      }
    }
  });

  /**
   * A present `node_modules` is not evidence the install worked — a failed one
   * leaves a partial tree behind. So the reader is told the ambiguity rather
   * than handed a verdict either way.
   */
  it("flags a surviving tree as settling nothing", () => {
    const broken = (treePresent: boolean): WorkspaceAdvisory => ({
      kind: "deps-broken",
      command: "npm ci",
      error: "ERESOLVE",
      treePresent
    });
    expect(renderAdvisory(broken(true), "session")).toContain(
      "settles nothing"
    );
    expect(renderAdvisory(broken(false), "session")).not.toContain(
      "settles nothing"
    );
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
  const present = { dependencyTreePresent: true };
  const absent = { dependencyTreePresent: false };

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
   * A durable record of a failure is never deleted by a weaker signal.
   *
   * The probe behind `dependencyTreePresent` is `test -d node_modules`, which a
   * `npm ci` that died halfway satisfies perfectly. Treating it as proof of
   * success made the advisory vanish on precisely the failure it existed to
   * report — so it qualifies the advisory instead, and the reader is told which
   * way the ambiguity runs.
   */
  it("keeps reporting a failed install even when a tree is sitting there", () => {
    const advisories = deriveAdvisories({
      install: {
        state: "failed",
        command: "npm ci",
        finishedAt: Date.now(),
        error: "ERESOLVE"
      },
      ...present
    });

    expect(advisories).toEqual([
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: true
      }
    ]);
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
      {
        kind: "deps-broken",
        command: "npm ci",
        error: "ERESOLVE",
        treePresent: false
      }
    ]);
    expect(brief).toContain("nothing further can be written");
    expect(brief).toContain("ERESOLVE");
  });
});
