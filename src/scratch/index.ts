import { tool } from "ai";
import { z } from "zod";
import { definePlugin } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";

/**
 * `@dynamicagents/plugins/scratch` — a place to work that is not a repository.
 *
 * ## The gap this closes
 *
 * An agent with a container and a git plugin can do a great deal, and all of it
 * starts with a clone. That is right for the work such an agent mostly does and
 * wrong for the rest of it: "check what this actually returns", "write a script
 * and run it", "try that regex against these twenty lines" each need a container
 * and none of them needs a repository.
 *
 * With no way to say so, an agent asks for one. The deployment this was written
 * for had a coding agent ask its user for an **empty repository to clone** so it
 * could run a script in the checkout — which is a workaround for a missing verb,
 * and a good sign the verb is missing.
 *
 * ## A scratchpad is a repository whose remote is nowhere
 *
 * That framing is the design, and it is why this plugin is small. Everything a
 * host already does for a checkout applies unchanged: it is a git repository, so
 * a cancelled task's edits can be reset out of it; it lives in the workspace, so
 * it is durable and reclaimed the same way; and it goes through the host's own
 * workspace selection, so it is keyed, routed and cleaned up by the machinery
 * that already exists rather than by a second mechanism alongside it.
 *
 * It has no `origin`, which is the property that makes it safe to let a session
 * do as it likes in: nothing here is ever pushed anywhere.
 *
 * ## What the host owns
 *
 * The same split [`/repo`](../repo/) makes, and for the same reason — this plugin
 * knows what a scratchpad *is*, the host knows how it addresses one:
 *
 * - {@link ScratchConfig.beforeOpen} selects the workspace, before anything runs.
 * - {@link ScratchConfig.afterOpen} records it, and says whether the host can
 *   actually see it.
 *
 * A host that wires neither still gets a working scratchpad, as long as its
 * workspace is not keyed per repository.
 */

/** Where a scratchpad lives, unless the host says otherwise. */
export const DEFAULT_SCRATCH_DIR = "/workspace/scratch";

/** The generic identity a scratchpad's commits carry. Matches `/repo`'s. */
const DEFAULT_AUTHOR = {
  name: "da-coder",
  email: "coder@dynamicagents.invalid"
};

/** Ceiling on what this tool returns to the model, in characters. */
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

/** How many lines of a dirty tree are worth reciting back. */
const STATUS_MAX_LINES = 20;

/**
 * Run one command in the host's container. Matches `computerExec`'s shape.
 *
 * Injected rather than imported, like `/repo`'s: `npm run verify:exports` fails
 * any subpath whose module graph reaches a sibling's, and a scratchpad that
 * dragged the whole container plugin into every consumer's bundle would cost far
 * more than it is worth.
 */
export type ScratchExec = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    /**
     * The executing subtask's runtime state, forwarded **opaquely** — the same
     * pass-through `/repo` does, for the same reason. This plugin never looks
     * inside it.
     */
    runtime?: unknown;
    /**
     * The calling tool's cancellation. An implementation that reaches a container
     * is expected to honour it, since a hung command is the one thing this plugin
     * cannot bound for itself; `computerExec` kills the command on abort.
     */
    signal?: AbortSignal;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** What {@link ScratchConfig.afterOpen} is told. */
export interface Scratchpad {
  /** Absolute path of the scratchpad's working tree. */
  dir: string;
  /**
   * True when this call initialised the repository — either because there was
   * none, or because the one there was incomplete.
   *
   * **Not a claim that the tree is empty.** `git init` leaves whatever is in the
   * directory exactly where it is, so a scratchpad whose repository had to be
   * established over existing files is `fresh` and full. Only a reset makes it
   * empty, which is why nothing here reads this to decide what is in the tree.
   */
  fresh: boolean;
}

/**
 * Whether the scratchpad is usable, as far as the host can tell.
 *
 * `ready: false` is reported to the model as something to retry, not as a
 * failure of the open — the tree is on disk either way.
 */
export interface ScratchReadiness {
  ready: boolean;
  /** One clause naming what is not ready, appended to the retry sentence. */
  because?: string;
}

