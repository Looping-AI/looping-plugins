import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin, withAbort } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import { getWorkspace, shellQuote } from "@cloudflare/computer";
import type { WorkspaceClient, WorkspaceStub } from "@cloudflare/computer";
import { guardPath } from "./paths.js";
import {
  cancelledNote,
  humanBytes,
  packBlocks,
  renderGrepMatches,
  renderResult
} from "./render.js";
import {
  collectVisible,
  listingNote,
  pathExists,
  readBounded,
  readWindow
} from "./read.js";
import { execGate, execLostNote, writeGate, type ExecGate } from "./gate.js";
import type { WorkspaceAdvisory } from "./advisory.js";

/**
 * `@dynamicagents/plugins/computer` — a Linux container whose filesystem outlives it.
 *
 * The filesystem **is** a Durable Object's SQLite, mounted into the container
 * over FUSE by `computerd`. Commands see a normal `/workspace`; the Worker reads
 * the same tree over RPC; and when the container is replaced the tree is pushed
 * back into the new one.
 *
 * Not to be confused with `@dynamicagents/plugins/workspace`, which is a virtual
 * filesystem with no processes and nothing to run. Install exactly one
 * filesystem plugin — an agent holding two gives the model no way to know which
 * one a path refers to.
 *
 * ## `node_modules` is **not** in the workspace
 *
 * The one thing to internalise before reading further. `computerd` excludes it
 * from the sync, and the exclusion is right: pushing a real one (429 MB, 22,470
 * files) into the object exceeds the Durable Object's 128 MB isolate memory
 * limit, leaving the tree silently short — and the reconciliation that follows
 * propagates the shortfall back into the container.
 *
 * So dependencies live in the container and die with it, while source and `.git`
 * are durable. Two consequences run through everything below: an install has to
 * be re-run on a cold container, and `sb_read` cannot see a path under
 * `node_modules` even though a shell in the same container can.
 *
 * Requires the Workers **Paid** plan (containers) and a Durable Object binding
 * whose class owns the workspace — see the README for the wrangler block.
 */

/**
 * How a repository installs its dependencies — the mechanical half.
 *
 * Re-exported from the plugin's one entry point rather than given a subpath of
 * its own: `verify:exports` treats each subpath as an isolated realm, and a host
 * needs the resolver and the tools together anyway.
 */
export {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallPlan,
  type InstallProbe,
  type InstallResolution,
  type InstallRule,
  type InstallState
} from "./install.js";

/**
 * The helpers this plugin's own tests and hosts reach for, re-exported from the
 * one entry point.
 *
 * They live in sibling modules — `paths.ts`, `render.ts`, `gate.ts` — because
 * this file was 1,900 lines and the seams were obvious. The subpath is the unit a
 * consumer imports, so what it exports must not move when the files behind it do:
 * `verify:exports` treats `./computer` as one realm, and everything below stays
 * inside `dist/computer/`.
 */
export { isContainerOnly, isGitInternal } from "./paths.js";
export {
  cancelledNote,
  packBlocks,
  renderGrepMatches,
  renderResult,
  truncateOutput
} from "./render.js";
export {
  execGate,
  needsDependencies,
  writeGate,
  type ExecGate
} from "./gate.js";
/**
 * The workspace-advisory vocabulary, which a host needs all of: the type to
 * return over RPC, `deriveAdvisories` to build it from what it already knows,
 * and `sessionAdvisory` for a host driving a whole session rather than one
 * command. `shapeOf` and `renderAdvisory` are exported for the specs that hold
 * their exhaustiveness — a host has no reason to call either, since calling them
 * would mean writing policy or wording that has one home already.
 */
export {
  deriveAdvisories,
  renderAdvisory,
  sessionAdvisory,
  shapeOf,
  type AdvisoryAudience,
  type AdvisoryInput,
  type AdvisoryShape,
  type WorkspaceAdvisory
} from "./advisory.js";
// A host implementing `InstallProbe` needs exactly this, and hand-rolling it
// loses the fast path: across a Durable Object boundary `fs` is a stub carrying
// `exists`, which a `stat`-only probe never asks for.
export { pathExists } from "./read.js";

/**
 * This plugin's tool-family name, as a recipe's `toolFamilies` lists it.
 *
 * `"sandbox"` names the capability — a shell and a filesystem — rather than the
 * package providing it, and it appears in recipes, souls and allowlists that
 * have nothing to do with either. Renaming it would have `validateRecipe`
 * silently drop the family from every recipe that still says `sandbox`: a
 * subagent with no tools and no error explaining why.
 */
export const SANDBOX_FAMILY = "sandbox";

/**
 * Where a parent puts the workspace name so its subagents reach the same one.
 *
 * A subagent cannot compute this itself. The name is derived from the verified
 * caller and the repository, and core deliberately gives a subagent execution a
 * `callerKey` thunk that **throws** — "a subagent execution has no caller
 * identity". So a facet running a `code` subtask would fail at its first tool
 * call, with the parent's checkout sitting in a workspace it cannot name.
 *
 * `resolveRuntime` runs on the parent, where the name resolves, and its return
 * value reaches every tool family as `ToolFamilyContext.runtime`. That is the
 * channel core built for exactly this, and it is emphatically *not* `params`,
 * which are declared in the subtask type's schema and rendered to the delegating
 * model — a workspace name there would be model-authored, and a model naming
 * another caller's workspace would get that caller's files.
 */
export const WORKSPACE_RUNTIME_KEY = "workspaceName";

/**
 * Read a parent-resolved workspace name off a subtask's runtime state.
 *
 * Returns `undefined` rather than throwing on anything unexpected: the main
 * agent's tools have no runtime at all, and falling back to the configured thunk
 * is right there.
 */
