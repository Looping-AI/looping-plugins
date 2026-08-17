import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import { getWorkspace, shellQuote } from "@cloudflare/computer";
import type {
  WorkspaceClient,
  WorkspaceRuntimeStatus,
  WorkspaceStub
} from "@cloudflare/computer";
import type { InstallState } from "./install.js";

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

/** A command that has not finished in this long is a hung command. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Where checkouts live, in the container and in the workspace alike. */
const DEFAULT_CWD = "/workspace";

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
 * Wrap a command so it runs under {@link ComputerConfig.shell} with its two output
 * streams merged, or hand it back untouched when no shell is configured.
 *
 * One quoted argument, not string concatenation: the command is model-authored
 * and routinely contains quotes of its own (`git commit -m "…"`), so anything
 * less than `shellQuote` would re-parse the model's quoting and mangle it.
 *
 * ## Why `2>&1`
 *
 * A project's check is a chain — `wrangler types && prettier && eslint && tsc` —
 * and *which tool spoke last* is how you know which one failed. Handing back a
 * stdout block and a separate stderr block destroys that ordering, and the model
 * noticed before we did: it re-ran a 60-second gate as
 * `npm run check > /tmp/out 2>&1; cat /tmp/out` purely to read the transcript in
 * the order it happened. This is that workaround, done once, for free.
 *
 * The redirect binds to the wrapper process, so it applies to everything the
 * command writes however deeply nested — and there is no inner brace group or
 * subshell to mis-parse a command that already contains `&&`, quotes or redirects
 * of its own.
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
export function withShell(command: string, shell: string | undefined): string {
  return shell
    ? `${shell} -o pipefail -c ${shellQuote(command)} 2>&1`
    : command;
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
   * Environment merged into every command — API keys a build needs, proxy
   * settings. Host-supplied and never model input.
   *
   * Passed per-command rather than set on the container, deliberately: a value
   * set on the container is readable by anything the model later runs, including
   * a `printenv` it wrote itself.
   */
  env?: () => Record<string, string | undefined>;
}

/**
 * Middle-out truncation, so both the first error and the final summary survive.
 *
 * The guard is not defensive padding. Without it, a `max` at or below the
 * marker's own length makes `half` zero or negative, and `slice(-0)` is
 * `slice(0)` — the *whole* string — so the function returns more than it was
 * given: 500 characters in, 543 out at `max: 80`, and 1023 at `max: 60`. A
 * silent inversion of the one thing it exists to do, reachable from a public
 * config field.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  // No budget for two halves plus the marker: keep the head, which is where the
  // first error is, and say nothing clever.
  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

/**
 * Whether a path sits under a directory the workspace never receives.
 *
 * Only `node_modules` today, and it is not configurable here because it is not
 * our choice: `computerd` applies its own `DEFAULT_IGNORE` container-side, and
 * this list exists to *predict* that so a read can explain itself rather than
 * reporting a missing file. A dependency the model can plainly see in a `ls` but
 * cannot read is the kind of thing that sends it hunting for the wrong bug.
 */
const CONTAINER_ONLY_SEGMENTS = ["node_modules"];

export function isContainerOnly(path: string): boolean {
  return path
    .split("/")
    .some((segment) => CONTAINER_ONLY_SEGMENTS.includes(segment));
}

/** The sentence a container-only path gets instead of "not found". */
function containerOnlyNote(path: string, verb: string): string {
  return (
    `${path} is inside node_modules, which lives only in the container and is ` +
    `not part of the durable workspace — ${verb} cannot see it. Use \`sb_exec\` ` +
    `(for example \`cat ${path}\`) to read it through the shell instead.`
  );
}

/**
 * Does this path exist?
 *
 * `getWorkspace()` types `fs` as the in-process `WorkspaceFilesystem`, but the
 * value on the far side of a Durable Object boundary is a
 * `WorkspaceFilesystemStub`, which carries a few methods the local class does
 * not — `exists` among them. So the fast path is asked for rather than cast to,
 * and `stat` is the fallback for a host that hands back a local workspace.
 *
 * The fallback treats *any* `stat` failure as absence, which is the honest
 * reading for a tool whose entire answer is a boolean: there is no error channel
 * to distinguish "missing" from "unreadable", and the caller's next move — look
 * somewhere else — is the same either way.
 */
