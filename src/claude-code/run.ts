import { shellQuote } from "@cloudflare/computer";
import type {
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions
} from "@cloudflare/computer";
import type { ProgressEvent } from "@loopingai/core/subtasks";
import {
  parseStream,
  toProgress,
  type ClaudeCodeEvent,
  type ClaudeCodeResult
} from "./events.js";

/**
 * Launching Claude Code in the workspace container, and draining it in windows.
 *
 * ## One Looping subtask is one `claude -p` session
 *
 * Not one turn, and not one tool call. The unit has to be substantial because of
 * what an invocation costs before it does anything: the harness carries an
 * 18.7-27k token cached prefix, and a ten-call burst billed **twenty** raw input
 * tokens against 187,130 cache reads. On anything short the prefix is the bill.
 *
 * ## Detached, then re-attached — never owned by a request
 *
 * The run is spawned under a fixed exec id and left running. Each chunk
 * re-attaches, drains for a bounded window, and returns. That shape is not a
 * preference: a drain owned by an RPC that returns in milliseconds gets disposed
 * mid-command, which is exactly how the dependency install used to die halfway
 * through `npm ci`.
 *
 * ## The cursor, and why it is a `seq` rather than a tail
 *
 * `getExec(id, { resume })` accepts `"tail"`, `"full"` **or an event sequence
 * number**, and the number is what this uses. Each chunk records the last `seq`
 * it consumed, so the next one resumes exactly there instead of replaying an
 * arbitrary tail — no duplicate parsing on the happy path at all. Replay still
 * happens when a chunk dies before it can checkpoint, which is why the progress
 * keys stay positional (see `toProgress`); the cursor makes replay rare, the
 * keys make it harmless.
 */

/**
 * Just enough of a workspace runtime to drive one detached session.
 *
 * Structural rather than `@cloudflare/computer`'s `WorkspaceRuntime`, for the
 * reason `InstallProbe` is structural one folder over: the class is not exported
 * as a type, it carries a dozen members none of this needs, and a spec that has
 * to construct one cannot test a drain without a container. Three methods is the
 * whole dependency.
 */
