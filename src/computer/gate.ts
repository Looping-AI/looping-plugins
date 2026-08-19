import type { InstallState } from "./install.js";
import { humanMs } from "./render.js";

/**
 * What a command has to wait for, and what to say when it never ran.
 *
 * `node_modules` lives in the container and dies with it, so a dependency
 * install is something in flight that a few commands need and most do not.
 * {@link needsDependencies} decides which, and {@link installGate} decides
 * whether that is worth blocking a command over — a distinction that deadlocked
 * a production run when it was got wrong. {@link execLostNote} covers the other
 * failure a model cannot diagnose from the error alone: a container replaced
 * underneath a command that was running.
 */

/**
 * The one `sb_exec` failure that is not the command's fault.
 *
 * An execution running when the container is replaced throws `EEXEC_LOST`.
 * Unexplained, the model receives `Execution "…" was lost when its container
 * runtime was replaced`, reads it as a crash, and goes looking at its command.
 *
 * What it needs is three facts: nothing ran to completion, the checkout survived
 * because the filesystem is the Durable Object's rather than the container's, and
 * `node_modules` did not because it never was. So re-run, and expect the install
 * to be rebuilding underneath.
 *
 * Matched on `code` rather than the message — the property the package sets
 * deliberately, and the one that survives a reworded string.
 */
export function execLostNote(err: unknown): string | undefined {
  if ((err as { code?: unknown } | null | undefined)?.code !== "EEXEC_LOST")
    return undefined;
  return (
    "the container was replaced while this command was running, so it was lost — " +
    "nothing ran to completion and no output survived. This is infrastructure, " +
    "not your command: re-run it. The checkout is durable and is exactly as you " +
    "left it, but `node_modules` lived in the old container and is being rebuilt, " +
    "so anything that needs dependencies may have to wait for that install."
  );
}

/**
 * What the install state means for a command about to run.
 *
 * The distinction between the two fields is the whole point:
 *
 * - `block` — the command was **not run**. Only ever set while an install is
 *   genuinely in flight, which is a state that resolves on its own.
 * - `warn` — the command **was run**, with a note prepended saying the tree it
 *   ran against may be incomplete.
 *
 * A *failed* install must never block, and the reason is that it deadlocks:
 * nothing clears the record except another checkout, so one failure disables the
 * shell for the rest of the session — `echo hello` included — while the message
 * tells the model to re-run the install with the tool that is refusing to run.
 *
 * A failed install is a fact about `node_modules`, not about the shell. The
 * container is fine; `git status`, `ls`, `cat` and the install command itself all
 * work. So it is reported rather than enforced, and the model decides.
 */
export interface InstallGate {
  /** Set only for an install still in flight: the command did not run. */
  block?: string;
  /** Set for a failed install: the command ran, with this prepended. */
  warn?: string;
}

export function installGate(status: InstallState | undefined): InstallGate {
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
 * Package managers, recognised **anywhere** except in the name of a file that
 * merely belongs to one.
 *
 * Matching them loosely is what catches a build hidden one level down —
 * `bash -c 'npm run check'`, `time npm test`, `xargs -n1 npx tsc` — and no
 * position check would see any of those.
 *
 * The lookahead is what keeps that affordable. `\b` breaks on a hyphen and on a
 * dot, so a bare loose match also fires on `cat pnpm-lock.yaml`, `cat yarn.lock`
 * and `cat pnpm-workspace.yaml` — orienting reads, which would then queue behind
 * an `npm ci` they have no use for. That is the same cost {@link DEPENDENCY_TOOLS}
 * checks position to avoid, and there is no reason to pay it here instead.
 */
const PACKAGE_MANAGERS =
  /\b(?:npm|npx|pnpm|pnpx|yarn|bunx)\b(?!-lock|\.lock|-workspace)/;

/** Splits a command into the pieces the shell would run as separate programs. */
const SHELL_OPERATORS = /\|\||&&|[;|\n()]/;

/** `FOO=bar` — a leading assignment, not the program being run. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that run *another* program, so the name after them is the one that
 * matters.
 *
 * Without these, `time vitest run` and `env CI=1 vitest run` read as commands
 * called `time` and `env`, neither of which is in {@link DEPENDENCY_TOOLS} — so
 * they skip the gate and run against a half-built `node_modules`, the expensive
 * half of the asymmetry {@link needsDependencies} documents. Package managers are
 * unaffected, since {@link PACKAGE_MANAGERS} matches anywhere.
 *
 * `sudo` is here because a container image that has it will have a model reach
 * for it, not because it should be needed.
 */
const COMMAND_WRAPPERS = new Set([
  "env",
  "time",
  "nice",
  "ionice",
  "nohup",
  "stdbuf",
  "timeout",
  "xargs",
  "sudo",
  "command",
  "exec"
]);

/**
 * An option, or the value that follows one — `nice -n 10`, `xargs -n1`.
 *
 * The unit suffix is not decoration: `timeout` takes `60s`, `5m`, `2h`, and a
 * bare-integer pattern reads that duration as the program being run. So
 * `timeout 60s vitest run` never reaches `vitest`, skips the gate, and tests
 * against a half-built `node_modules` — while `timeout 60 vitest run` works.
 */
const WRAPPER_ARGUMENT = /^-|^\d+[smhd]?$/;

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
    // Assignments, then a wrapper and whatever it takes, then round again:
    // `env CI=1 nice -n 10 vitest` is all three in one command.
    for (;;) {
      while (i < words.length && ENV_ASSIGNMENT.test(words[i]!)) i++;
      if (i >= words.length) break;
      if (
        !COMMAND_WRAPPERS.has(words[i]!.slice(words[i]!.lastIndexOf("/") + 1))
      )
        break;
      i++;
      while (i < words.length && WRAPPER_ARGUMENT.test(words[i]!)) i++;
    }
    if (i >= words.length) continue;
    const head = words[i];
    // `/usr/local/bin/tsc` and `./bin/vitest` are the same program as `tsc` and
    // `vitest`; only the basename identifies it.
    if (DEPENDENCY_TOOLS.has(head.slice(head.lastIndexOf("/") + 1)))
      return true;
  }
  return false;
}