async function pathExists(
  fs: WorkspaceClient["fs"],
  path: string
): Promise<boolean> {
  const probe = (fs as { exists?: (p: string) => Promise<boolean> }).exists;
  if (typeof probe === "function") return probe.call(fs, path);
  return fs.stat(path).then(
    () => true,
    () => false
  );
}

/** Elapsed time in the shape a sentence wants. */
function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * What the install state means for a command about to run.
 *
 * The distinction between the two fields is the whole point, and getting it
 * wrong deadlocked a production run.
 *
 * - `block` — the command was **not run**. Only ever set while an install is
 *   genuinely in flight, which is a state that resolves on its own.
 * - `warn` — the command **was run**, with a note prepended saying the tree it
 *   ran against may be incomplete.
 *
 * A failed install used to `block`, which is wrong twice. It is unbounded:
 * nothing clears the record except another checkout, so one failed install
 * disables the shell for the rest of the session — `echo hello` included, which
 * is exactly how it was reported. And it is self-contradictory: the message told
 * the model to "re-run the install yourself with sb_exec" while `sb_exec` was
 * the tool refusing to run. There was no way out of it from inside the task.
 *
 * A failed install is a fact about `node_modules`, not about the shell. The
 * container is fine; `git status`, `ls`, `cat` and the install command itself
 * all work. So it is reported, not enforced — the model gets real output and
 * decides what it means.
 */
interface InstallGate {
  /** Set only for an install still in flight: the command did not run. */
  block?: string;
  /** Set for a failed install: the command ran, with this prepended. */
  warn?: string;
}

function installGate(status: InstallState | undefined): InstallGate {
  if (!status) return {};

  if (status.state === "running") {
    const tail = status.tail ? `\nlast output:\n${status.tail}` : "";
    return {
      block:
        `dependency install still running (${humanMs(Date.now() - status.startedAt)}` +
        `, \`${status.command}\`). Nothing was run — call again in a moment.${tail}`
    };
  }

  if (status.state === "failed") {
    const code =
      status.exitCode === undefined ? "" : ` (exit ${status.exitCode})`;
    return {
      warn:
        `⚠ the dependency install \`${status.command}\` failed${code}: ` +
        `${status.error}\nThe command below still ran. If you have not already ` +
        `re-run that install yourself, anything importing from node_modules ` +
        `will fail — if you have, and it succeeded, this note is stale and you ` +
        `can ignore it. The host cannot see an install it did not start, so it ` +
        `keeps reporting the last one it did.`
    };
  }

  return {};
}

/**
 * Render a completed command the way a terminal would, minus the noise.
 *
 * ## Every command ends with its verdict, including the successful ones
 *
 * This used to print the exit code **only when it was non-zero**, on the theory
 * that a clean run speaks for itself. It does not, and the models said so: across
 * two production runs, all five `npm run check` invocations were written by the
 * model as `npm run check; echo "EXIT_CODE=$?"`. It was appending a shell
 * workaround for a verdict the tool had declined to give it — and one of those
 * workarounds reached for `${PIPESTATUS[0]}`, which dash does not implement, which
 * failed the command, which cost a 58-second re-run of the whole gate.
 *
 * A tool that makes the caller reconstruct its own result is not saving noise.
 *
 * ## `status` is not the exit code
 *
 * `WorkspaceRuntimeStatus` is `completed | failed | cancelled`, and it was dropped
 * on the floor here. A command killed at the `timeoutMs` ceiling rendered exactly
 * like one that ran to completion and failed — so "your test suite was killed at
 * ten minutes" and "your test suite has a failing test" arrived identical, and they
 * want opposite responses. Anything other than `completed` is now stated.
 *
 * ## One budget, applied once
 *
 * `truncateOutput` used to run per stream, so `maxOutputBytes` was really "up to
 * twice this". It now bounds the rendered transcript, which is the thing that
 * actually reaches the context window.
 */
export function renderResult(
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    status?: WorkspaceRuntimeStatus;
  },
  maxBytes: number
): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  // Empty whenever the host configured a `shell`, which merges the streams at the
  // source so the transcript keeps its causal order. Kept for hosts that did not:
  // two labelled blocks beat silently dropping half the output.
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);

  const body = truncateOutput(parts.join("\n"), maxBytes);
  const state =
    result.status && result.status !== "completed" ? ` (${result.status})` : "";
  const verdict = `--- exit ${result.exitCode}${state} ---`;
  return body ? `${body}\n${verdict}` : `(no output)\n${verdict}`;
}

