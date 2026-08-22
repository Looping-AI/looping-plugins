import { definePlugin, PLUGIN_CONTRACT_VERSION } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import { claudeCodeEgress } from "./egress.js";
import {
  attachRun,
  drainRun,
  killRun,
  startRun,
  FRESH_CURSOR,
  type DrainCursor,
  type DrainOutcome,
  type SessionRuntime
} from "./run.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WINDOW_MS,
  type ClaudeCodeConfig
} from "./config.js";
import { CLAUDE_CODE_SPEC, CLAUDE_CODE_TYPE } from "./recipe.js";

/**
 * `@loopingai/plugins/claude-code` — subtasks that run the Claude Code CLI.
 *
 * ## Why this exists
 *
 * A Claude **subscription** credential does not work for raw Messages API calls
 * on a frontier model: every Opus call returns `429` in ~10 ms at zero tokens.
 * The same credential, sent by the Claude Code client, succeeds — Opus 5,
 * Sonnet 5 and Haiku 4.5 all answer, at `service_tier: standard`. The harness is
 * the unlock, so the way to reach those models on a subscription is to run the
 * sanctioned client, which is what this plugin makes delegable.
 *
 * ## What it contributes, and what it does not
 *
 * It declares **one subtask type and no tool families**. That is unusual here
 * and it is the whole shape of the thing: Claude Code brings its own tools, its
 * own loop and its own context management, so there is nothing for core's
 * resumable runner to drive. The host's subagent overrides `executeChunk` and
 * calls {@link claudeCodeSession} instead.
 *
 * ## The credential never enters the container
 *
 * The session is launched with a placeholder. Every request out of the container
 * is intercepted by `computerd` and handed to {@link claudeCodeEgress} on the
 * Worker side, which swaps in the real credential, enforces a fail-closed host
 * allowlist, and can refuse a call that is over budget.
 *
 * That last one matters more than it looks. `--max-turns` and the subagent caps
 * are advisory and Claude Code's inner agent tree multiplies both; the gateway
 * is a ceiling, because a model call that does not cross it does not happen. A
 * 5-hour subscription session is worth roughly $10 of Opus-equivalent, and it is
 * shared with whoever is using Claude Code interactively.
 *
 * ## Requires
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), a container image with
 * the CLI installed at a pinned version, and a workspace Durable Object whose
 * egress policy is `{ mode: "http-gateway" }`. See the README.
 */

/**
 * Bind a config to a workspace runtime: start, drain, stop.
 *
 * The three calls a host's `executeChunk` needs and nothing else. State lives in
 * the {@link DrainCursor} the caller persists between chunks, so this holds none
 * and a fresh isolate picks up exactly where the last one stopped.
 */
export function claudeCodeSession(config: ClaudeCodeConfig) {
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const launch = (prompt: string, dir: string) => ({
    prompt,
    dir,
    ...(config.model ? { model: config.model } : {}),
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
    ...(config.maxSubagentDepth === undefined
      ? {}
      : { maxSubagentDepth: config.maxSubagentDepth }),
    ...(config.maxConcurrentSubagents === undefined
      ? {}
      : { maxConcurrentSubagents: config.maxConcurrentSubagents }),
    ...(config.env ? { env: config.env } : {})
  });

  return {
    /** Spawn a session and drain its first window. */
    async start(
      runtime: SessionRuntime,
      prompt: string,
      dir: string
    ): Promise<DrainOutcome> {
      const handle = await startRun(runtime, {
        ...launch(prompt, dir),
        timeoutMs
      });
      return await drainRun(handle, FRESH_CURSOR, { windowMs });
    },

    /** Re-attach to a running session and drain one more window. */
    async resume(
      runtime: SessionRuntime,
      cursor: DrainCursor
    ): Promise<DrainOutcome> {
      const handle = await attachRun(runtime, cursor);
      return await drainRun(handle, cursor, { windowMs });
    },

    /** Stop a session — `SIGTERM`, so its own process tree goes with it. */
    async stop(runtime: SessionRuntime): Promise<void> {
      await killRun(runtime);
    },

    /** The `Fetcher` the workspace object installs as its egress policy. */
    egress: () =>
      claudeCodeEgress({
        credential: config.credential,
        // Forwarded only when set. Defaulting it to `[]` here would turn "the
        // host said nothing" into "Anthropic only", which is the one reading
        // the three-way semantics exist to keep distinct.
        ...(config.restrictToHosts === undefined
          ? {}
          : { restrictToHosts: config.restrictToHosts }),
        ...(config.budget ? { budget: config.budget } : {}),
        label: CLAUDE_CODE_TYPE
      })
  };
}

export type ClaudeCodeSession = ReturnType<typeof claudeCodeSession>;

/**
 * The plugin.
 *
 * `subtaskType` and nothing else: no `toolFamilies`, because Claude Code's tools
 * are its own, and no `capability` on the plugin, because a plugin declaring a
 * subtask type puts its capability block on the **type** — declaring both makes
 * the main agent read the same advice twice per round.
 */
export function claudeCode(config: ClaudeCodeConfig): AgentPlugin {
  // Read once at construction so a deployment that forgot the secret fails at DO
  // start with a sentence naming this plugin, rather than at the first model
  // call inside a subtask somebody is waiting on. The thunk is still what the
  // gateway calls per request, so a rotation is picked up.
  if (!config.credential()) {
    throw new Error(
      "claude-code: no credential. Set CLAUDE_CODE_OAUTH_TOKEN (from " +
        "`claude setup-token`) and pass it as `credential: () => env.CLAUDE_CODE_OAUTH_TOKEN`."
    );
  }

  return definePlugin({
    key: "claude-code",
    contractVersion: PLUGIN_CONTRACT_VERSION,
    subtaskType: CLAUDE_CODE_SPEC,
    requires: { secrets: ["CLAUDE_CODE_OAUTH_TOKEN"] }
  });
}

export { ANTHROPIC_HOST, claudeCodeEgress } from "./egress.js";
export type { EgressBudget, EgressConfig } from "./egress.js";
export {
  buildLaunch,
  CLAUDE_EXEC_ID,
  CREDENTIAL_PLACEHOLDER,
  FRESH_CURSOR
} from "./run.js";
export type {
  DrainCursor,
  DrainOutcome,
  Launch,
  LaunchOptions,
  SessionRuntime
} from "./run.js";
export { parseStream, toProgress } from "./events.js";
export type {
  ClaudeCodeEvent,
  ClaudeCodeResult,
  ClaudeCodeUsage
} from "./events.js";
export {
  CLAUDE_CODE_CAPABILITY,
  CLAUDE_CODE_RECIPE,
  CLAUDE_CODE_SPEC,
  CLAUDE_CODE_TYPE
} from "./recipe.js";
export { DEFAULT_TIMEOUT_MS, DEFAULT_WINDOW_MS } from "./config.js";
export type { ClaudeCodeConfig } from "./config.js";
