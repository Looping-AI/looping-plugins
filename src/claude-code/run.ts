import { shellQuote } from "@cloudflare/computer";
import type {
  WorkspaceRuntimeExecHandle,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeGetOptions,
  WorkspaceRuntimeKillOptions
} from "@cloudflare/computer";
import type { ProgressEvent } from "@dynamicagents/core/subtasks";
import {
  parseStream,
  toProgress,
  type ClaudeCodeEvent,
  type ClaudeCodeResult
} from "./events.js";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "./config.js";

/**
 * Launching Claude Code in the workspace container, and draining it in windows.
 *
 * ## One Dynamic Agents subtask is one `claude -p` session
 *
 * Not one turn, and not one tool call. The unit has to be substantial because of
 * what an invocation costs before it does anything: the harness carries an
 * 18.7-27k token cached prefix, and a ten-call burst billed **twenty** raw input
 * tokens against 187,130 cache reads. On anything short the prefix is the bill.
 *
 * ## Detached, then re-attached — never owned by a request
 *
 * The run is spawned under an exec id and left running. Each chunk re-attaches,
 * drains for a bounded window, and returns. That shape is not a preference: a
 * drain owned by an RPC that returns in milliseconds gets disposed mid-command,
 * which is exactly how the dependency install used to die halfway through
 * `npm ci`.
 *
 * ## The cursor
 *
 * `getExec(id, { resume })` accepts `"tail"`, `"full"` **or an event sequence
 * number**, and the number is what this uses. Each chunk records the last `seq`
 * it consumed, so the next one resumes exactly there instead of replaying an
 * arbitrary tail. Replay still happens when a chunk dies before it can
 * checkpoint, which is why the progress keys stay positional (see
 * `toProgress`); the cursor makes replay rare, the keys make it harmless.
 *
 * The cursor also carries the **exec id** and the **parsed result**, and both
 * are there for reasons that only show up under concurrency or retry — see
 * {@link DrainCursor}.
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

/** Namespace for every session exec id in a workspace. */
export const CLAUDE_EXEC_PREFIX = "claude-code-run";

/**
 * The exec id one session occupies.
 *
 * **Per subtask, not fixed**, and the difference is load-bearing. A workspace is
 * one Durable Object and one container, but subtasks are a flat *concurrent*
 * fan-out — two `claude-code` subtasks for the same caller and repository run at
 * the same time, against the same workspace. Under a single shared id they
 * would spawn over one another, each drain would attach to whichever exec won,
 * and `killRun` would stop somebody else's session. That is the displacement bug
 * the coder's install guard exists to prevent, in a new place; here the answer
 * is simply not to share the id.
 *
 * Fixed *per subtask*, though, because the point is still to find it again: an
 * isolate that dies mid-drain leaves the session running in the container, and
 * `getExec` is how the next chunk re-attaches instead of starting a second one.
 */
export function execIdFor(subtaskId: string | number): string {
  return `${CLAUDE_EXEC_PREFIX}:${subtaskId}`;
}

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

/**
 * The environment key a host may not set.
 *
 * `LaunchOptions.env` is merged last so a deployment can add what a repository
 * needs, and that merge is exactly how the placeholder could be replaced by a
 * real credential — silently, and in every container from then on. The whole
 * design rests on the container holding nothing worth stealing, so this one key
 * is refused rather than overridden.
 */