/**
 * Programs that read `node_modules`, recognised **in command position only**.
 *
 * Position is what makes this usable rather than merely cautious. Matching these
 * anywhere in the string looks equivalent and is not: `\bvitest\b` also fires on
 * `cat vitest.config.ts`, and `next.config.js`, `eslint.config.js` and
 * `vite.config.ts` are exactly the files a subagent reads while orienting itself.
 * Every one of those reads would then queue behind an `npm ci` it has no use for,
 * which is the cost this whole check exists to remove.
 */
const DEPENDENCY_TOOLS = new Set([
  "node",
  "nodemon",
  "deno",
  // Position-checked rather than matched loosely, unlike its `bunx` sibling in
  // PACKAGE_MANAGERS: `\bbun\b` also fires on `bun.lockb`, a file worth reading.
  "bun",
  "tsc",
  "tsx",
  "ts-node",
  "vitest",
  "jest",
  "mocha",
  "eslint",
  "prettier",
  "vite",
  "webpack",
  "rollup",
  "esbuild",
  "parcel",
  "next",
  "nuxt",
  "astro",
  "remix",
  "playwright",
  "cypress",
  "storybook"
]);

/**
 * Package managers, recognised **anywhere**.
 *
 * These are safe to match loosely because none of them is plausible as a
 * filename, and matching them loosely is what catches a build hidden one level
 * down — `bash -c 'npm run check'`, `time npm test`, `xargs -n1 npx tsc`.
 */
const PACKAGE_MANAGERS = /\b(?:npm|npx|pnpm|pnpx|yarn|bunx)\b/;

/** Splits a command into the pieces the shell would run as separate programs. */
const SHELL_OPERATORS = /\|\||&&|[;|\n()]/;

/** `FOO=bar` — a leading assignment, not the program being run. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Does this command plausibly read `node_modules`, and therefore have to wait for
 * a dependency install to finish?
 *
 * The two mistakes are not symmetric, so this leans toward waiting:
 *
 * - A false positive costs a wait the command did not need — the behaviour before
 *   this existed, so nothing regresses.
 * - A false negative runs a command against a half-built `node_modules` and hands
 *   the model a "cannot find module" that has nothing to do with its change.
 *
 * It is not a shell parser and does not try to be. A build reached through a
 * variable, or a script that shells out to one, waits for nothing and may see a
 * partial tree — which is the pre-existing risk whenever an install fails and the
 * gate warns rather than blocking.
 */