export interface ScratchConfig {
  /**
   * Runs commands in the container holding the workspace.
   *
   * Uncredentialed, and nothing here ever needs a credential: a scratchpad has
   * no remote, so no operation in this plugin talks to a forge.
   */
  exec: ScratchExec;
  /** Where the scratchpad lives. Defaults to {@link DEFAULT_SCRATCH_DIR}. */
  dir?: string;
  /** Committer identity. Defaults to a generic agent identity. */
  author?: { name: string; email: string };
  /**
   * Ceiling on what this tool returns to the model, in **characters**.
   * Defaults to 16,000, matching `/computer` and `/repo`.
   */
  maxOutputChars?: number;
  /**
   * Called before anything runs — the host's chance to select its workspace.
   *
   * The mirror of `RepoConfig.beforeCheckout`, and the ordering is the same
   * point: a host that keys its container or its filesystem per repository has
   * to have switched **before** the first command, or `git init` lands in
   * whichever workspace the last task left open.
   *
   * Synchronous on purpose. The only sensible thing to do here is record a
   * selection; a host that needs I/O has the ordering wrong. A throw fails the
   * open, because a host that could not choose a workspace has not chosen one.
   */
  beforeOpen?: () => void;
  /**
   * Called once the scratchpad is on disk, so the host can record where it is —
   * and say whether it can see it.
   *
   * **This returns a value where `RepoConfig.afterCheckout` returns `void`, and
   * the difference is deliberate.** This plugin knows `git init` exited 0.
   * Whether the host's durable record agrees is host knowledge, and it is
   * exactly the disagreement worth surfacing here: a tool that reports success
   * followed by a delegation that refuses to start is the worst version of this
   * failure, because the two are reported in different places and nothing
   * connects them.
   *
   * **A throw reaches the model**, where `afterCheckout`'s is caught and logged.
   * A clone is still useful to an agent whose follow-up hook failed; a
   * scratchpad the host did not record cannot be delegated into at all, so
   * silence would promise something that is not there.
   *
   * Returning nothing means "no opinion", which is treated as ready.
   */
  afterOpen?: (scratch: Scratchpad) => Promise<ScratchReadiness | void>;
}

/**
 * Bound what reaches the model, keeping both ends.
 *
 * A copy rather than an import, for the reason {@link ScratchExec} is injected:
 * `verify:exports` fails any subpath that reaches a sibling's files, and `/repo`
 * carries the same copy for the same reason.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

/**
 * What one command produced — plus one bit the container did not report.
 *
 * `exec` does not only return failures, it throws them: `@cloudflare/computer`
 * throws when a container is replaced mid-command, and a call to a Durable
 * Object can fail outright. `unreachable` keeps that distinguishable from a
 * command that ran and said no, which three branches below depend on.
 */
interface Ran {
  success: boolean;
  stdout: string;
  stderr: string;
  unreachable?: true;
}

/** The tool name, exported so a host restricting its main agent can name it. */
export const SCRATCH_OPEN_TOOL = "scratch_open";

/**
 * What the delegating agent is told.
 *
 * The mixing rule at the end is the line worth its tokens. A host that keys one
 * workspace selection per caller — which is what makes a scratchpad routable at
 * all — points *every* other workspace tool at whatever was selected last. So an
 * agent that opens a scratchpad half-way through work on a checkout has quietly
 * moved its own `repo_diff` and `repo_commit` with it. That is a property of the
 * host's routing rather than something this plugin can prevent, so the model is
 * told the rule instead of being left to discover it.
 */
function capabilityFor(dir: string): string {
  return [
    "## A scratchpad, for work that is not a repository",
    "",
    `\`${SCRATCH_OPEN_TOOL}\` gives you a container to work in without cloning anything: a git`,
    `repository at \`${dir}\` with no remote. Reach for it when the request needs code`,
    "to *run* rather than a repository to change — checking what something actually",
    "returns, writing and running a throwaway script, trying an approach out before",
    "committing to it.",
    "",
    "Open it, then delegate the work as usual; work happens in it exactly as it would",
    "in a checkout. It is durable, so a later task finds whatever the last one left",
    "there. Pass `reset: true` to start from an empty tree.",
    "",
    "**Nothing in it is ever pushed.** There is no remote, so there is no branch to",
    "push and no pull request to open — the work itself, and what you learned from it,",
    "is the deliverable. Say so plainly when you report back.",
    "",
    "**One task works in one place.** A task is either working in a cloned repository",
    "or in the scratchpad. Opening the scratchpad points every other workspace tool you",
    "hold at it, so do not open it part-way through work on a checkout — finish that",
    "first."
  ].join("\n");
}

