import type { InstallState } from "./install.js";
import { humanMs } from "./render.js";

/**
 * What a caller must not assume about a workspace, and how to say it.
 *
 * ## Why this is not `InstallState`
 *
 * `InstallState` is the durable record of **a job the host ran** — core's
 * `JobState`, which owns arming, the single-flight guard, the staleness bound
 * and the generation marker. It is right for that and unchanged by this file.
 *
 * Every *reader*, though, is asking a different question: **can I rely on this
 * workspace right now?** The two diverge, and where they did the old code either
 * overloaded a variant or invented a record:
 *
 * - A workspace at its storage ceiling was written as `skipped` — the same
 *   variant that means "this checkout has nothing to install". One is a hard
 *   wall about the Durable Object, the other is routine and about the
 *   repository, and they were told apart only by reading prose. Both readers
 *   missed the first.
 * - Capacity therefore travelled through a channel gated by
 *   {@link file://./gate.ts needsDependencies}, so a full workspace said nothing
 *   at all to `echo hi > file.txt` — the command whose write is being lost.
 * - "The tree is fine now", after a subagent installed by hand, had no way to be
 *   said except by fabricating a `done` with an invented exit code — and the
 *   probe it rested on, a bare `test -d node_modules`, is satisfied by the
 *   wreckage of the very install it was overriding.
 *
 * So an advisory is **derived at read time** and describes the workspace, not a
 * job. Its absence is the good case, which is what removes the need to invent
 * anything: nothing to say means an empty array.
 *
 * ## One home for what each kind means
 *
 * {@link shapeOf} is the only exhaustive `switch` over {@link WorkspaceAdvisory}
 * that decides *policy*, and {@link renderAdvisory} the only one that decides
 * *wording*. Everything else reads {@link AdvisoryShape}. A new kind is a
 * compile error in exactly those two places, and whoever adds it has to say what
 * it means and what to do about it — which is the drift that put the same blind
 * spot in two independent readers, closed by the compiler rather than by
 * discipline.
 */

/** Something a caller must not assume away. An empty array is the good case. */
export type WorkspaceAdvisory =
  | {
      kind: "deps-building";
      command: string;
      startedAt: number;
      tail?: string;
    }
  | {
      kind: "deps-broken";
      command: string;
      error: string;
      exitCode?: number;
      tail?: string;
      /**
       * Whether a `node_modules` directory is nevertheless sitting there.
       *
       * Reported rather than acted on, because its presence proves nothing in
       * either direction. A half-finished `npm ci` leaves the directory behind
       * with an incomplete tree, so treating existence as success hides the
       * common failure outright; and a subagent that re-ran the install by hand
       * leaves a record the host cannot update, since the host cannot see an
       * install it did not start. Both look identical from here, so the reader
       * is told which way the ambiguity runs rather than being handed a guess.
       */
      treePresent: boolean;
    }
  | { kind: "deps-absent"; reason: string }
  | { kind: "storage-exhausted"; bytes: number; capBytes: number };

/**
 * The three axes every reader decides on, so none of them re-derives severity
 * from a prose string.
 *
 * They are separate because they vary independently, and the combination that
 * proves it is `storage-exhausted`: permanent, reaches every command, and the
 * only one under which writes are lost. Collapsing any pair would have hidden
 * exactly that case.
 */
export interface AdvisoryShape {
  /**
   * Clears with nobody acting, so waiting is useful — and **only** this may
   * block a command.
   *
   * The rule is load-bearing. Blocking on something permanent deadlocks: nothing
   * clears a failed install record except another checkout, so one failure would
   * disable the shell for the rest of the session — `echo hello` included —
   * while the message told the model to re-run the install with the tool that is
   * refusing to run.
   */
  transient: boolean;
  /**
   * Reaches commands that never read `node_modules`.
   *
   * A dependency problem does not; `cat README.md` is unaffected and must not
   * queue behind an install. A full workspace does, because the write that is
   * being lost is usually not a dependency's.
   */
  universal: boolean;
  /** Whether a write made under this survives. `false` is the loudest thing here. */
  writesPersist: boolean;
}