export interface SessionRuntime {
  exec(
    source: string,
    options: WorkspaceRuntimeExecOptions<"utf8">
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  getExec(
    id: string,
    options: WorkspaceRuntimeGetOptions<"utf8">
  ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
  killExec(id: string, options?: WorkspaceRuntimeKillOptions): Promise<void>;
}

/** The exec id a run occupies. Fixed, because the point is to find it again. */
export const CLAUDE_EXEC_ID = "claude-code-run";

/**
 * What the container is given instead of a credential.
 *
 * Claude Code does not validate it locally — proven in the Phase 0c spike, where
 * a run with this exact value succeeded and the proxy log confirmed the
 * container only ever sent the placeholder. The egress gateway swaps in the real
 * credential on the way out, so a `postinstall` script that dumps the
 * environment learns this and nothing else.
 *
 * Shaped like a real token deliberately: something that looks obviously fake
 * invites a future reader to "fix" it by putting the real one there.
 */
export const CREDENTIAL_PLACEHOLDER = "sk-ant-oat01-" + "0".repeat(24);

export interface LaunchOptions {
  /** The subtask's prompt — the whole of what this session is asked to do. */
  prompt: string;
  /** Where the checkout is. The session runs with this as its cwd. */
  dir: string;
  model?: string;
  /** Ceiling on the *outer* session's turns. Advisory; the budget gate is not. */
  maxTurns?: number;
  /**
   * Caps on Claude Code's own subagent tree.
   *
   * These steer rather than enforce, and the distinction matters: the inner tree
   * is invisible to Looping's scheduler and unreachable by its cancellation
   * sweep, so a cap it chooses to ignore has no backstop. What actually bounds
   * the spend is the egress gateway, which every inner call also crosses.
   */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;
  /** Merged last, so a host can add what a repository needs. Never secrets. */
  env?: Record<string, string>;
}

export interface Launch {
  command: string;
  env: Record<string, string>;
}

/**
 * Build the command and environment for one session.
 *
 * `--output-format stream-json` with `--verbose`, because the stream is the only
 * way to report progress before the run ends and a run legitimately lasts longer
 * than any single chunk. `--verbose` is required: without it Claude Code emits
 * only the final result even in stream mode.
 *
 * Note what is **absent**. No `--bare`, no `--settings` override, no
 * `CLAUDE_CONFIG_DIR`: a cloned repository's `CLAUDE.md`, skills and hooks are
 * exactly the material that makes the agent good at that repository, and the
 * container is already an arbitrary-code-execution environment by design — the
 * install runs the repo's `postinstall`, the agent runs its test suite. Stripping
 * one door while the others stand open buys nothing and costs the agent its
 * context. (§4 of the design plan, cancelled 2026-08-21.)
 *
 * No `ANTHROPIC_BASE_URL` either, and that one is a genuine simplification over
 * the spike: `http-gateway` egress intercepts transparently, so the client talks
 * to the real hostname and the gateway sees it. Nothing has to be told to use a
 * proxy, which means nothing in the container can be told *not* to.
 */
export function buildLaunch(options: LaunchOptions): Launch {
  const argv = ["claude", "-p", shellQuote(options.prompt)];
  argv.push("--output-format", "stream-json", "--verbose");
  if (options.model) argv.push("--model", shellQuote(options.model));
  if (options.maxTurns !== undefined)
    argv.push("--max-turns", String(options.maxTurns));

  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL_PLACEHOLDER,
    // Pinned image; an autoupdate would move the wire shape the gateway and the
    // parser are both written against, mid-run and without a deploy.
    DISABLE_AUTOUPDATER: "1",
    // Telemetry and feature-flag fetches the allowlist would refuse anyway.
    // Turned off at the source so the logs are not full of 403s that mean
    // nothing.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  if (options.maxSubagentDepth !== undefined)
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(options.maxSubagentDepth);
  if (options.maxConcurrentSubagents !== undefined)
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(
      options.maxConcurrentSubagents
    );

  return { command: argv.join(" "), env: { ...env, ...options.env } };
}

/** Where a drain got to. Persisted between chunks by the caller. */
export interface DrainCursor {
  /** The last event sequence consumed; the next chunk resumes from here. */
  seq: number;
  /** Bytes after the last newline — an incomplete line the next read finishes. */
  carry: string;
  /** Progress notes emitted so far. The base for the positional keys. */
  emitted: number;
}

export const FRESH_CURSOR: DrainCursor = { seq: 0, carry: "", emitted: 0 };

/** Distinguishes "the window ran out" from a real stream event in the race below. */
const WINDOW_EXPIRED = Symbol("window-expired");

export type DrainOutcome =
  | { done: false; cursor: DrainCursor; progress: ProgressEvent[] }
  | {
      done: true;
      cursor: DrainCursor;
      progress: ProgressEvent[];
      exitCode: number;
      /** Absent when the process died without emitting a `result` line. */
      result?: ClaudeCodeResult;
    };

export interface DrainOptions {
  /**
   * How long this chunk may block before checkpointing and yielding.
   *
   * Must stay comfortably under the Workflow step timeout, and it is what stops
   * a run burning its whole chunk allowance in seconds: a drain that returned
   * the moment it had nothing to read would exhaust `MAX_CHUNKS_PER_BRANCH`
   * before the session finished thinking.
   */
  windowMs: number;
  now?: () => number;
}

/**
 * Start a session, detached.
 *
 * Returns nothing to await beyond the spawn: the run belongs to the container
 * from here, and every later chunk reaches it through {@link drainRun}.
 */
export async function startRun(
  runtime: SessionRuntime,
  options: LaunchOptions & { timeoutMs: number }
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  const { command, env } = buildLaunch(options);
  return await runtime.exec(command, {
    id: CLAUDE_EXEC_ID,
    cwd: options.dir,
    encoding: "utf8",
    env,
    timeoutMs: options.timeoutMs
  });
}

/** Re-attach to a session this isolate did not start. */
export async function attachRun(
  runtime: SessionRuntime,
  cursor: DrainCursor
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  return await runtime.getExec(CLAUDE_EXEC_ID, {
    encoding: "utf8",
    // `0` would be `"full"` semantically but is a legal seq, so a fresh cursor
    // resumes from the beginning either way. Later chunks name their own place.
    resume: cursor.seq
  });
}

/**
 * Drain a session for one bounded window.
 *
 * Returns `done: false` when the window expired with the process still running —
 * the caller checkpoints the cursor and comes back — or `done: true` on the
 * `exit` event.
 */
export async function drainRun(
  handle: WorkspaceRuntimeExecHandle<"utf8">,
  cursor: DrainCursor,
  options: DrainOptions
): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.windowMs;

  const reader = handle.getReader();
  const events: ClaudeCodeEvent[] = [];
  let buffer = cursor.carry;
  let seq = cursor.seq;
  let result: ClaudeCodeResult | undefined;

  const finish = (exitCode?: number): DrainOutcome => {
    const progress = toProgress(events, cursor.emitted);
    const next: DrainCursor = {
      seq,
      carry: buffer,
      emitted: cursor.emitted + progress.length
    };
    return exitCode === undefined
      ? { done: false, cursor: next, progress }
      : {
          done: true,
          cursor: next,
          progress,
          exitCode,
          ...(result ? { result } : {})
        };
  };

  const absorb = (): void => {
    const parsed = parseStream(buffer);
    buffer = parsed.carry;
    for (const event of parsed.events) {
      events.push(event);
      if (event.kind === "result") result = event.result;
    }
    if (parsed.skipped > 0) {
      // Not fatal, and deliberately not silent: a systematic schema change
      // shows up here as a rising count long before it shows up as a run that
      // reports nothing.
      console.warn("[claude-code] unparsed lines in the session stream", {
        skipped: parsed.skipped
      });
    }
  };

  try {
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        absorb();
        return finish();
      }

      /**
       * The abandoned read is deliberate and is safe.
       *
       * When the window wins this race the pending `read()` is dropped on the
       * floor along with the reader. Nothing is lost, because the cursor names
       * the last *consumed* `seq` and the next chunk resumes from exactly there
       * — the event that read would have delivered is re-delivered.
       */
      const next = await Promise.race([
        reader.read(),
        sleep(remaining).then((): typeof WINDOW_EXPIRED => WINDOW_EXPIRED)
      ]);

      if (next === WINDOW_EXPIRED) {
        absorb();
        return finish();
      }
      if (next.done) {
        // The stream ended without an `exit` event — the container went away
        // under the run. Report it as a failure rather than as still-running,
        // or the caller waits out its whole chunk budget on a dead process.
        absorb();
        return finish(-1);
      }

      const event = next.value;
      seq = event.seq;
      if (event.name === "stdout") buffer += event.value;
      // stderr is Claude Code's own diagnostics, not the protocol stream. Kept
      // out of the parser so a warning line cannot be mistaken for an event.
      if (event.name === "exit") {
        absorb();
        return finish(event.code);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop a session.
 *
 * `SIGTERM` rather than `SIGKILL`: Claude Code aborts the turn, kills its own
 * Bash process tree, runs its `SessionEnd` hooks and exits 143. A `SIGKILL`
 * leaves whatever the session had spawned still running in a container the
 * workspace will keep using.
 */
export async function killRun(runtime: SessionRuntime): Promise<void> {
  await runtime.killExec(CLAUDE_EXEC_ID, { signal: "SIGTERM" });
}