const RESERVED_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

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
   * These steer rather than enforce, and the distinction matters: the inner
   * tree is invisible to Dynamic Agents' scheduler and unreachable by its
   * cancellation sweep, so a cap it chooses to ignore has no backstop. What
   * actually bounds the spend is the egress gateway, which every inner call
   * also crosses.
   */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;
  /**
   * How the session answers its own permission prompts.
   *
   * Defaults to {@link DEFAULT_PERMISSION_MODE}. See
   * {@link file://./config.ts ClaudeCodeConfig.permissionMode} for why the
   * default is the permissive one, and {@link buildLaunch} for the root guard
   * that decides how it has to be passed.
   */
  permissionMode?: PermissionMode;
  /**
   * Merged last, so a host can add what a repository needs.
   *
   * **Never secrets**, and {@link RESERVED_ENV_KEY} is refused outright rather
   * than trusted to the reader of that sentence.
   */
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
 *
 * ## `--permission-mode`, and the root guard behind it
 *
 * `-p` is headless. There is no terminal, so there is nobody to answer a
 * permission prompt — and Claude Code's headless path does not wait for one, it
 * **auto-denies**. Left unset the mode is `default`, and `default` gates Write,
 * Edit and every Bash command. A session in that state reads the repository
 * perfectly and cannot change one byte of it, while reporting prose that reads
 * like considered reluctance rather than a blocked tool. That cost this
 * deployment a day of "the container is fixed but nothing lands".
 *
 * So the mode is passed explicitly, and {@link DEFAULT_PERMISSION_MODE} is
 * `bypassPermissions` — see
 * {@link file://./config.ts ClaudeCodeConfig.permissionMode} for why the
 * permissive value is the correct default here rather than a concession.
 *
 * **`IS_SANDBOX=1` ships in the same branch as the flag, and separating the two
 * breaks a session harder than passing no flag at all.** The container runs as
 * root, and the CLI refuses to bypass its permission checks under uid 0 unless
 * that variable is set: it calls `process.exit(1)` **before the first JSON
 * line**, with the only explanation on stderr. The failure then surfaces as
 * "exited with code 1 without reporting a result" and names nothing. One branch
 * below writes both so they cannot drift, and the variable is applied *after* a
 * host's `env` so a host cannot unset the thing making its own mode work.
 *
 * `IS_SANDBOX` has one other documented effect in this client: a repeated API
 * `529` stops raising the custom overload error and keeps retrying instead.
 * Harmless here — the egress gateway is what decides when to give up.
 *
 * The alternative is an image that does not run as root, which is a real option
 * and a much larger one: the FUSE mount, the checkout and every install path
 * currently assume uid 0. If that ever changes, this variable is the line to
 * delete.
 */
export function buildLaunch(options: LaunchOptions): Launch {
  /**
   * Refused rather than silently dropped.
   *
   * A host that set this meant something by it, and the something is always
   * wrong — the placeholder is what makes the container safe to run a
   * stranger's `postinstall` in. The config is static, so this fails on the
   * first run in development rather than surprising a live task.
   */
  if (options.env && RESERVED_ENV_KEY in options.env) {
    throw new Error(
      `claude-code: ${RESERVED_ENV_KEY} cannot be set through \`env\`. The ` +
        "container is launched with a placeholder and the egress gateway swaps " +
        "in the real credential on the way out; putting a real one here would " +
        "hand it to every process in the container, including a cloned " +
        "repository's install scripts. Pass it as `credential` instead."
    );
  }

  const permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;

  const argv = ["claude", "-p", shellQuote(options.prompt)];
  argv.push("--output-format", "stream-json", "--verbose");
  argv.push("--permission-mode", permissionMode);
  if (options.model) argv.push("--model", shellQuote(options.model));
  if (options.maxTurns !== undefined)
    argv.push("--max-turns", String(options.maxTurns));

  const env: Record<string, string> = {
    // Pinned image; an autoupdate would move the wire shape the gateway and the
    // parser are both written against, mid-run and without a deploy.
    DISABLE_AUTOUPDATER: "1",
    // Telemetry and feature-flag fetches. Turned off at the source so an
    // egress-restricted deployment does not fill its logs with 403s that mean
    // nothing.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  if (options.maxSubagentDepth !== undefined)
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(options.maxSubagentDepth);
  if (options.maxConcurrentSubagents !== undefined)
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(
      options.maxConcurrentSubagents
    );

  return {
    command: argv.join(" "),
    // The last two are applied **after** the host's environment rather than
    // before it. For the placeholder that makes the guard above a second line
    // rather than the only one; for `IS_SANDBOX` it means a host cannot unset
    // the variable its own permission mode depends on — see the note above.
    env: {
      ...env,
      ...options.env,
      ...(permissionMode === "bypassPermissions"
        ? { IS_SANDBOX: "1" }
        : undefined),
      [RESERVED_ENV_KEY]: CREDENTIAL_PLACEHOLDER
    }
  };
}

/** Where a drain got to. Persisted between chunks by the caller. */
export interface DrainCursor {
  /**
   * The exec id this session occupies.
   *
   * Carried rather than derived so a re-attach cannot compute a different one
   * from the subtask id it happens to have in hand.
   */
  execId: string;
  /** The last event sequence consumed; the next chunk resumes from here. */
  seq: number;
  /** Bytes after the last newline — an incomplete line the next read finishes. */
  carry: string;
  /** Progress notes emitted so far. The base for the positional keys. */
  emitted: number;
  /**
   * The `result` line, once seen.
   *
   * Carried because it and the `exit` event are two separate events and a window
   * can end between them. Without this a run whose result arrived in the last
   * moments of one chunk reports a terminal outcome with **no result** in the
   * next — and `persistResult` converts an empty report into a failure, so a
   * successful session would be recorded as a failed one.
   */
  result?: ClaudeCodeResult;
  /**
   * A bounded slice of the session's stderr, for the runs that explain
   * themselves nowhere else.
   *
   * stderr is not the protocol stream and is never parsed as one — see
   * `consume` below. It is kept for exactly one case: a process that exits
   * **before** emitting a `result` line, where the JSON stream holds nothing and
   * the only account of what happened is the text the CLI printed on its way
   * out. A bad flag, a refused permission mode under root, a Node crash. Without
   * this the caller can only report an exit code.
   *
   * Carried on the cursor rather than kept local because the death and the exit
   * event can land in different windows.
   */
  stderr?: string;
}

/** A cursor for a session that has not started yet. */
export function freshCursor(execId: string): DrainCursor {
  return { execId, seq: 0, carry: "", emitted: 0 };
}

/** Distinguishes "the window ran out" from a real stream event in the race below. */
const WINDOW_EXPIRED = Symbol("window-expired");

export type DrainOutcome =
  | { done: false; cursor: DrainCursor; progress: ProgressEvent[] }
  | {
      done: true;
      cursor: DrainCursor;
      progress: ProgressEvent[];
      exitCode: number;
      /** Absent when the process died without ever emitting a `result` line. */
      result?: ClaudeCodeResult;
      /**
       * What the process printed on stderr, bounded — only when there is no
       * `result` to explain the exit. Present on the terminal outcome alone
       * because that is the only place a caller has nothing else to report.
       */
      stderr?: string;
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

/** Whether a thrown value is the runtime refusing to reuse a live exec id. */
function isExecBusy(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "EEXEC_BUSY";
}

/**
 * Start a session, detached.
 *
 * **Falls back to attaching when the id is already live**, which is not a
 * nicety. `start` spawns and then drains for minutes, so a chunk that fails
 * anywhere after the spawn is retried by the Workflow with no cursor to resume
 * from — and `@cloudflare/computer` refuses to reuse an id whose execution is
 * still running (`EEXEC_BUSY`). Without this the retry throws, every later retry
 * throws the same way, and a perfectly healthy session in the container becomes
 * unreachable.
 */
export async function startRun(
  runtime: SessionRuntime,
  options: LaunchOptions & { execId: string; timeoutMs: number }
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  const { command, env } = buildLaunch(options);
  try {
    return await runtime.exec(command, {
      id: options.execId,
      cwd: options.dir,
      encoding: "utf8",
      env,
      timeoutMs: options.timeoutMs
    });
  } catch (err) {
    if (!isExecBusy(err)) throw err;
    console.info(
      "[claude-code] a session is already running under this id — attaching",
      { execId: options.execId }
    );
    return await attachRun(runtime, freshCursor(options.execId));
  }
}

/** Re-attach to a session this isolate did not start. */
export async function attachRun(
  runtime: SessionRuntime,
  cursor: DrainCursor
): Promise<WorkspaceRuntimeExecHandle<"utf8">> {
  return await runtime.getExec(cursor.execId, {
    encoding: "utf8",
    // `0` is a legal seq and also the beginning, so a fresh cursor resumes from
    // the start either way. Later chunks name their own place.
    resume: cursor.seq
  });
}

/**
 * Drain a session for one bounded window.
 *
 * Returns `done: false` when the window expired with the process still running —
 * the caller checkpoints the cursor and comes back — or `done: true` once the
 * stream has finished.
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
  let result = cursor.result;
  let stderr = cursor.stderr ?? "";
  let exitCode: number | undefined;

  /**
   * Parse whatever complete lines the buffer now holds.
   *
   * Called after **every** stdout event rather than once at the end. Claude
   * Code's stream carries whole tool results, so a chunk that only parsed on the
   * way out would hold an eight-minute transcript of a noisy build in a Durable
   * Object's memory; parsing eagerly keeps only `carry`, which is at most one
   * incomplete line.
   */
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
      //
      // **The sample is the half that makes this actionable.** For a release
      // this warning fired on every session in the deployment with
      // `skipped: 1`, which told an operator that something was being dropped
      // and nothing whatever about what — so it was read as background noise
      // while it was in fact the only trace of a real fault. A count says a
      // schema moved; the line says which way.
      console.warn("[claude-code] unparsed lines in the session stream", {
        skipped: parsed.skipped,
        ...(parsed.sample ? { sample: parsed.sample } : {})
      });
    }
  };

  const finish = (code?: number): DrainOutcome => {
    const progress = toProgress(events, cursor.emitted);
    const next: DrainCursor = {
      execId: cursor.execId,
      seq,
      carry: buffer,
      emitted: cursor.emitted + progress.length,
      ...(result ? { result } : {}),
      ...(stderr ? { stderr } : {})
    };
    return code === undefined
      ? { done: false, cursor: next, progress }
      : {
          done: true,
          cursor: next,
          progress,
          exitCode: code,
          ...(result ? { result } : {}),
          // Only when there is no result. A session that reported for itself has
          // said everything worth saying, and its stderr is the CLI's own
          // diagnostic chatter — surfacing that beside a perfectly good report
          // would bury the report.
          ...(!result && stderr ? { stderr } : {})
        };
  };

  try {
    for (;;) {
      /**
       * Once the process has exited, stop racing the clock and read to the end.
       *
       * This is the single most important branch in the file. The stream
       * `@cloudflare/computer` hands back is wrapped by `withPostPull`, and that
       * wrapper runs **the container-to-workspace filesystem sync** when — and
       * only when — the underlying stream reaches `done`. Returning on the
       * `exit` event instead would leave it unread, so a session's edits would
       * never reach the durable checkout: the run reports success, the files are
       * simply not there.
       *
       * Reading on is also how the sync gets *awaited*: the wrapper resolves its
       * pull before it closes the stream, so observing `done` means the sync has
       * already finished.
       */
      if (exitCode !== undefined) {
        const next = await reader.read();
        if (next.done) return finish(exitCode);
        consume(next.value);
        continue;
      }

      const remaining = deadline - now();
      if (remaining <= 0) return await yieldWindow();

      const next = await Promise.race([
        reader.read(),
        sleep(remaining).then((): typeof WINDOW_EXPIRED => WINDOW_EXPIRED)
      ]);

      if (next === WINDOW_EXPIRED) return await yieldWindow();
      if (next.done) {
        // The stream ended without an `exit` event — the container went away
        // under the run. Report it as a failure rather than as still-running,
        // or the caller waits out its whole chunk budget on a dead process.
        return finish(-1);
      }
      consume(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  function consume(event: {
    seq: number;
    name: string;
    value?: string;
    code?: number;
  }): void {
    seq = event.seq;
    if (event.name === "stdout" && event.value !== undefined) {
      buffer += event.value;
      absorb();
    }
    // stderr is Claude Code's own diagnostics, not the protocol stream. Kept out
    // of the parser so a warning line cannot be mistaken for an event — but
    // **kept**, which it was not, because a process that dies before its first
    // JSON line leaves nothing else behind. See `DrainCursor.stderr`.
    if (event.name === "stderr" && event.value !== undefined) {
      stderr = boundStderr(stderr + event.value);
    }
    if (event.name === "exit") exitCode = event.code ?? -1;
  }

  /**
   * End the window with the session still running.
   *
   * **Cancels rather than merely releasing the lock.** Releasing leaves the
   * attachment and its pending read alive on the far side, and a chunked run
   * would strand one per window. `cancel` is the wrapper's own designed exit —
   * it settles the pending read, resolves the sync outcome as `pending`, and
   * lets the next chunk's `getExec` open a fresh attachment that will run the
   * real sync when the session finally ends.
   */
  async function yieldWindow(): Promise<DrainOutcome> {
    absorb();
    const outcome = finish();
    await reader.cancel("chunk window expired").catch(() => {});
    return outcome;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How much stderr is worth carrying, in characters. */
const STDERR_MAX = 2_000;

/**
 * Keep stderr bounded, from both ends.
 *
 * Applied on every append rather than once at the end, so a session that prints
 * megabytes to stderr — a verbose build, a runaway loop — cannot grow a Durable
 * Object's memory while it does it.
 *
 * Head *and* tail because which end carries the answer depends on how the
 * process died, and the caller cannot know in advance: a Node crash puts its
 * error first and a stack after it, while a CLI that validates its arguments and
 * gives up prints one line and exits, making that line the last thing there is.
 * Keeping both ends costs a few hundred characters and removes the guess.
 *
 * Not a re-implementation of `/computer`'s `truncateOutput`: reaching across the
 * subpath boundary for it would merge two realms `verify:exports` keeps apart,
 * which is the same reason `/repo` carries its own.
 */
function boundStderr(text: string): string {
  if (text.length <= STDERR_MAX) return text;
  const half = Math.floor((STDERR_MAX - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

/**
 * Stop a session.
 *
 * `SIGTERM` rather than `SIGKILL`: Claude Code aborts the turn, kills its own
 * Bash process tree, runs its `SessionEnd` hooks and exits 143. A `SIGKILL`
 * leaves whatever the session had spawned still running in a container the
 * workspace will keep using.
 */
export async function killRun(
  runtime: SessionRuntime,
  execId: string
): Promise<void> {
  await runtime.killExec(execId, { signal: "SIGTERM" });
}
