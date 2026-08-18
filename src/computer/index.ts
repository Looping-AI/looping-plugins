import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import { getWorkspace, shellQuote } from "@cloudflare/computer";
import type { WorkspaceClient, WorkspaceStub } from "@cloudflare/computer";
import type { InstallState } from "./install.js";
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
import {
  execLostNote,
  installGate,
  needsDependencies,
  type InstallGate
} from "./gate.js";

/**
 * `@loopingai/plugins/computer` — a Linux container whose filesystem outlives it.
 *
 * The successor to `@loopingai/plugins/sandbox`, and the difference is where the
 * files live. A `@cloudflare/sandbox` container held its work on a disk that died
 * with the container; keeping anything meant snapshotting to R2, which needed S3
 * credentials a Workers binding cannot supply and failed on every task in
 * production. Here the filesystem **is** a Durable Object's SQLite, mounted into
 * the container over FUSE by `computerd`. Commands see a normal `/workspace`; the
 * Worker reads the same tree over RPC; and when the container is replaced the
 * tree is pushed back into the new one. That last part is measured, not hoped
 * for: a deploy destroyed a live container and the checkout was restored from the
 * object.
 *
 * The distinction against `@loopingai/plugins/workspace` still holds — that one
 * is a virtual filesystem with no processes and nothing to run. Install exactly
 * one filesystem plugin. An agent holding two has no way for the model to know
 * which one a path refers to.
 *
 * ## `node_modules` is **not** in the workspace
 *
 * The one thing to internalise before reading further. `computerd` excludes
 * `node_modules` from the sync by design, and the exclusion is right: pushing a
 * real one (429 MB, 22,470 files) into the object reproducibly exceeded the
 * Durable Object's 128 MB isolate memory limit at ~99.7%, leaving the tree
 * silently short — and the reconciliation that followed propagated the shortfall
 * back into the container.
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
export { needsDependencies } from "./gate.js";

/**
 * This plugin's tool-family name, as a recipe's `toolFamilies` lists it.
 *
 * Deliberately still `"sandbox"`. It is a *substrate* that changed, not a
 * capability, and the string appears in recipes, souls and allowlists that have
 * nothing to do with which container SDK is underneath. Renaming it would have
 * `validateRecipe` silently drop the family from every recipe that still says
 * `sandbox` — a subagent with no tools and no error explaining why.
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
 * How much command output the model is allowed to see.
 *
 * One `npm install` prints more than a small context window holds, and the
 * interesting part of a failing build is the first error and the last summary —
 * never the middle. So output is truncated from the middle rather than the end,
 * which is what a naive `slice` would do and would drop the exit summary that
 * says what actually failed.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;

/**
 * How many directory entries one `sb_ls` returns.
 *
 * A bound on the *listing*, not on the rendered text — `maxOutputBytes` still
 * applies on top. The two used to be the same budget applied in the wrong order:
 * `readdir` returned every entry, the isolate held all of them, and the byte
 * ceiling then discarded the tail. A real `node_modules` is 22,470 files, and a
 * misbehaving build is exactly when someone lists one.
 *
 * `@cloudflare/computer` 0.2 gave `readdir` a `limit`, so the bound is applied
 * where the entries are read instead of after they have all arrived.
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
   * Where the host's dependency install has got to.
   *
   * Required rather than optional, and not only because Workers RPC types an
   * optional method as a union nothing can call. A host that installs nothing
   * returns `{ state: "idle" }` in one line; a host that installs but forgot to
   * expose it gets a compile error instead of an `sb_exec` that silently runs
   * against a half-built `node_modules`.
   */
  installStatus(): Promise<InstallState>;
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
 * less than `shellQuote` would re-parse the model's quoting and mangle it.
 *
 * ## Why `-o pipefail`
 *
 * Without it, a pipeline's exit status is its **last** stage's. So
 * `npm run check | tail -100` reported `exit 0` for a gate that had failed
 * outright — observed in production, on a run where `npm run check` "passed" in
 * 1.3 seconds because `node_modules` was missing and the failure was swallowed by
 * `tail`. A tool that reports success for a failed build is worse than one that
 * reports nothing, and models pipe into `tail` constantly.
 *
 * It is also what drove the duplicate 60-second gate runs: the model could not
 * trust a piped exit code, so it re-ran the whole thing unpiped to get one.
 *
 * The trade is real and worth stating. `pipefail` also surfaces SIGPIPE, so
 * `ls big-dir | head -1` now reports 141 where it used to report 0 — noisy, but
 * *visible*, and the alternative is a failing gate that looks clean. The tool
 * description tells the model not to pipe into `head`/`tail` at all, since output
 * is already truncated with both ends kept.
 *
 * Requires a shell that implements it — `bash`, `zsh`, `ksh`. Not `sh`/dash. A
 * host setting {@link ComputerConfig.shell} is choosing that shell explicitly, and
 * the choice is what this depends on.
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
 * {@link computerExec} is that caller, on behalf of `@loopingai/plugins/repo`,
 * which asks git questions like `symbolic-ref --short refs/remotes/origin/HEAD`
 * and `rev-list --count` and needs the answer alone.
 *
 * Two functions rather than one with a flag, because the difference is a change
 * to the *output contract* and a boolean hides it at the call site — which is
 * exactly how it went wrong. `computerExec` inherited a `2>&1` written for
 * `sb_exec`, so every `/repo` git command came back with an empty `stderr` and a
 * `stdout` that was a transcript rather than an answer. Nothing failed, because
 * the commands `/repo` parses happen to be quiet ones; a single `warning:` from a
 * future git would have skipped the empty-branch guard in silence.
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
 * one failed. Handing back a stdout block and a separate stderr block destroys
 * that ordering, and the model noticed before we did: it re-ran a 60-second gate
 * as `npm run check > /tmp/out 2>&1; cat /tmp/out` purely to read the transcript
 * in the order it happened. This is that workaround, done once, for free.
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
   * Ubuntu, and a model writing shell writes *bash*. A production run cost two
   * minutes to exactly this: the subagent ran `npm run check` (60s), wanted to see
   * just the tail, re-ran it as `npm run check 2>&1 | tail -40; echo
   * "EXIT_CODE=${PIPESTATUS[0]}"` — and `PIPESTATUS` is a bash builtin, so dash
   * failed the whole line with exit 2 after another 58 seconds. The model then
   * diagnosed it correctly and re-ran a third time under `bash -c`, which is how
   * we know bash was in the image the entire time.
   *
   * `PIPESTATUS` is one member of a family — `[[ ]]`, arrays, `set -o pipefail`,
   * process substitution — so the fix is the shell, not a note in a prompt telling
   * the model to write POSIX. Set it only if the image actually has that shell: a
   * missing one fails *every* command rather than the bash-flavoured ones.
   */
  shell?: string;
  /** Per-command timeout. Defaults to ten minutes. */
  timeoutMs?: number;
  /** Output ceiling per command. Defaults to 16,000 bytes. */
  maxOutputBytes?: number;
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
   * so a proxy set here does not reach the git that `@loopingai/plugins/repo`
   * runs through that export. The reasoning, and how a host opts in explicitly,
   * is written up there.
   *
   * ## Put no secret here
   *
   * Stated first because the previous version of this comment implied the
   * opposite, and it was wrong in a way that would have leaked a key. It offered
   * "API keys a build needs" and justified per-command passing as protection from
   * "a `printenv` it wrote itself" — but *every* command gets this environment,
   * and `sb_exec`'s command is written by the model. `sb_exec("printenv")` prints
   * all of it. So does a `postinstall` script in a repository the agent was asked
   * to clone, which nobody vetted.
   *
   * What per-command passing actually buys is narrower and worth keeping: the
   * value is not set on the container, so a process started outside these tools —
   * a dev server left running from an earlier task — does not inherit it, and it
   * is not sitting in `/proc/1/environ`. That is a real property. It is not
   * confidentiality from the model.
   *
   * ## What to do with a secret instead
   *
   * Do not hand the agent the credential; hand it the *action*. Keep the secret
   * on the Worker side and expose one tool that makes the one call it is for.
   * `@loopingai/plugins/repo` is the worked example: `repo_open_pr` holds a forge
   * token that can write to the repository and calls the API from the Worker, so
   * that token never crosses into the container at all — and the one command that
   * genuinely needs a credential in the container gets it for the duration of
   * that command, scoped to a single origin.
   */
  env?: () => Record<string, string | undefined>;
}