/** What each advisory *means*. The one exhaustive home for policy. */
export function shapeOf(advisory: WorkspaceAdvisory): AdvisoryShape {
  switch (advisory.kind) {
    case "deps-building":
      return { transient: true, universal: false, writesPersist: true };
    case "deps-broken":
      return { transient: false, universal: false, writesPersist: true };
    case "deps-absent":
      return { transient: false, universal: false, writesPersist: true };
    case "storage-exhausted":
      return { transient: false, universal: true, writesPersist: false };
    default: {
      // A new kind lands here as a type error, which is the point: it cannot be
      // added without someone stating whether it is transient, whether it
      // reaches every command, and whether writes survive it.
      const unhandled: never = advisory;
      return unhandled;
    }
  }
}

/**
 * Who is being told, which decides the **verbs** rather than the facts.
 *
 * Not a styling knob. The two readers can do different things, and wording that
 * names an action the reader does not have is worse than silence:
 *
 * - `tool-call` — one shell command, which either ran or did not. It can be told
 *   "nothing was run, call again in a moment".
 * - `session` — a whole `claude -p` run that has not started. There is no
 *   command that failed to run and nothing to call again; it can install
 *   dependencies itself, and it can stop and report.
 */
export type AdvisoryAudience = "tool-call" | "session";

/** Gigabytes, because this is the one place the numbers are that large. */
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A failed install's own last words, fenced so a model reads them as output. */
function quoted(tail: string | undefined): string {
  const trimmed = tail?.trim();
  return trimmed ? `\n\n\`\`\`\n${trimmed}\n\`\`\`` : "";
}

/**
 * One advisory, in words, for one audience. The only place this wording exists.
 *
 * Hosts render nothing themselves. A deployment writing its own copy would be
 * re-deriving severity from `reason` and `error` strings, which is the mistake
 * this file exists to remove — one repository further out, where it is harder to
 * see.
 */
export function renderAdvisory(
  advisory: WorkspaceAdvisory,
  to: AdvisoryAudience
): string {
  switch (advisory.kind) {
    case "deps-building": {
      const elapsed = humanMs(Date.now() - advisory.startedAt);
      const fact =
        `The host is still installing this checkout's dependencies ` +
        `(\`${advisory.command}\`, ${elapsed} so far).${quoted(advisory.tail)}`;
      return to === "tool-call"
        ? `${fact}\n\nAnything importing from \`node_modules\` will fail until ` +
            "it finishes."
        : `${fact}\n\nAnything importing from \`node_modules\` may fail until ` +
            "it finishes. Wait and retry rather than starting a second install " +
            "on top of the one already running.";
    }

    case "deps-broken": {
      const code =
        advisory.exitCode === undefined ? "" : ` (exit ${advisory.exitCode})`;
      // Said once, for both audiences: the tree being there is not evidence the
      // install worked, and a reader that assumes either way gets it wrong half
      // the time.
      const ambiguity = advisory.treePresent
        ? " A `node_modules` directory is present, which settles nothing — a " +
          "failed install leaves a partial one behind. If you re-ran the " +
          "install yourself and it succeeded, this is stale; otherwise the tree " +
          "is incomplete."
        : "";
      const fact =
        `The host's dependency install \`${advisory.command}\` **failed**` +
        `${code}: ${advisory.error}${quoted(advisory.tail)}`;
      return to === "tool-call"
        ? `${fact}\n\nAnything importing from \`node_modules\` will fail until ` +
            `that install is re-run.${ambiguity}`
        : `${fact}\n\nSo \`node_modules\` is missing or incomplete.${ambiguity} Read that ` +
            "output before treating a build or test failure as your own. If it " +
            "looks transient, re-run the install yourself. If it is an " +
            "environment fault you cannot fix from in here — no network, a " +
            "refused registry, a TLS failure — **say exactly that and stop**, " +
            "rather than working around it: that report is the only way the " +
            "operator finds out.";
    }

    case "deps-absent": {
      const fact = `The host installed no dependencies: ${advisory.reason}.`;
      return to === "tool-call"
        ? `${fact}\n\nIf this command needs \`node_modules\`, install them ` +
            "yourself first."
        : `${fact}\n\nIf you need \`node_modules\`, install them yourself first.`;
    }

    case "storage-exhausted": {
      const fact =
        `This workspace holds ${gb(advisory.bytes)} against a ` +
        `${gb(advisory.capBytes)} ceiling, so nothing further can be written ` +
        "to it.";
      return to === "tool-call"
        ? `${fact}\n\nNothing written to this workspace survives. Stop and ` +
            "report this rather than retrying."
        : `${fact}\n\n**Nothing you write here will survive**, including every ` +
            "edit you are about to make. Report this and stop; an operator has " +
            "to reclaim the space or point this caller at a smaller repository.";
    }

    default: {
      const unhandled: never = advisory;
      return unhandled;
    }
  }
}

