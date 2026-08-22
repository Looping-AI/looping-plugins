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
   * The credential pool, in priority order — index 0 is tried first.
   *
   * A thunk so a rotated secret is picked up without rebuilding the plugin list.
   * **These values never enter the container** — one is read on the Worker side
   * by the egress gateway and swapped into the outbound request. The container
   * gets {@link file://./run.ts CREDENTIAL_PLACEHOLDER}.
   *
   * `claude setup-token` OAuth credentials. There is deliberately no API-key
   * path: the subscription credential is the one that reaches frontier models
   * through this client, and a second path would be a second thing to get wrong.
   *
   * **Why a pool.** A subscription has a rolling 5-hour bucket and a weekly one,
   * neither readable. Rather than estimate spend against them, the gateway uses
   * the first usable entry and moves on when Anthropic says that one is done —
   * see {@link file://./credentials.ts}. An array of one is valid and behaves
   * exactly as a single credential did: used until its bucket empties, then
   * refused with the reset time.
   */
  credentials: () => readonly string[];

  /**
   * Which workspace this agent's sessions run in.
   *
   * Resolved on the **parent**, where the verified caller is known: core
   * dispatches `resolveRuntime` to the plugin that declared the subtask type,
   * which is this one, and the value it writes is how the subagent facet learns
   * which Durable Object holds its checkout. A facet cannot work this out for
   * itself — `callerKey()` throws there by design — and it is deliberately not a
   * subtask param, because a model-authored workspace name would let a model
   * name somebody else's.
   */
  workspaceName: () => string;

  /** Which model the session runs. Unset, Claude Code picks its own default. */
  model?: string;

  /**
   * Ceiling on the *outer* session's turns.
   *
   * Advisory. Claude Code's own subagent tree multiplies whatever this says, and
   * the tree is invisible to Looping's scheduler. {@link timeoutMs} is the
   * ceiling that actually holds, because the container runtime enforces it.
   */
  maxTurns?: number;

  /** Caps on Claude Code's own subagent tree. Advisory, like `maxTurns`. */
  maxSubagentDepth?: number;
  maxConcurrentSubagents?: number;

  /**
   * Restrict the container's egress to these hosts, plus `api.anthropic.com`.
   *
   * **Omit it and egress is unrestricted, which is the default.** An empty array
   * is not the same thing — it means Anthropic only. See
   * {@link file://./egress.ts EgressConfig.restrictToHosts} for the full table
   * and for why open is the default.
   *
   * Whatever this says, the container never needs forge access: `/repo` runs
   * clone, fetch and push as isomorphic-git inside the workspace object, so the
   * forge token stays on the Worker side.
   */
  restrictToHosts?: readonly string[];

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