export function buildComputerTools(
  workspace: () => Promise<WorkspaceClient>,
  config: ComputerConfig,
  installStatus?: () => Promise<InstallState | undefined>
): ToolSet {
  const cwd = config.cwd ?? DEFAULT_CWD;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const gateMs = config.installGateMs ?? 90_000;
  const env = config.env;

  /**
   * Wait for a running install, up to the gate, and report a blockage if one
   * outlives it.
   *
   * Polled rather than subscribed: the status lives in another Durable Object,
   * there is no event to wait on, and the whole window is under two minutes.
   *
   * **Only commands that need `node_modules` wait.** The gate used to hold every
   * command, and the cost of that was not theoretical: a run spent 57 seconds
   * with `tail -c 200 README.md | xxd` queued behind an `npm ci` it had no use
   * for, followed by four more `od` / `ls` / `git status` calls that were equally
   * indifferent to it. Reading a file, inspecting the tree and reading git
   * history are exactly what a subagent can usefully do *while* an install runs,
   * which is the whole reason the install was moved out of the round loop.
   */
  const awaitInstall = async (command: string): Promise<InstallGate> => {
    if (!installStatus) return {};
    if (!needsDependencies(command)) return {};

    // Fails **open**, and that belongs here rather than at the call site: this
    // is a gate on somebody else's job, read over RPC to another Durable
    // Object. An error reading it must not take out a working shell — running
    // the command is exactly what would have happened before the gate existed,
    // and a spurious "install still running" would strand the subagent.
    const read = async (): Promise<InstallState | undefined> => {
      try {
        return await installStatus();
      } catch {
        return undefined;
      }
    };

    // Clamped to whatever is left of the gate, not the bare interval. A fixed
    // sleep makes `installGateMs` a floor rather than the ceiling it is
    // documented to be: at a 100 ms gate the loop still slept the full three
    // seconds before looking again, so a public timeout overshot by 30×.
    const deadline = Date.now() + gateMs;
    let status = await read();
    while (status?.state === "running" && Date.now() < deadline) {
      const wait = Math.min(INSTALL_POLL_MS, deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
      status = await read();
    }
    return installGate(status);
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
   * Every file tool used to repeat these five lines with only the verb changed,
   * which is five chances for the seventh tool to be written without them. The
   * catch is the whole point: a failed file operation is the model's to recover
   * from, and it can only recover from what it is told, so this returns the
   * sentence rather than throwing it.
   *
   * `sb_exec` deliberately does not use it. That one recognises `EEXEC_LOST`,
   * logs, and carries an install warning through the failure path — a bespoke
   * catch saying something this cannot.
   */
  const inWorkspace = async (
    gerund: string,
    subject: string,
    body: (fs: WorkspaceClient["fs"]) => Promise<string>
  ): Promise<string> => {
    try {
      using ws = await workspace();
      return await body(ws.fs);
    } catch (err) {
      return `error ${gerund} ${subject}: ${String(err)}`;
    }
  };

  return {
    sb_exec: tool({
      /**
       * States what the tool guarantees, which the previous wording did not.
       *
       * It led with "output is truncated from the middle if it is large" and said
       * nothing about what survives — so a model was told its transcript might be
       * lossy and given no exit code to check, which are two independent reasons
       * to re-run a command and capture the output "properly". That is exactly
       * what happened, twice, at 60 seconds a go. Truncation was never actually
       * firing: the gate emits a few hundred bytes against a 16,000-byte ceiling.
       */
      description:
        "Run a shell command in the container and return its output. Use this for builds, tests, package installs, git, and anything else a terminal can do. " +
        "The result is the command's full transcript — stdout and stderr interleaved in the order they were written — followed by a line reporting the exit code, e.g. `--- exit 0 ---`. A command killed at the time limit says so on that line. " +
        "You do not need to append `echo $?`, add `2>&1`, or redirect to a file to see any of this. " +
        "Do not pipe into `head` or `tail` to shorten output: long output is already truncated from the middle, keeping the beginning and the end, and piping costs you the parts you wanted. Pipelines report the first failing stage, so a piped command reports its real failure rather than the pipe's — but `cmd | head` may report 141 when `head` closes the pipe early, which is not a failure of `cmd`. " +
        "Prefer targeted commands over ones that print everything.",
      inputSchema: z.object({
        command: z.string().describe("The shell command, e.g. 'npm test'"),
        cwd: z
          .string()
          .optional()
          .describe(`Working directory (default: ${cwd})`)
      }),
      execute: async ({ command, cwd: overrideCwd }) => {
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

        // Only `sb_exec` consults the install. The file tools read and write
        // source, which is in the workspace and unaffected by an install in
        // flight — blocking them would stop the subagent doing the reading it
        // could usefully do while it waits.
        const gate = await awaitInstall(command);
        const gateMsWaited = Date.now() - startedAtMs;
        if (gate.block) {
          console.info("[computer] sb_exec blocked by install", {
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
          using handle = await ws.runtime.exec(
            withShellTranscript(command, config.shell),
            options
          );
          const result = await handle.result();
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
          return note(renderResult(result, maxBytes));
        } catch (err) {
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
      execute: async ({ path, offset, length }) => {
        const refusal = guardPath(path, "sb_read");
        if (refusal) return refusal;
        return inWorkspace("reading", path, async (fs) => {
          // Either knob means the model chose a region; only an unqualified read
          // gets the middle-out guess.
          return offset === undefined && length === undefined
            ? await readBounded(fs, path, maxBytes)
            : await readWindow(
                fs,
                path,
                offset ?? 0,
                length ?? maxBytes,
                maxBytes
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
      execute: async ({ path, content }) => {
        const refusal = guardPath(path, "sb_write");
        if (refusal) return refusal;
        return inWorkspace("writing", path, async (fs) => {
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
        "Replace an exact string in a file. The string must appear exactly once — if it appears zero times or more than once the edit is refused, so include enough surrounding context to make it unique.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path"),
        find: z
          .string()
          .describe("Exact text to replace, unique within the file"),
        replace: z.string().describe("Replacement text")
      }),
      execute: async ({ path, find, replace }) => {
        const refusal = guardPath(path, "sb_edit");
        if (refusal) return refusal;
        return inWorkspace("editing", path, async (fs) => {
          const content = await fs.readFile(path, "utf8");
          const occurrences = content.split(find).length - 1;
          // Refusing an ambiguous edit is the whole value of this tool over
          // sb_write: a silent first-match replace corrupts the file in a way
          // that surfaces much later, usually as a confusing test failure.
          if (occurrences === 0) return `no match for that text in ${path}`;
          if (occurrences > 1)
            return `that text appears ${occurrences} times in ${path} — add surrounding context to make it unique`;
          await fs.writeFile(path, content.replace(find, replace));
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
      execute: async ({ path, recursive, pattern, offset }) => {
        const refusal = guardPath(path, "sb_ls");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace("listing", path, async (fs) => {
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
            const { body, shown } = packBlocks(blocks, maxBytes);
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
          const { body, shown } = packBlocks(blocks, maxBytes);
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
      execute: async ({
        query,
        path,
        include,
        regex,
        ignoreCase,
        context,
        offset
      }) => {
        const target = path ?? cwd;
        const refusal = guardPath(target, "sb_grep");
        if (refusal) return refusal;
        const from = offset ?? 0;
        return inWorkspace("searching", target, async (fs) => {
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
            maxBytes
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
      execute: async ({ path }) => {
        const refusal = guardPath(path, "sb_exists");
        if (refusal) return refusal;
        return inWorkspace("checking", path, async (fs) => {
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
 * `@loopingai/plugins/repo` is the reason this exists: it needs `git` on a real
 * shell, but making it depend on this module would weld the two together and
 * stop a host from pointing it at its own container. Structurally typed for the
 * same reason — the two plugins compose without either importing the other, and
 * the signature is deliberately identical to the one `/sandbox` exported, so
 * `/repo` did not change at all when the substrate did.
 *
 * ## {@link ComputerConfig.env} is deliberately **not** merged here
 *
 * {@link buildComputerTools} merges it into every command; this does not, and the
 * asymmetry is a decision rather than an oversight.
 *
 * What this function hands out is a raw shell to *another plugin*, whose commands
 * this module neither writes nor sees. `/repo` uses it to run credential-bearing
 * git, and it controls that environment exactly — `GIT_CONFIG_GLOBAL`,
 * `GIT_ASKPASS` and `GIT_TERMINAL_PROMPT` are pinned per command precisely so
 * nothing else decides what git reads. Merging a host environment underneath that
 * would let every key it does *not* pin through: `http_proxy`,
 * `GIT_PROXY_COMMAND`, `GIT_SSL_CAINFO`, `GIT_EXEC_PATH`. The last one relocates
 * git's own helper binaries. Redirecting those inside a command holding a forge
 * token is not a thing a container plugin's config field should be able to do by
 * accident, from a host that only meant to set a registry.
 *
 * So it is not withheld to be safe from the host — it is withheld so that a host
 * doing it does it *visibly*, at the call site, where the merge is in front of
 * whoever writes it:
 *
 * ```ts
 * exec: (command, options) =>
 *   computerExec(config)(command, {
 *     ...options,
 *     env: { ...mine, ...options?.env }
 *   });
 * ```
 *
 * Nothing of value is lost by the default, either, because no secret belongs in
 * that field in the first place — see {@link ComputerConfig.env}.
 */
export function computerExec(config: ComputerConfig): (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    runtime?: unknown;
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
    using handle = await ws.runtime.exec(withShell(command, config.shell), {
      cwd: options?.cwd ?? config.cwd ?? DEFAULT_CWD,
      encoding: "utf8",
      timeoutMs,
      ...(env ? { env } : {})
    });
    const result = await handle.result();
    const killed = cancelledNote(result.status, result.exitCode, timeoutMs);

    return {
      // `/repo` branches on `success`, which `@cloudflare/sandbox` reported and
      // this runtime does not — it reports `status` and `exitCode`. Derived from
      // the exit code rather than from `status`, because a command that runs and
      // fails is `completed` here.
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
      () => host(runtime).installStatus()
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