/** What the host knows, in the shape {@link deriveAdvisories} reads. */
export interface AdvisoryInput {
  /** The durable install record, exactly as the job wrote it. */
  install: InstallState;
  /** Set only when the workspace is over its ceiling. */
  storage?: { bytes: number; capBytes: number };
  /**
   * Whether a `node_modules` directory exists — **existence only, not health**.
   *
   * Named for what it can actually observe. A host probes this with the
   * equivalent of `test -d`, and that answers a narrower question than
   * "are the dependencies fine": a `npm ci` that died partway leaves the
   * directory behind holding an incomplete tree, so a `true` here is entirely
   * consistent with the install having failed for real.
   *
   * So it never suppresses a proven failure. It travels onto the advisory as
   * {@link WorkspaceAdvisory} `treePresent` and the reader is told which way the
   * ambiguity runs. The alternative — treating it as proof of success — is what
   * made a durable record of a failed install disappear on exactly the failure
   * mode it was recording.
   */
  dependencyTreePresent: boolean;
}

/**
 * Everything currently true about a workspace, from what the host can see.
 *
 * An array, and that is not future-proofing. A full workspace and a failed
 * install are both true at once, and a single-slot record could only keep the
 * one written last — so the ceiling silently erased whatever the install had
 * said, or the reverse.
 *
 * Order is severity-descending, so a renderer that shows only the first shows
 * the one that matters.
 */
export function deriveAdvisories(
  input: AdvisoryInput
): readonly WorkspaceAdvisory[] {
  const advisories: WorkspaceAdvisory[] = [];

  // First, because it is the only one under which nothing a caller does sticks.
  if (input.storage) {
    advisories.push({
      kind: "storage-exhausted",
      bytes: input.storage.bytes,
      capBytes: input.storage.capBytes
    });
  }

  const install = input.install;
  switch (install.state) {
    case "running":
      advisories.push({
        kind: "deps-building",
        command: install.command,
        startedAt: install.startedAt,
        ...(install.tail ? { tail: install.tail } : {})
      });
      break;

    case "failed":
      // Always reported. The record is durable evidence that an install failed,
      // and nothing available here is evidence that a later one succeeded — so
      // the presence of a tree qualifies the advisory instead of deleting it.
      advisories.push({
        kind: "deps-broken",
        command: install.command,
        error: install.error,
        treePresent: input.dependencyTreePresent,
        ...(install.exitCode === undefined
          ? {}
          : { exitCode: install.exitCode }),
        ...(install.tail ? { tail: install.tail } : {})
      });
      break;

    case "skipped":
      advisories.push({ kind: "deps-absent", reason: install.reason });
      break;

    // Nothing to say. `idle` means no install has been armed yet, which the
    // host's cold-container check resolves on its own, and `done` is the
    // ordinary case — a caller told its dependencies are fine has been told
    // nothing, at the cost of prefix tokens on every run.
    case "idle":
    case "done":
      break;

    default: {
      const unhandled: never = install;
      return unhandled;
    }
  }

  return advisories;
}

/**
 * Everything a session should know before it starts, or `undefined` for silence.
 *
 * The counterpart to {@link file://./gate.ts execGate}, for the reader that is a
 * whole run rather than one command. It cannot be blocked and does not need to
 * be: it can install dependencies itself, and the only thing it must not do is
 * work silently against a workspace that is not what it assumes.
 */
export function sessionAdvisory(
  advisories: readonly WorkspaceAdvisory[]
): string | undefined {
  if (advisories.length === 0) return undefined;
  return advisories.map((a) => renderAdvisory(a, "session")).join("\n\n");
}