/**
 * Whether there is a usable scratchpad at `$SCRATCH_DIR`, asked from a directory
 * that certainly exists.
 *
 * Three properties, and each rules out a state that reads as "ready" and is not:
 *
 * - **Run from `/`.** A command's own working directory has to exist before the
 *   command starts, so asking this from inside the scratchpad makes the very
 *   first open — the one where the directory is not there yet — fail before git
 *   runs, and be indistinguishable from a container that did not answer.
 * - **`.git` in the scratchpad itself**, not `rev-parse` from within it: that
 *   walks upwards and answers yes for a scratchpad sitting anywhere inside
 *   another repository, whose tree a later reset would then discard.
 * - **`HEAD` resolves.** A repository with no commit is not usable here — see
 *   {@link INIT_COMMAND} — and it is a reachable state, because `git init` and
 *   the commit after it are two commands and only the pair is meaningful.
 *
 * Anything less than all three sends the caller to {@link INIT_COMMAND}, which
 * repairs each of them and leaves an existing tree alone.
 */
const PROBE_COMMAND =
  'test -e "$SCRATCH_DIR/.git" && ' +
  'git -C "$SCRATCH_DIR" rev-parse --verify -q HEAD >/dev/null';

/**
 * Establish a scratchpad: a git repository with a commit in it.
 *
 * **The empty commit is load-bearing.** Without it the repository has no `HEAD`,
 * and `git reset --hard` fails outright — which is what a host runs to discard a
 * cancelled task's edits. That cleanup is best-effort in every host that has one,
 * so the failure is a logged warning plus a cancelled run's files surviving into
 * the next task as its starting point.
 *
 * **Safe to run against a directory that already holds something**, which is what
 * makes it a repair as well as a creation: `git init` on an existing repository
 * re-initialises without touching the tree, and `--allow-empty` commits nothing,
 * so a scratchpad left half-built by an interrupted open gains the `HEAD` it was
 * missing and keeps its files.
 *
 * Every value arrives through the environment rather than the command text —
 * the identity so a configured name containing a quote stays a value, and the
 * directory because double quotes still expand `$(…)`, backticks and variables,
 * so a host path containing any of them would otherwise be shell rather than a
 * path. The identity is set repo-locally for the reason `/repo` sets it there: a
 * global identity in the container would attach itself to any other repository
 * sharing it.
 */
const INIT_COMMAND = [
  'mkdir -p "$SCRATCH_DIR"',
  'cd "$SCRATCH_DIR"',
  "git init -q",
  'git config user.name "$GIT_NAME"',
  'git config user.email "$GIT_EMAIL"',
  'git commit -q --allow-empty -m "scratchpad"'
].join(" && ");

/**
 * Empty the scratchpad.
 *
 * **`-ff`, not `-f`.** A single force leaves untracked *nested repositories*
 * where they are, so a task that cloned or initialised something inside the
 * scratchpad would survive a reset this tool reports as having emptied it — and
 * a scratchpad is exactly where that happens, since cloning something to look at
 * it is one of the things it is for. The second force is what makes the promise
 * true. It is safe to make here in a way it would not be in a checkout: nothing
 * in a scratchpad is tracked by anything else, and nothing in it is ever pushed.
 */
const RESET_COMMAND = "git reset --hard -q && git clean -ffdxq";