export function workspaceNameFromRuntime(runtime: unknown): string | undefined {
  const value = (runtime as Record<string, unknown> | null | undefined)?.[
    WORKSPACE_RUNTIME_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * How much command output the model is allowed to see, in characters.
 *
 * One `npm install` prints more than a small context window holds, and the
 * interesting part of a failing build is the first error and the last summary —
 * never the middle. So output is truncated from the middle rather than the end,
 * which is what a naive `slice` would do and would drop the exit summary that
 * says what actually failed.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

/**
 * How many directory entries one `sb_ls` returns.
 *
 * A bound on the *listing*, not on the rendered text — `maxOutputChars` still
 * applies on top, and the order matters. Bounding only the text means `readdir`
 * returns every entry and the isolate holds all of them before the ceiling
 * discards the tail; a real `node_modules` is 22,470 files, and a misbehaving
 * build is exactly when someone lists one. `readdir` takes a `limit`, so the
 * bound is applied where the entries are read.
 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * How many matches one `sb_grep` returns.
 *
 * Bounded at the source like {@link DEFAULT_MAX_ENTRIES}, and for a sharper reason
 * than a listing: without a `limit`, `fs.grep` reads *every* file under the path
 * looking for more. `.git` is in the workspace, so an unbounded search of
 * `/workspace` streams every loose object through the isolate before answering.
 * The limit is what stops that walk early.
 */
const DEFAULT_MAX_MATCHES = 200;

/** A command that has not finished in this long is a hung command. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Where checkouts live, in the container and in the workspace alike. */
const DEFAULT_CWD = "/workspace";

/**
 * How often the install gate re-reads the install's status.
 *
 * An interval rather than a subscription because the status lives in another
 * Durable Object with no event to wait on. Never slept past the gate itself —
 * see `awaitInstall`.
 */
const INSTALL_POLL_MS = 3_000;

/**
 * The Durable Object the workspace lives in, as this plugin needs to see it.
 *
 * Structural rather than imported: the class is the host's — it owns the
 * container binding, the alarm and the install job — and a plugin that imported
 * it would stop a second host from bringing its own. `__getWorkspaceStub` is the
 * one method `getWorkspace()` calls across the boundary, and it is what
 * `withWorkspace` installs (or what a host that constructs `Workspace` itself
 * reimplements, which is the same three lines).
 */
export interface WorkspaceHost extends Rpc.DurableObjectBranded {
  // Typed as `WorkspaceStub` rather than `unknown`, and not for documentation:
  // Workers RPC maps an `unknown` return to `never`, which makes any concrete
  // Durable Object class fail to satisfy this interface.
  __getWorkspaceStub(): Promise<WorkspaceStub>;
  /**
   * Everything currently true about the workspace that a caller must not assume
   * away — see {@link file://./advisory.ts}. An empty array is the good case.
   *
   * Required rather than optional, and not only because Workers RPC types an
   * optional method as a union nothing can call. A host with nothing to report
   * returns `[]` in one line; a host that forgot to expose it gets a compile
   * error instead of an `sb_exec` that silently runs against a half-built
   * `node_modules`, or against a workspace whose writes are being dropped.
   *
   * `deriveAdvisories` builds the array from what the host already knows, so
   * implementing this is gathering three values rather than writing policy.
   */
  advisories(): Promise<readonly WorkspaceAdvisory[]>;
}

/**
 * Open the workspace behind a Durable Object stub.
 *
 * The cast is unavoidable, and narrow enough to be worth isolating here rather
 * than repeating. `getWorkspace` wants a handle whose `__getWorkspaceStub()`
 * resolves to a `WorkspaceStub` — the concrete class, private fields and all.
 * Across a Durable Object boundary Workers RPC hands back a structural
 * `Stub<WorkspaceStub>`, which forwards every method faithfully but carries none
 * of the class's private brand: runtime-compatible, type-incompatible. This is
 * the only place in the plugin that gap is crossed.
 */
function openWorkspace(
  host: DurableObjectStub<WorkspaceHost>
): Promise<WorkspaceClient> {
  return getWorkspace(host as unknown as Parameters<typeof getWorkspace>[0]);
}

/**
 * The shell wrapper both variants share, minus the choice they differ on.
 *
 * One quoted argument, not string concatenation: the command is model-authored
 * and routinely contains quotes of its own (`git commit -m "…"`), so anything
 * less than `shellQuote` re-parses the model's quoting and mangles it.
 *
 * ## Why `-o pipefail`
 *
 * Without it a pipeline's exit status is its **last** stage's, so
 * `npm run check | tail -100` reports `exit 0` for a gate that failed outright —
 * and models pipe into `tail` constantly. A tool that reports success for a
 * failed build is worse than one that reports nothing. It also costs a re-run
 * every time: a model that cannot trust a piped exit code runs the whole thing
 * again unpiped to get one.
 *
 * The trade is worth stating. `pipefail` surfaces SIGPIPE too, so
 * `ls big-dir | head -1` reports 141 rather than 0 — noisy, but *visible*, where
 * the alternative is a failing gate that looks clean. The tool description tells
 * the model not to pipe into `head`/`tail` at all, since output is already
 * truncated with both ends kept.
 *
 * Requires a shell that implements it — `bash`, `zsh`, `ksh`, not `sh`/dash. A
 * host setting {@link ComputerConfig.shell} is choosing that shell explicitly.
 */
function wrapped(command: string, shell: string): string {
  return `${shell} -o pipefail -c ${shellQuote(command)}`;
}

/**
 * Run a command under {@link ComputerConfig.shell} with its two output streams
 * left as they are, or hand it back untouched when no shell is configured.
 *
 * This is the variant for a caller that **reads the result in code**: `stdout` is
 * a data channel it compares or parses, and `stderr` is a separate diagnostic.
 * {@link computerExec} is that caller, on behalf of `@dynamicagents/plugins/repo`,
 * which asks git questions like `symbolic-ref --short refs/remotes/origin/HEAD`
 * and `rev-list --count` and needs the answer alone.
 *
 * Two functions rather than one with a flag, because the difference is a change
 * to the *output contract* and a boolean hides it at the call site. Merging the
 * streams here would give every `/repo` git command an empty `stderr` and a
 * `stdout` that is a transcript rather than an answer — which fails silently,
 * since the commands `/repo` parses are quiet ones and a single `warning:` is
 * enough to skip the empty-branch guard.
 */
export function withShell(command: string, shell: string | undefined): string {
  return shell ? wrapped(command, shell) : command;
}

/**
 * Run a command under {@link ComputerConfig.shell} with its two output streams
 * merged into one transcript, in the order they were written.
 *
 * This is the variant for a caller whose consumer is **a model reading output**.
 * `sb_exec` is that caller. A project's check is a chain — `wrangler types &&
 * prettier && eslint && tsc` — and *which tool spoke last* is how you know which
 * one failed. A stdout block and a separate stderr block destroy that ordering,
 * and a model that wants it back re-runs the whole gate as
 * `npm run check > /tmp/out 2>&1; cat /tmp/out`. This is that workaround, done
 * once, for free.
 *
 * The redirect binds to the wrapper process, so it applies to everything the
 * command writes however deeply nested — and there is no inner brace group or
 * subshell to mis-parse a command that already contains `&&`, quotes or redirects
 * of its own.
 *
 * With no shell configured there is no wrapper process to redirect, so the
 * command goes to the runtime untouched and the two streams arrive separate.
 * That is not a gap: {@link renderResult} renders them as a labelled
 * `--- stderr ---` block for exactly this case. The transcript is the better
 * answer, not the only supported one.
 */
export function withShellTranscript(
  command: string,
  shell: string | undefined
): string {
  return shell ? `${wrapped(command, shell)} 2>&1` : command;
}

export interface ComputerConfig {
  /**
   * The Durable Object namespace holding workspaces, closed over at
   * instantiation so it is never model input.
   */
  binding: DurableObjectNamespace<WorkspaceHost>;
  /**
   * Which workspace this agent gets, by name. A thunk because the useful name —
   * caller plus repository — does not exist when the plugin list is built.
   *
   * One workspace is one container is one repository: `@cloudflare/computer`
   * pairs a Durable Object with exactly one container, so "never mix two
   * repositories" is structural here rather than a convention to maintain.
   */
  workspaceName: () => string;
  /** Working directory for every command. Defaults to `/workspace`. */
  cwd?: string;
  /**
   * Run every command through this shell, e.g. `"bash"`. Unset, the command
   * string goes to the runtime as-is and lands on whatever `/bin/sh` is.
   *
   * Worth setting, because "whatever `/bin/sh` is" is **dash** on Debian and
   * Ubuntu, and a model writing shell writes *bash*. `${PIPESTATUS[0]}` is the
   * one that costs most — a bash builtin a model reaches for to read a piped exit
   * code, which dash fails with exit 2, after the command it wrapped has already
   * run. It is one member of a family (`[[ ]]`, arrays, `set -o pipefail`,
   * process substitution), so the fix is the shell rather than a note in a prompt
   * telling the model to write POSIX.
   *
   * Set it only if the image actually has that shell: a missing one fails *every*
   * command rather than the bash-flavoured ones.
   */
  shell?: string;
  /** Per-command timeout. Defaults to ten minutes. */
  timeoutMs?: number;
  /**
   * Output ceiling per command, in **characters**. Defaults to 16,000.
   *
   * Characters — JavaScript `String.length`, UTF-16 code units — and not bytes,
   * which is what this was called and was never measuring. The renderers all
   * budget with `.length`, so 16,000 `✓` passed a "16,000 byte" ceiling while
   * occupying 48,000 UTF-8 bytes: three times the advertised limit, on exactly
   * the output a non-English repository produces.
   *
   * Characters are also the right unit for what this bounds. The ceiling exists
   * to protect a context window, which is measured in tokens, and tokens track
   * characters far better than they track UTF-8 bytes. So the name moved to meet
   * the implementation rather than the other way round.
   *
   * `sb_read` is the one place a byte bound survives, and it is derived from
   * this rather than separate — see `readBounded`.
   */
  maxOutputChars?: number;
  /**
   * How long `sb_exec` waits for a running dependency install before giving the
   * turn back. Defaults to 90 seconds.
   *
   * Bounded rather than open-ended because the wait happens inside a subagent's
   * chunk, and a tool call that blocks for the length of an `npm ci` is exactly
   * the thing moving the install out of the round loop was meant to prevent. On
   * expiry the tool runs nothing and says so, which costs one cheap turn.
   */
  installGateMs?: number;
  /**
   * Environment merged into every command **these tools** run — a registry host,
   * a `CI` flag, proxy settings. Host-supplied and never model input.
   *
   * "These tools" is exact: {@link computerExec} deliberately does not merge it,
   * so a proxy set here does not reach the git that `@dynamicagents/plugins/repo`
   * runs through that export. The reasoning, and how a host opts in explicitly,
   * is written up there.
   *
   * ## Put no secret here
   *
   * *Every* command gets this environment, and `sb_exec`'s command is written by
   * the model: `sb_exec("printenv")` prints all of it, and so does a
   * `postinstall` script in a repository the agent was asked to clone, which
   * nobody vetted.
   *
   * What per-command passing buys is narrower and worth keeping: the value is not
   * set on the container, so a process started outside these tools — a dev server
   * left running from an earlier task — does not inherit it, and it is not in
   * `/proc/1/environ`. That is a real property. It is not confidentiality from
   * the model.
   *
   * ## What to do with a secret instead
   *
   * Do not hand the agent the credential; hand it the *action*. Keep the secret
   * on the Worker and expose one tool that makes the call it is for.
   * `@dynamicagents/plugins/repo` is the worked example: it holds a forge token, calls
   * the API from the Worker, and runs clone, fetch and push on the host's side of
   * the boundary. **No command in its container is ever given that token.**
   */
  env?: () => Record<string, string | undefined>;
}

export function buildComputerTools(
  workspace: () => Promise<WorkspaceClient>,
  config: ComputerConfig,
  advisories?: () => Promise<readonly WorkspaceAdvisory[]>
): ToolSet {
  const cwd = config.cwd ?? DEFAULT_CWD;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const gateMs = config.installGateMs ?? 90_000;
  const env = config.env;

  /**
   * Wait out anything transient, up to the gate, and report whatever is left.
   *
   * Polled rather than subscribed: the state lives in another Durable Object,
   * there is no event to wait on, and the whole window is under two minutes.
   *
   * **Read for every command, including the ones that need no dependencies.**
   * That is a change of shape, not a slip. The filter that spares `cat
   * README.md` from queueing behind an `npm ci` lives in `execGate`, where it
   * applies per advisory — because a dependency install and a full workspace are
   * not relevant to the same commands, and applying one filter to both is what
   * made a workspace at its ceiling silent for exactly the commands whose writes
   * it was dropping. The cost is one same-colo RPC on commands that previously
   * skipped it, against a class of silent data loss.
   */
  const awaitAdvisories = async (
    command: string,
    signal?: AbortSignal
  ): Promise<ExecGate> => {
    if (!advisories) return {};

    // Fails **open**, and that belongs here rather than at the call site: this
    // is a read of another Durable Object's state. An error must not take out a
    // working shell — running the command is exactly what would have happened
    // before the gate existed, and a spurious blockage would strand the
    // subagent.
    const read = async (): Promise<readonly WorkspaceAdvisory[]> => {
      try {
        return await advisories();
      } catch {
        return [];
      }
    };

    // Clamped to whatever is left of the gate, not the bare interval. A fixed
    // sleep makes `installGateMs` a floor rather than the ceiling it is
    // documented to be: at a 100 ms gate the loop still slept the full three
    // seconds before looking again, so a public timeout overshot by 30×.
    const deadline = Date.now() + gateMs;
    let current = await read();
    // Keyed on the gate's own verdict rather than on a state name, so "what is
    // worth waiting for" has one definition and it is the one that will decide
    // the outcome.
    while (execGate(current, command).block && Date.now() < deadline) {
      const wait = Math.min(INSTALL_POLL_MS, deadline - Date.now());
      // Throws on a cancel rather than returning the verdict so far: a gate that
      // outlived its caller would otherwise go on to run the command it was holding.
      await withAbort(
        signal,
        new Promise((resolve) => setTimeout(resolve, wait))
      );
      current = await read();
    }
    return execGate(current, command);
  };

  /**
   * Whether a write can succeed at all, asked once and not polled.
   *
   * Separate from {@link awaitAdvisories} because the question is different:
   * there is no command to classify and nothing worth waiting for. An install in
   * flight does not stop a file being written, and the one thing that does —
   * a workspace that no longer accepts writes — never resolves on its own.
   *
   * Fails **open** for the same reason the exec gate does: a read of another
   * Durable Object's state must not take out a working tool.
   */
  const refuseWrite = async (): Promise<string | undefined> => {
    if (!advisories) return undefined;
    try {
      return writeGate(await advisories());
    } catch {
      return undefined;
    }
  };

  /**
   * Host-supplied environment, with the undefined entries dropped.
   *
   * `RuntimeExecOptions.env` is `Record<string, string>`, and a config thunk
   * that reads straight off `env` will hand back `undefined` for anything
   * unset — which would otherwise arrive in the container as the string
   * "undefined".
   */
  const definedEnv = (): Record<string, string> | undefined => {
    if (!env) return undefined;
    const entries = Object.entries(env()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  /**
   * Open the workspace, run one file operation in it, and own the failure.
   *
   * Five lines every file tool would otherwise repeat with only the verb changed
   * — five chances for the seventh to be written without them. The catch is the
   * point: a failed file operation is the model's to recover from, and it can
   * only recover from what it is told, so this returns the sentence rather than
   * throwing it.
   *
   * `sb_exec` deliberately does not use it. That one recognises `EEXEC_LOST`,
   * logs, and carries an install warning through the failure path — a bespoke
   * catch saying something this cannot.
   */
  const inWorkspace = async (
    signal: AbortSignal | undefined,
    gerund: string,
    subject: string,
    body: (fs: WorkspaceClient["fs"]) => Promise<string>
  ): Promise<string> => {
    try {
      // Stops the wait, not the operation. A file RPC takes no signal and has no
      // process to kill, so a write abandoned here may still land; what this
      // bounds is a workspace that has stopped answering, which would otherwise
      // hold the round for as long as it stayed silent.
      return await withAbort(
        signal,
        (async () => {
          using ws = await workspace();
          return await body(ws.fs);
        })()
      );
    } catch (err) {
      return `error ${gerund} ${subject}: ${String(err)}`;
    }
  };

  return {
    sb_exec: tool({
      /**
       * States what the tool guarantees, rather than what it might withhold.
       *
       * A description that leads with "output is truncated if it is large" and
       * gives no exit code hands the model two independent reasons to re-run a
       * command and capture the output "properly" — at 60 seconds a go on a real
       * gate, whose few hundred characters were never near the ceiling anyway.
       *
       * Two of these sentences are only true when a shell is configured, so the
       * description says whichever is. `withShellTranscript` is a no-op without
       * {@link ComputerConfig.shell}: no `2>&1`, so the streams arrive separate
       * and {@link renderResult} labels them; no `-o pipefail`, so `/bin/sh`
       * reports a pipeline's *last* stage. Promising a transcript and
       * first-failure semantics there would be the lie `wrapped` explains the
       * cost of.
       */
      description:
        "Run a shell command in the container and return its output. Use this for builds, tests, package installs, git, and anything else a terminal can do. " +
        (config.shell
          ? "The result is the command's full transcript — stdout and stderr interleaved in the order they were written — followed by a line reporting the exit code, e.g. `--- exit 0 ---`. A command killed at the time limit says so on that line. " +
            "You do not need to append `echo $?`, add `2>&1`, or redirect to a file to see any of this. " +
            "Do not pipe into `head` or `tail` to shorten output: long output is already truncated from the middle, keeping the beginning and the end, and piping costs you the parts you wanted. Pipelines report the first failing stage, so a piped command reports its real failure rather than the pipe's — but `cmd | head` may report 141 when `head` closes the pipe early, which is not a failure of `cmd`. "
          : "The result is the command's stdout, then any stderr under a `--- stderr ---` heading, then a line reporting the exit code, e.g. `--- exit 0 ---`. A command killed at the time limit says so on that line. " +
            "You do not need to append `echo $?` to see the exit code. Add `2>&1` yourself if you need the two streams in the order they were written. " +
            "Do not pipe into `head` or `tail` to shorten output: long output is already truncated from the middle, keeping the beginning and the end, and piping costs you the parts you wanted. A pipeline reports its **last** stage, so check the exit code of the command you care about rather than the pipe's. ") +
        "Prefer targeted commands over ones that print everything.",
      inputSchema: z.object({
        command: z.string().describe("The shell command, e.g. 'npm test'"),
        cwd: z
          .string()
          .optional()
          .describe(`Working directory (default: ${cwd})`)
      }),
      execute: async ({ command, cwd: overrideCwd }, { abortSignal }) => {
        /**
         * One line per command, and it is the only view of where a task's wall
         * clock actually goes.
         *
         * Everything on the Worker side of a container command is an `await`, so
         * Workers Observability records the invocation at ~0% CPU and a long wall
         * time and cannot say what ran. Diagnosing a 59-minute task on 2026-08-11
         * meant inferring the shape of each command from the *gaps between AI
         * Gateway calls*, because nothing logged the command itself. The three
         * numbers below — how long the install gate held, how long the command
         * took, what it exited with — would have answered it directly.
         *
         * Timed around the gate as well as the command, since a subagent blocked
         * waiting for `npm ci` and one running a slow test suite are
         * indistinguishable from the outside and want opposite fixes.
         */
        const startedAtMs = Date.now();

        // Only `sb_exec` waits on an install. The file tools read and write
        // source, which is in the workspace and unaffected by an install in
        // flight — blocking them would stop the subagent doing the reading it
        // could usefully do while it waits. They do consult `writeGate`, which
        // is a different question: not "is the tree ready" but "does a write
        // survive at all".
        const gate = await awaitAdvisories(command, abortSignal);
        const gateMsWaited = Date.now() - startedAtMs;
        if (gate.block) {
          console.info("[computer] sb_exec blocked by a workspace advisory", {
            command,
            gateMs: gateMsWaited
          });
          return gate.block;
        }
        // Prepended to whatever happens next, success or failure. The warning
        // is context for the output, not a substitute for it — which is why it
        // is carried through the catch as well.
        const note = (body: string) =>
          gate.warn ? `${gate.warn}\n\n${body}` : body;

        try {
          using ws = await workspace();
          // Read once per command. This is the *host's* thunk, so calling it
          // twice in the construction of one command's options is two chances to
          // disagree — the check and the value would come from different reads.
          const commandEnv = definedEnv();
          const options = {
            cwd: overrideCwd ?? cwd,
            encoding: "utf8" as const,
            timeoutMs,
            ...(commandEnv ? { env: commandEnv } : {})
          };
          // Transcript, not two streams: this result goes to a model, which
          // reads it as a terminal session rather than parsing it.
          // Not started at all on a signal that has already fired: a process that
          // is killed on the next line still ran long enough to change something.
          abortSignal?.throwIfAborted();
          using handle = await ws.runtime.exec(
            withShellTranscript(command, config.shell),
            options
          );
          // The runtime takes no signal, so stopping the wait and stopping the
          // process are two acts. Disposing the handle is neither — it releases
          // this side's attachment and leaves the command running.
          const result = await withAbort(abortSignal, handle.result(), () =>
            handle.kill("SIGTERM")
          );
          console.info("[computer] sb_exec", {
            command,
            exitCode: result.exitCode,
            // Split so a slow command and a slow *wait* never look alike.
            gateMs: gateMsWaited,
            durationMs: Date.now() - startedAtMs - gateMsWaited,
            // The ceiling this was measured against — a duration sitting on it is
            // a timeout wearing a normal-looking number.
            timeoutMs
          });
          return note(renderResult(result, maxChars));
        } catch (err) {
          if (abortSignal?.aborted) {
            const timedOut =
              (abortSignal.reason as { name?: string } | undefined)?.name ===
              "TimeoutError";
            console.info("[computer] sb_exec stopped", {
              command,
              gateMs: gateMsWaited,
              durationMs: Date.now() - startedAtMs - gateMsWaited,
              reason: timedOut ? "time limit" : "cancelled"
            });
            // Said plainly, because the likeliest next move after a bare error is
            // the same command again — and one that outran the limit once will.
            return note(
              timedOut
                ? "the command was stopped: this call ran past its time limit. Anything it changed before then is still changed. Try something narrower."
                : "the command was stopped because this call was cancelled. Anything it changed before then is still changed."
            );
          }
          const lost = execLostNote(err);
          console.warn("[computer] sb_exec failed", {
            command,
            gateMs: gateMsWaited,
            durationMs: Date.now() - startedAtMs - gateMsWaited,
            timeoutMs,
            // Distinguished in the log for the same reason it is distinguished
            // for the model: a container replacement and a broken command want
            // different people looking at them.
            ...(lost ? { lost: true } : {}),
            err: String(err)
          });
          // Returned, not thrown: a failed command is usually the model's to
          // recover from, and it can only recover from what it is told.
          return note(lost ?? `error running command: ${String(err)}`);
        }
      }
    }),

    sb_read: tool({
      description:
        "Read a file from the workspace. Returns the file's text, or a note if it does not exist. " +
        "A large file comes back with its middle removed and a marker giving the `offset` that reaches the missing part. " +
        "Pass `offset` (and optionally `length`) to read a specific byte window instead — the result states the window it returned and how many bytes follow, so you can page through a file. Byte offsets, not lines: to see the lines around a match, use sb_grep with `context`. " +
        "Files under node_modules are not in the workspace — read those with sb_exec.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, e.g. '/workspace/repo/src/a.ts'"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Byte offset to start reading from"),
        length: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum bytes to return from `offset`")
      }),
      execute: async ({ path, offset, length }, { abortSignal }) => {
        const refusal = guardPath(path, "sb_read");
        if (refusal) return refusal;
        return inWorkspace(abortSignal, "reading", path, async (fs) => {
          // Either knob means the model chose a region; only an unqualified read
          // gets the middle-out guess.
          return offset === undefined && length === undefined
            ? await readBounded(fs, path, maxChars)
            : await readWindow(
                fs,
                path,
                offset ?? 0,
                length ?? maxChars,
                maxChars
              );
        });
      }
    }),

    sb_write: tool({
      description:
        "Create or overwrite a file in the workspace. Parent directories are created for you. For a small change to a large file prefer sb_edit, which does not require sending the whole file back.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        content: z
          .string()
          .describe("Full file content (overwrites any existing file)")
      }),
      execute: async ({ path, content }, { abortSignal }) => {
        const refusal = guardPath(path, "sb_write");
        if (refusal) return refusal;
        // Before the write, not after: the point is to not report a success that
        // did not happen.
        const lost = await refuseWrite();
        if (lost) return lost;
        return inWorkspace(abortSignal, "writing", path, async (fs) => {
          const dir = path.slice(0, path.lastIndexOf("/"));
          if (dir) await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path, content);
          // Characters, not bytes. `String.length` counts UTF-16 code units — the
          // distinction `readBounded` documents at length — so calling them bytes
          // was simply wrong for anything outside ASCII. The exact byte count
          // would cost a `TextEncoder` pass over the whole content for a number
          // nobody does arithmetic with, and "characters" is already this module's
          // word for the same count in `truncateOutput`'s omission marker.
          const written = content.length;
          return `wrote ${path} (${written} character${written === 1 ? "" : "s"})`;
        });
      }
    }),

    sb_edit: tool({
      description:
        "Replace an exact string in a file. The string must be non-empty and must appear exactly once — if it appears zero times or more than once the edit is refused, so include enough surrounding context to make it unique.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        find: z
          .string()
          // Empty is refused at the schema rather than in the body, because
          // `split("")` does not count empty-string occurrences: on a file of
          // one character it reports none, on a longer one it reports one per
          // character, and on an *empty* file it reports -1 — which slips past
          // both guards below and writes `replace` into the file as if an edit
          // had been found. A write tool must not write what nobody asked for.
          .min(1)
          .describe("Exact text to replace, unique within the file"),
        replace: z.string().describe("Replacement text")
      }),
      execute: async ({ path, find, replace }, { abortSignal }) => {
        const refusal = guardPath(path, "sb_edit");
        if (refusal) return refusal;
        const lost = await refuseWrite();
        if (lost) return lost;
        return inWorkspace(abortSignal, "editing", path, async (fs) => {
          const content = await fs.readFile(path, "utf8");
          const occurrences = content.split(find).length - 1;
          // Refusing an ambiguous edit is the whole value of this tool over
          // sb_write: a silent first-match replace corrupts the file in a way
          // that surfaces much later, usually as a confusing test failure.
          if (occurrences === 0) return `no match for that text in ${path}`;
          if (occurrences > 1)
            return `that text appears ${occurrences} times in ${path} — add surrounding context to make it unique`;
          // A replacer function, not the string itself. `String.replace`
          // interprets `$$`, `$&`, `` $` `` and `$'` in a *string* replacement
          // even when the pattern is a plain string, so the text written is not
          // the text the model sent: `echo $$` becomes `echo $`, and `$'` splices
          // in everything before the match. Those two are not exotic — `$$`
          // escapes a dollar in a Makefile and reads a PID in shell, and `$'…'`
          // is bash ANSI-C quoting. A function's return value is used verbatim.
          await fs.writeFile(
            path,
            content.replace(find, () => replace)
          );
          return `edited ${path}`;
        });
      }
    }),

    sb_ls: tool({
      description:
        "List files in a workspace directory, or find files by name. Without `pattern` it lists one level: directories with a trailing slash, files with their size — check that before reading a large one, since sb_read truncates. " +
        "`pattern` is a glob matched against paths relative to `path`, and searches the whole subtree: `*` stays within one path segment, `**/` crosses directories, `?` matches one character. So `*.ts` finds top-level TypeScript files and `**/*.ts` finds them at any depth. " +
        "A cut listing reports the `offset` that continues it. node_modules is not in the workspace — list it with sb_exec.",
      inputSchema: z.object({
        path: z.string().describe("Absolute directory path"),
        recursive: z
          .boolean()
          .optional()
          .describe("List the whole subtree rather than one level"),
        pattern: z
          .string()
          .optional()
          .describe(
            "Glob relative to path, e.g. '**/*.spec.ts'. Searches the subtree, so `recursive` is not needed with it."
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Entries to skip — use the offset a cut listing reports")
      }),
      execute: async (
        { path, recursive, pattern, offset },
        { abortSignal }
      ) => {
        const refusal = guardPath(path, "sb_ls");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace(abortSignal, "listing", path, async (fs) => {
          if (recursive || pattern) {
            // `find` rather than `ls`, which took no bound: a prefix scan
            // returned every path in the subtree and the ceiling then threw most
            // of them away — the same read-everything-then-discard shape the
            // `readdir` limit below exists to avoid. Two differences follow from
            // the swap, both improvements: directories appear (rendered like the
            // arm below renders them), and order is the walk's — pre-order, by
            // name — rather than one flat sort.
            //
            // Filtered rather than trusted, and this is the arm where it matters
            // most: at a repo root `.git` is walked *first* and holds thousands
            // of objects, so an unfiltered page is a page of `.git` and nothing
            // else. Four rounds because a `find` retry re-walks dirents, which is
            // cheap SQLite reads rather than file bytes.
            const page = await collectVisible(
              (at, limit) => fs.find(path, pattern, { limit, offset: at }),
              (e) => e.path,
              DEFAULT_MAX_ENTRIES,
              from,
              4
            );
            if (page.items.length === 0)
              return page.crowded
                ? `(everything under ${path} from offset ${from} is inside .git — try a \`pattern\`, or a \`path\` inside the working tree)`
                : pattern
                  ? `(nothing under ${path} matches ${pattern})`
                  : `(${path} is empty)`;

            const blocks = page.items
              .slice(0, DEFAULT_MAX_ENTRIES)
              .map((e) => [e.type === "dir" ? `${e.path}/` : e.path]);
            const { body, shown } = packBlocks(blocks, maxChars);
            return body + listingNote(page, shown, "entries", "`pattern`");
          }
          // One over the ceiling: enough to know the listing was cut without a
          // second round trip to find out, and the extra entry is not shown.
          // Unfiltered on purpose — `.git/` shows here exactly as `node_modules`
          // does, because one line naming a directory that is really there is
          // honest, and it is access rather than existence that is refused.
          const entries = await fs.readdir(path, {
            limit: DEFAULT_MAX_ENTRIES + 1,
            offset: from
          });
          if (entries.length === 0)
            return from > 0
              ? `(no entries in ${path} past offset ${from})`
              : `(${path} is empty)`;
          const blocks = entries
            .slice(0, DEFAULT_MAX_ENTRIES)
            .map((e) => [
              e.isDirectory ? `${e.name}/` : `${e.name}\t${humanBytes(e.size)}`
            ]);
          const { body, shown } = packBlocks(blocks, maxChars);
          const more = entries.length > shown;
          return (
            body +
            (more
              ? `\n… showed ${shown} entries; there are more. Continue with \`offset: ${from + shown}\`, or narrow with \`pattern\`.`
              : "")
          );
        });
      }
    }),

    /**
     * Search, without the container.
     *
     * The tool this replaces is `sb_exec("grep -rn …")`, and the case for a native
     * one is not that shelling out fails — it is where the search runs. `fs.grep`
     * reads the Durable Object's SQLite, so it answers while the container is
     * being replaced or an install is still running, which is exactly the window
     * the install gate leaves a subagent with nothing to do. It is also why this
     * tool is not gated: see {@link awaitInstall}.
     *
     * Two lesser reasons that still matter. The query arrives as a value rather
     * than through `shellQuote` and a shell that would re-parse it. And the result
     * is bounded by a `limit` at the source instead of being middle-truncated
     * afterwards, which for a match list means losing whole files silently.
     */
    sb_grep: tool({
      description:
        "Search file contents across the workspace. Returns matching lines grouped by file, each with its line number. " +
        "The query is matched literally — set `regex` to interpret it as a regular expression. " +
        "Pass `include` to limit which files are searched, e.g. '**/*.ts' — without it every file under `path` is read, which is slower and rarely what you meant. " +
        "A cut result reports the `offset` that continues it. Use `context` to see the lines around a match. " +
        "node_modules is not in the workspace — search it with sb_exec.",
      inputSchema: z.object({
        query: z.string().describe("Text to find, e.g. 'buildComputerTools'"),
        path: z
          .string()
          .optional()
          .describe(`Absolute file or directory to search (default: ${cwd})`),
        include: z
          .string()
          .optional()
          .describe(
            "Glob relative to path limiting which files are searched, e.g. '**/*.ts'"
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Interpret query as a regular expression"),
        ignoreCase: z.boolean().optional().describe("Ignore letter case"),
        context: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe("Lines of surrounding context to include with each match"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Matches to skip — use the offset a cut result reports")
      }),
      execute: async (
        { query, path, include, regex, ignoreCase, context, offset },
        { abortSignal }
      ) => {
        const target = path ?? cwd;
        const refusal = guardPath(target, "sb_grep");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace(abortSignal, "searching", target, async (fs) => {
          // Two rounds, not four: a `grep` retry re-reads and re-scans every file
          // it already looked at, where the `find` retry in `sb_ls` only re-walks
          // dirents. `.git` is also far less likely to flood a page here — its
          // bulk is compressed objects, which a text query does not match.
          const page = await collectVisible(
            (at, limit) =>
              fs.grep(query, target, {
                include,
                regex,
                ignoreCase,
                context,
                limit,
                offset: at
              }),
            (m) => m.path,
            DEFAULT_MAX_MATCHES,
            from,
            2
          );
          if (page.items.length === 0)
            return page.crowded
              ? `every match for ${JSON.stringify(query)} from offset ${from} is inside .git, which is not searched. Add \`include\` (e.g. '**/*.ts') to search the working tree instead.`
              : `no matches for ${JSON.stringify(query)} in ${target}${
                  include ? ` (${include})` : ""
                }${from > 0 ? ` past offset ${from}` : ""}`;

          const { body, shown, capped } = renderGrepMatches(
            page.items.slice(0, DEFAULT_MAX_MATCHES),
            maxChars
          );
          return (
            body +
            listingNote(page, shown, "matches", "`include`") +
            (capped
              ? `\n(Some lines were shortened. Read one in full with \`sb_read\` and an \`offset\`.)`
              : "")
          );
        });
      }
    }),

    sb_exists: tool({
      description: "Check whether a path exists in the workspace.",
      inputSchema: z.object({ path: z.string().describe("Absolute path") }),
      execute: async ({ path }, { abortSignal }) => {
        const refusal = guardPath(path, "sb_exists");
        if (refusal) return refusal;
        return inWorkspace(abortSignal, "checking", path, async (fs) => {
          return (await pathExists(fs, path))
            ? `${path} exists`
            : `${path} does not exist`;
        });
      }
    })
  };
}

/**
 * An `exec` bound to this workspace, for plugins that need a shell but should
 * not own a container.
 *
 * `@dynamicagents/plugins/repo` is the reason this exists: it needs `git` on a real
 * shell, but depending on this module would weld the two together and stop a
 * host from pointing it at its own container. Structurally typed for the same
 * reason — the two plugins compose without either importing the other.
 *
 * ## {@link ComputerConfig.env} is deliberately **not** merged here
 *
 * {@link buildComputerTools} merges it into every command; this does not.
 *
 * What this hands out is a raw shell to *another plugin*, whose commands this
 * module neither writes nor sees. `/repo` runs its unauthenticated git through
 * it and pins the environment those need — `GIT_TERMINAL_PROMPT=0` plus the
 * model-authored values it passes as variables. A host environment merged
 * underneath lets through every key it does *not* pin: `http_proxy`,
 * `GIT_PROXY_COMMAND`, `GIT_SSL_CAINFO`, `GIT_CONFIG_GLOBAL`, `GIT_EXEC_PATH` —
 * the last two redirect the config git reads and relocate its helper binaries.
 *
 * No token is at stake, since the credentialed operations do not run here at
 * all. The point is that changing what git does inside another plugin's commands
 * should not be something a container plugin's config field does by accident,
 * from a host that only meant to set a registry. A host that wants it composes
 * it where the merge is visible:
 *
 * ```ts
 * exec: (command, options) =>
 *   computerExec(config)(command, {
 *     ...options,
 *     env: { ...mine, ...options?.env }
 *   });
 * ```
 */
export function computerExec(config: ComputerConfig): (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    runtime?: unknown;
    /**
     * The caller's cancellation. The container runtime takes no signal, so on an
     * abort this stops waiting and sends SIGTERM — the command is killed, not
     * merely abandoned.
     */
    signal?: AbortSignal;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return async (command, options) => {
    // The caller forwards its execution's runtime state opaquely; only this side
    // knows the key it might carry. That is what lets `/repo` reach a subagent's
    // shared workspace without importing anything from here.
    const name =
      workspaceNameFromRuntime(options?.runtime) ?? config.workspaceName();
    using ws = await openWorkspace(
      config.binding.get(config.binding.idFromName(name))
    );

    const env = options?.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        )
      : undefined;

    // Named rather than inlined, because the note below has to state it: a
    // ceiling the model cannot see is one it cannot work within.
    const timeoutMs =
      options?.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `withShell`, never `withShellTranscript`: the caller reads this result in
    // code. `/repo` compares `stdout` against a URL, tests it for emptiness to
    // decide a tree is clean, and reads a sha out of it to push — all of which
    // need `stdout` to carry the answer alone, with git's diagnostics on the
    // channel git put them on.
    options?.signal?.throwIfAborted();
    using handle = await ws.runtime.exec(withShell(command, config.shell), {
      cwd: options?.cwd ?? config.cwd ?? DEFAULT_CWD,
      encoding: "utf8",
      timeoutMs,
      ...(env ? { env } : {})
    });
    const result = await withAbort(options?.signal, handle.result(), () =>
      handle.kill("SIGTERM")
    );
    const killed = cancelledNote(result.status, result.exitCode, timeoutMs);

    return {
      // `/repo` branches on `success`, which this runtime does not report — it
      // has `status` and `exitCode`. Derived from the exit code rather than the
      // status, because a command that runs and fails is `completed` here.
      success: result.exitCode === 0,
      stdout: result.stdout,
      // Appended rather than substituted: a command killed at the ceiling may
      // well have written plenty first, and that output is the more useful half.
      // This is the only field the note can travel on — `stdout` is a data
      // channel the caller parses, and the four fields are the whole contract.
      stderr: killed
        ? [result.stderr, killed].filter(Boolean).join("\n")
        : result.stderr,
      exitCode: result.exitCode
    };
  };
}

