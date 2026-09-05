import { definePlugin, PLUGIN_CONTRACT_VERSION } from "@dynamicagents/core";
import type { AgentPlugin } from "@dynamicagents/core";
import { claudeCodeEgress } from "./egress.js";
import { credentialPool } from "./credentials.js";
import type { CredentialStore, Lead } from "./credentials.js";
import {
  attachRun,
  drainRun,
  execIdFor,
  freshCursor,
  killRun,
  startRun,
  type DrainCursor,
  type DrainOutcome,
  type SessionRuntime
} from "./run.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WINDOW_MS,
  type ClaudeCodeConfig
} from "./config.js";
import {
  CLAUDE_CODE_SPEC,
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "./recipe.js";

/**
 * `@dynamicagents/plugins/claude-code` — subtasks that run the Claude Code CLI.
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
 * Worker side, which swaps in a real credential and strips credential headers
 * from every other destination.
 *
 * It can **also** restrict which hosts the container may reach, but that is
 * `restrictToHosts` and it is **off unless a deployment sets it** — so do not
 * read it as a boundary that exists by default. The containment that always
 * holds is the credential swap.
 *
 * ## The 5-hour and weekly limits are routed around, not predicted
 *
 * 0.5.0 had a budget gate: an estimate of spend in dollars, and a refusal to
 * start work over a cap. 0.6.0 deletes it. The estimate was a guess about a
 * bucket nobody can read, and it only moved when a run *ended* — so it was never
 * a cap on spend, only a gate on starting.
 *
 * The gateway sees Anthropic's actual response, which is the one place the
 * bucket announces itself. So the credential is a **pool**: the first usable
 * entry is used, a refusal marks it spent until its reset and advances the lead,
 * and the client's own retry — prompted by a rewritten `retry-after` — lands on
 * the next one. When every entry is spent the upstream wait passes through
 * unchanged and the run fails cleanly with the reset time. See
 * {@link file://./credentials.ts}.
 *
 * ## Requires
 *
 * One or more `claude setup-token` credentials, a container image with the CLI
 * installed at a pinned version, and a workspace Durable Object whose egress
 * policy is `{ mode: "http-gateway" }` and which supplies a
 * {@link CredentialStore}. See the README.
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
    // Forwarded only when set, so `buildLaunch` owns the default in one place
    // rather than this line resolving it and the flag being written twice.
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.env ? { env: config.env } : {})
  });

  return {
    /**
     * Spawn a session for one subtask and drain its first window.
     *
     * `subtaskId` namespaces the exec id. Subtasks are a concurrent fan-out, so
     * two sessions in one workspace under one id would spawn over each other —
     * see {@link execIdFor}.
     */
    async start(
      runtime: SessionRuntime,
      subtaskId: string | number,
      prompt: string,
      dir: string
    ): Promise<DrainOutcome> {
      const execId = execIdFor(subtaskId);
      // `using`, so the attachment is released even when the drain throws.
      using handle = await startRun(runtime, {
        ...launch(prompt, dir),
        execId,
        timeoutMs
      });
      return await drainRun(handle, freshCursor(execId), { windowMs });
    },

    /** Re-attach to a running session and drain one more window. */
    async resume(
      runtime: SessionRuntime,
      cursor: DrainCursor
    ): Promise<DrainOutcome> {
      using handle = await attachRun(runtime, cursor);
      return await drainRun(handle, cursor, { windowMs });
    },

    /** Stop a session — `SIGTERM`, so its own process tree goes with it. */
    async stop(
      runtime: SessionRuntime,
      subtaskId: string | number
    ): Promise<void> {
      await killRun(runtime, execIdFor(subtaskId));
    },

    /**
     * Is any credential usable right now, and if not, when?
     *
     * The same question {@link egress} answers per request, asked ahead of time
     * so a host can decline to start a session it cannot pay for. That is not a
     * micro-optimisation: an invocation carries an 18.7-27k-token cached prefix
     * before it does anything, so starting one and letting the gateway refuse
     * its first model call costs a container start and that prefix to learn what
     * this returns for free — and reports it as a failed run rather than as a
     * rate limit with a time on it.
     *
     * Reads only. Nothing here marks anything spent.
     */
    credentials: (store: CredentialStore): Promise<Lead> =>
      credentialPool({ credentials: config.credentials, store }).lead(),

    /**
     * The `Fetcher` the workspace object installs as its egress policy.
     *
     * `store` is an **argument rather than a config field**, and that is the
     * point: the credential pool's state belongs to whichever object has
     * storage, and this same config object is also held by the parent's plugin
     * list and by the subagent facet, neither of which has any. Making it a
     * field would force both of them to invent one.
     */
    egress: (store: CredentialStore) =>
      claudeCodeEgress({
        credentials: config.credentials,
        store,
        // Forwarded only when set. Defaulting it to `[]` here would turn "the
        // host said nothing" into "Anthropic only", which is the one reading
        // the three-way semantics exist to keep distinct.
        ...(config.restrictToHosts === undefined
          ? {}
          : { restrictToHosts: config.restrictToHosts }),
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
  if (config.credentials().filter(Boolean).length === 0) {
    throw new Error(
      "claude-code: no credentials. Set at least one `claude setup-token` " +
        "credential and pass it as " +
        "`credentials: () => [env.CLAUDE_CODE_OAUTH_TOKEN_1]`."
    );
  }

  return definePlugin({
    key: "claude-code",
    contractVersion: PLUGIN_CONTRACT_VERSION,
    subtaskType: CLAUDE_CODE_SPEC,

    /**
     * Hand each subtask the workspace its parent is working in.
     *
     * This runs on the **parent** — core dispatches `resolveRuntime` to the
     * plugin that declared the subtask type, which is this one — so
     * `workspaceName()` resolves here and would throw in the facet, where
     * `callerKey()` is deliberately unavailable. Whatever this returns arrives
     * at `executeChunk` as its `runtime` argument, and the host reads the name
     * back out with {@link WORKSPACE_RUNTIME_KEY}.
     *
     * Without it a delegated session has no way to address the Durable Object
     * holding the checkout it was told to work in — and it cannot be a subtask
     * param instead, because those are rendered to the delegating model and a
     * model-authored workspace name would let it name somebody else's.
     */
    // Annotated rather than inferred: without it TypeScript narrows the
    // plugin's runtime generic to this one key, which then fails to accept a
    // plain `SubtaskRuntime` anywhere else.
    resolveRuntime: async (): Promise<Record<string, unknown>> => ({
      [WORKSPACE_RUNTIME_KEY]: config.workspaceName()
    })

    // **No `requires.secrets`, and it is not an omission.** It named
    // `CLAUDE_CODE_OAUTH_TOKEN` while there was exactly one credential with a
    // name this package could know. The pool's entries are host-named — a
    // deployment may call them anything and may have three — so there is no
    // name left to declare. The property `requires` bought is kept by the
    // `credentials()` check above, which is strictly better: it fails at DO
    // start on the *value* being absent rather than on a name being unset.
  });
}

export { ANTHROPIC_HOST, claudeCodeEgress } from "./egress.js";
export type { EgressConfig } from "./egress.js";
export { credentialPool, readRefusal } from "./credentials.js";
export type {
  CredentialPool,
  CredentialPoolConfig,
  CredentialState,
  CredentialStore,
  Lead,
  Refusal
} from "./credentials.js";
export {
  buildLaunch,
  CLAUDE_EXEC_PREFIX,
  CREDENTIAL_PLACEHOLDER,
  execIdFor,
  freshCursor
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
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "./recipe.js";
export {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WINDOW_MS
} from "./config.js";
export type { ClaudeCodeConfig, PermissionMode } from "./config.js";