export function needsDependencies(command: string): boolean {
  // A path into the tree needs the tree, whatever position it appears in — this
  // is how `./node_modules/.bin/eslint` is caught, whose program name is `eslint`
  // only after the directory prefix is stripped.
  if (/\bnode_modules\b/.test(command)) return true;
  if (PACKAGE_MANAGERS.test(command)) return true;

  for (const segment of command.split(SHELL_OPERATORS)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++;
    if (i >= words.length) continue;
    const head = words[i];
    // `/usr/local/bin/tsc` and `./bin/vitest` are the same program as `tsc` and
    // `vitest`; only the basename identifies it.
    if (DEPENDENCY_TOOLS.has(head.slice(head.lastIndexOf("/") + 1)))
      return true;
  }
  return false;
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

    const deadline = Date.now() + gateMs;
    let status = await read();
    while (status?.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
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
          const options = {
            cwd: overrideCwd ?? cwd,
            encoding: "utf8" as const,
            timeoutMs,
            ...(definedEnv() ? { env: definedEnv() } : {})
          };
          using handle = await ws.runtime.exec(
            withShell(command, config.shell),
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
          console.warn("[computer] sb_exec failed", {
            command,
            gateMs: gateMsWaited,
            durationMs: Date.now() - startedAtMs - gateMsWaited,
            timeoutMs,
            err: String(err)
          });
          // Returned, not thrown: a failed command is usually the model's to
          // recover from, and it can only recover from what it is told.
          return note(`error running command: ${String(err)}`);
        }
      }
    }),

    sb_read: tool({
      description:
        "Read a file from the workspace. Returns the file's text, or a note if it does not exist. Files under node_modules are not in the workspace — read those with sb_exec.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, e.g. '/workspace/repo/src/a.ts'")
      }),
      execute: async ({ path }) => {
        if (isContainerOnly(path)) return containerOnlyNote(path, "sb_read");
        try {
          using ws = await workspace();
          return truncateOutput(await ws.fs.readFile(path, "utf8"), maxBytes);
        } catch (err) {
          return `error reading ${path}: ${String(err)}`;
        }
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
        if (isContainerOnly(path)) return containerOnlyNote(path, "sb_write");
        try {
          using ws = await workspace();
          const dir = path.slice(0, path.lastIndexOf("/"));
          if (dir) await ws.fs.mkdir(dir, { recursive: true });
          await ws.fs.writeFile(path, content);
          return `wrote ${path} (${content.length} bytes)`;
        } catch (err) {
          return `error writing ${path}: ${String(err)}`;
        }
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
        if (isContainerOnly(path)) return containerOnlyNote(path, "sb_edit");
        try {
          using ws = await workspace();
          const content = await ws.fs.readFile(path, "utf8");
          const occurrences = content.split(find).length - 1;
          // Refusing an ambiguous edit is the whole value of this tool over
          // sb_write: a silent first-match replace corrupts the file in a way
          // that surfaces much later, usually as a confusing test failure.
          if (occurrences === 0) return `no match for that text in ${path}`;
          if (occurrences > 1)
            return `that text appears ${occurrences} times in ${path} — add surrounding context to make it unique`;
          await ws.fs.writeFile(path, content.replace(find, replace));
          return `edited ${path}`;
        } catch (err) {
          return `error editing ${path}: ${String(err)}`;
        }
      }
    }),

    sb_ls: tool({
      description:
        "List files in a workspace directory. node_modules is not in the workspace — list it with sb_exec.",
      inputSchema: z.object({
        path: z.string().describe("Absolute directory path"),
        recursive: z
          .boolean()
          .optional()
          .describe("Recurse into subdirectories")
      }),
      execute: async ({ path, recursive }) => {
        if (isContainerOnly(path)) return containerOnlyNote(path, "sb_ls");
        try {
          using ws = await workspace();
          if (recursive) {
            const paths = await ws.fs.ls(path);
            if (paths.length === 0) return `(${path} is empty)`;
            return truncateOutput(paths.join("\n"), maxBytes);
          }
          const entries = await ws.fs.readdir(path);
          if (entries.length === 0) return `(${path} is empty)`;
          return truncateOutput(
            entries
              .map((e) => `${e.name}${e.isDirectory ? "/" : ""}`)
              .join("\n"),
            maxBytes
          );
        } catch (err) {
          return `error listing ${path}: ${String(err)}`;
        }
      }
    }),

    sb_exists: tool({
      description: "Check whether a path exists in the workspace.",
      inputSchema: z.object({ path: z.string().describe("Absolute path") }),
      execute: async ({ path }) => {
        if (isContainerOnly(path)) return containerOnlyNote(path, "sb_exists");
        try {
          using ws = await workspace();
          return (await pathExists(ws.fs, path))
            ? `${path} exists`
            : `${path} does not exist`;
        } catch (err) {
          return `error checking ${path}: ${String(err)}`;
        }
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

    using handle = await ws.runtime.exec(withShell(command, config.shell), {
      cwd: options?.cwd ?? config.cwd ?? DEFAULT_CWD,
      encoding: "utf8",
      timeoutMs: options?.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(env ? { env } : {})
    });
    const result = await handle.result();

    return {
      // `/repo` branches on `success`, which `@cloudflare/sandbox` reported and
      // this runtime does not — it reports `status` and `exitCode`. Derived from
      // the exit code rather than from `status`, because a command that runs and
      // fails is `completed` here.
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
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
      "- `sb_ls` and `sb_exists` inspect the filesystem.",
      "Command output is truncated from the middle when large, so run targeted commands and read specific files rather than printing everything.",
      // Both halves of this matter and they pull in opposite directions, which
      // is why they are stated together rather than left for the model to work
      // out from a confusing result.
      "The checkout is durable: it survives between tasks and is still there after the container restarts, so it may already contain work from an earlier task — check before assuming it is empty.",
      "`node_modules` is the exception. It lives only in the container, so it is rebuilt whenever the container restarts, and the file tools cannot see inside it — use `sb_exec` to read a dependency's source."
    ].join("\n")
  });
}