export function scratch(config: ScratchConfig): AgentPlugin {
  const dir = config.dir ?? DEFAULT_SCRATCH_DIR;
  const author = config.author ?? DEFAULT_AUTHOR;
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  /**
   * The seam where an unreachable container stops being an exception.
   *
   * Every branch below has to tell "the container did not answer" apart from
   * "git answered no" — read as the latter, a lost connection would re-init over
   * a healthy scratchpad and discard what an earlier task left in it. The same
   * distinction `/repo` draws before it clones over a directory.
   */
  const run = async (
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      runtime?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<Ran> => {
    try {
      return await config.exec(command, {
        cwd: dir,
        ...options,
        // Always, and merged over whatever the caller passed: every command here
        // names the scratchpad, and none of them may spell it in shell text.
        env: { ...options?.env, SCRATCH_DIR: dir }
      });
    } catch (err) {
      // A cancel is not an unreachable container. Reported as one, it would tell
      // the model to try again in a moment; rethrown, the call ends as what it was.
      if (options?.signal?.aborted) throw err;
      console.warn("[scratch] the container could not be reached", {
        command,
        err: String(err)
      });
      return {
        success: false,
        stdout: "",
        stderr: String(err),
        unreachable: true
      };
    }
  };

  /**
   * What is in the tree, in one sentence.
   *
   * Worth a command because the alternative is a model assuming an empty
   * scratchpad and writing a brief for one — a durable workspace carries the
   * same warning wherever it is described.
   *
   * **Only a reset is allowed to skip it.** Establishing the repository is not
   * the same as establishing an empty tree: `git init` over a directory that
   * already holds files leaves every one of them, so the one call that can
   * answer this without asking is the one that just deleted everything.
   */
  const describeTree = async (
    knownEmpty: boolean,
    runtime: unknown,
    signal?: AbortSignal
  ): Promise<string> => {
    if (knownEmpty) return "It is empty.";
    const listed = await run("git status --porcelain", { runtime, signal });
    // Silence rather than a guess: the scratchpad is open either way, and "it is
    // empty" would be a claim this command did not support.
    if (!listed.success) return "";
    const lines = listed.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "Its working tree is clean.";
    const shown = lines.slice(0, STATUS_MAX_LINES).join("\n");
    const rest =
      lines.length > STATUS_MAX_LINES
        ? `\n… and ${lines.length - STATUS_MAX_LINES} more`
        : "";
    return `It currently holds:\n${shown}${rest}`;
  };

  const open = async (
    reset: boolean | undefined,
    runtime: unknown,
    signal?: AbortSignal
  ): Promise<string> => {
    /**
     * First, and before anything that resolves a workspace.
     *
     * The ordering `/repo` gets from `beforeCheckout`: `exec` runs wherever the
     * host's selection points, so a command issued before this line runs in
     * whichever workspace the last task left open.
     */
    config.beforeOpen?.();

    const existing = await run(PROBE_COMMAND, { cwd: "/", runtime, signal });
    if (existing.unreachable) {
      return truncateOutput(
        "could not reach the container to open the scratchpad: " +
          `${existing.stderr.trim() || "no answer"}\n` +
          "Nothing was created or changed. Try again in a moment.",
        maxChars
      );
    }

    let fresh = false;
    if (!existing.success) {
      // From a directory that exists, since the first thing this command does is
      // create the one the rest of it runs in.
      const init = await run(INIT_COMMAND, {
        cwd: "/",
        env: { GIT_NAME: author.name, GIT_EMAIL: author.email },
        runtime,
        signal
      });
      if (!init.success) {
        return truncateOutput(
          `could not create the scratchpad at ${dir}: ` +
            `${init.stderr.trim() || init.stdout.trim() || "git init failed"}`,
          maxChars
        );
      }
      fresh = true;
    } else if (reset) {
      const cleaned = await run(RESET_COMMAND, { runtime, signal });
      if (!cleaned.success) {
        return truncateOutput(
          `the scratchpad at ${dir} could not be reset: ` +
            `${cleaned.stderr.trim() || cleaned.stdout.trim() || "git failed"}\n` +
            "It is still there and still usable, but it holds whatever it held before.",
          maxChars
        );
      }
    }

    // Deliberately not caught — see `afterOpen`. A scratchpad the host did not
    // record cannot be delegated into, so reporting it as open would promise
    // something that is not there.
    const readiness = await config.afterOpen?.({ dir, fresh });
    if (readiness && !readiness.ready) {
      return truncateOutput(
        `the scratchpad at ${dir} was ${fresh ? "created" : "opened"}, but it is ` +
          `not usable yet${readiness.because ? `: ${readiness.because}` : ""}. ` +
          `Call ${SCRATCH_OPEN_TOOL} again before delegating.`,
        maxChars
      );
    }

    const opened = reset
      ? `Opened the scratchpad at ${dir} and emptied it.`
      : fresh
        ? `Opened a scratchpad at ${dir}.`
        : `Reopened the scratchpad at ${dir}, which an earlier task may have left files in.`;

    return truncateOutput(
      [
        opened,
        "It is a git repository with no remote, so nothing in it is pushed anywhere.",
        await describeTree(reset === true, runtime, signal)
      ]
        .filter(Boolean)
        .join(" "),
      maxChars
    );
  };

  return definePlugin({
    key: "scratch",

    /**
     * The main agent's, and no tool family — which is a decision rather than an
     * omission.
     *
     * Opening a scratchpad *selects a workspace*, exactly as `repo_clone` does.
     * A subagent holding this could re-point the workspace its parent prepared
     * half-way through its own run, which is the hazard a host's per-caller
     * selection already has to document. A delegated run works in whatever it
     * was given.
     */
    mainAgentTools: () => ({
      [SCRATCH_OPEN_TOOL]: tool({
        description:
          "Open a scratchpad: a git repository with no remote, in your container, " +
          "for work that does not need a cloned repository. Use it before " +
          "delegating anything that needs to run code but has no repository to " +
          "change. Nothing in it is ever pushed.",
        inputSchema: z.object({
          reset: z
            .boolean()
            .optional()
            .describe(
              "Discard everything in the scratchpad first, including files an earlier task left"
            )
        }),
        execute: ({ reset }, { abortSignal }) =>
          open(reset, undefined, abortSignal)
      })
    }),

    capability: capabilityFor(dir)
  });
}