export function computer(config: ComputerConfig): AgentPlugin {
  // Resolved per call, not memoized: `workspaceName` is a thunk precisely
  // because the name is not knowable at construction, and a stale stub would
  // silently route a second caller's commands into the first caller's files.
  const host = (runtime?: unknown) => {
    const name = workspaceNameFromRuntime(runtime) ?? config.workspaceName();
    return config.binding.get(config.binding.idFromName(name));
  };

  const tools = (runtime?: unknown) =>
    buildComputerTools(
      () => openWorkspace(host(runtime)),
      config,
      // No try/catch here: `buildComputerTools` fails the gate open itself, so
      // wrapping again would only make it look like the guarantee lives in two
      // places.
      () => host(runtime).advisories()
    );

  return definePlugin({
    key: "computer",

    mainAgentTools: () => tools(),

    // `ctx.runtime` is what makes a delegated subtask land in the workspace its
    // parent prepared — see {@link WORKSPACE_RUNTIME_KEY}. Without it the
    // fallback thunk runs, and on a subagent that throws.
    toolFamilies: {
      [SANDBOX_FAMILY]: (ctx) => ({ tools: tools(ctx.runtime) })
    },

    capability: [
      "You have a Linux container with a shell, a package manager and network access:",
      "- `sb_exec` runs any shell command — builds, tests, installs, git.",
      "- `sb_read` / `sb_write` / `sb_edit` work on files; `sb_edit` replaces an exact unique string and is the right tool for a small change.",
      "- `sb_grep` searches file contents; `sb_ls` lists a directory, or finds files by glob with `pattern`; `sb_exists` checks a path.",
      // The reason to prefer them is the one thing the model cannot infer from a
      // tool description: these read the durable workspace directly, so they are
      // the only tools that still answer while the container is unavailable.
      "Search with `sb_grep` and `sb_ls` rather than running `grep` or `find` through `sb_exec`. They read the workspace directly, so they keep working while the container is restarting or dependencies are still installing, and they come back with line numbers and a bounded result instead of a wall of text.",
      "Command output is truncated from the middle when large, so run targeted commands and read specific files rather than printing everything.",
      // Both halves of this matter and they pull in opposite directions, which
      // is why they are stated together rather than left for the model to work
      // out from a confusing result.
      "The checkout is durable: it survives between tasks and is still there after the container restarts, so it may already contain work from an earlier task — check before assuming it is empty.",
      "`node_modules` is the exception. It lives only in the container, so it is rebuilt whenever the container restarts, and the file tools cannot see inside it — use `sb_exec` to read a dependency's source.",
      // Stated up front rather than left to a refusal, so the model does not spend
      // a turn discovering it. The destination matters as much as the rule: a
      // prohibition with nowhere to go gets worked around.
      "`.git` is off limits to these tools, and searches and recursive listings skip it. It is git's internal state — reading it tells you less than the repository tools do, and writing it corrupts the checkout. Repository work goes through the repo tools (`repo_status`, `repo_diff`, `repo_commit`, `repo_push`), which the main agent holds; if a task needs git state beyond what you can see in the working tree, say so in your result rather than reaching into `.git` yourself."
    ].join("\n")
  });
}
