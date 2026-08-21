import type { EgressBudget } from "./egress.js";

/**
 * Everything one `claude-coder` deployment tunes, in one shape.
 *
 * Config at instantiation rather than an `env` argument, for the reason the
 * whole package works this way: `Env` is the ambient interface `wrangler types`
 * generates into a *consumer's* app and does not exist here, and on Workers
 * there is no module-scope `env` to read anyway.
 */
export interface ClaudeCodeConfig {
  /**
   * The real Anthropic credential, as a thunk.
   *
   * A thunk so a rotated secret is picked up without rebuilding the plugin list.
   * **This value never enters the container** — it is read on the Worker side by
   * the egress gateway and swapped into the outbound request. The container gets
   * {@link file://./run.ts CREDENTIAL_PLACEHOLDER}.
   *
   * A `claude setup-token` OAuth credential. There is deliberately no API-key
   * path: the subscription credential is the one that reaches frontier models
   * through this client, and a second path would be a second thing to get wrong.
   */
  credential: () => string;

  /** Which model the session runs. Unset, Claude Code picks its own default. */
  model?: string;

  /**
   * Ceiling on the *outer* session's turns.
   *
   * Advisory. Claude Code's own subagent tree multiplies whatever this says, and
   * the tree is invisible to Looping's scheduler. {@link budget} is the ceiling
   * that holds, because every inner call crosses the same gateway.
   */
  maxTurns?: number;

  /** Caps on Claude Code's own subagent tree. Advisory, like `maxTurns`. */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;

  /**
   * Hosts the container may reach beyond `api.anthropic.com`.
   *
   * In practice: the package registry, and nothing else. The container needs no
   * forge access at all — `/repo` runs clone, fetch and push as isomorphic-git
   * inside the workspace object, so the forge token stays on the Worker side.
   */
  allowHosts?: readonly string[];

  /** The spend gate the egress gateway consults before every model call. */
  budget?: EgressBudget;

  /**
   * How long one chunk blocks before checkpointing and yielding.
   *
   * Must stay under the Workflow step timeout with room to spare, and must be
   * long enough that a session does not exhaust its branch's chunk allowance
   * while it is still thinking. Defaults to eight minutes, against a 30-minute
   * step timeout and a 15-minute soft chunk budget.
   */
  windowMs?: number;

  /**
   * Ceiling on the whole session, enforced by the container runtime.
   *
   * **Must stay below the workspace's container-idle timer**, which is the
   * invariant that has already caused one outage in this repository: two timers
   * of similar length started moments apart, and whichever fired first destroyed
   * the container the other depended on.
   */
  timeoutMs?: number;

  /** Extra environment for the session. Never secrets — see the README. */
  env?: Record<string, string>;
}

/** Eight minutes: comfortably inside `CHUNK_SOFT_MS`, long enough to be useful. */
export const DEFAULT_WINDOW_MS = 8 * 60_000;

/** Fifteen minutes, well under the coder workspace's 20-minute idle timer. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
