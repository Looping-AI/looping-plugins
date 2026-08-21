/**
 * `@loopingai/plugins/claude-code` — the container's only way out.
 *
 * `egress: { mode: "http-gateway", gateway }` makes `computerd` intercept every
 * outbound request in the container and tunnel it back to the workspace Durable
 * Object, which reconstructs it against its original absolute URL and hands it
 * here. So this function sits on the **Worker side of the trust boundary** and
 * sees the whole of what the container tries to reach.
 *
 * That position is what makes three otherwise-hard things easy, and they are the
 * reason this file exists rather than a plain allowlist:
 *
 * 1. **The real credential never enters the container.** Claude Code is launched
 *    with a placeholder; the swap happens here. A `postinstall` script in a
 *    cloned repository can read every environment variable the container has and
 *    still learn nothing — which is the repository's standing rule ("hand it the
 *    action, not the credential") applied to a process nobody can constrain.
 * 2. **The allowlist is fail-closed and total.** Not a policy the container
 *    cooperates with; the only route out.
 * 3. **A budget can be refused.** `--max-turns` and the subagent caps are
 *    advisory and Claude Code's inner agent tree multiplies both. A gate here is
 *    a ceiling, because a model call that does not cross this function does not
 *    happen.
 *
 * ## What this deliberately does not do
 *
 * It does not meter. The `result` event carries `usage` and a per-model cost
 * breakdown and is parsed anyway (see `events.ts`); making this parse SSE
 * `message_delta` frames to keep a running total would buy precision the gate
 * does not need — it only has to answer "is there budget left", and the answer
 * moves once per run. This reads the counter; the drain writes it.
 */

/** Anthropic's API host — the one destination that gets a credential. */
export const ANTHROPIC_HOST = "api.anthropic.com";

/**
 * The path prefix that costs money.
 *
 * Claude Code also sends an unauthenticated `HEAD /api/hello` preflight, which
 * must pass through: gating it would make a run fail at startup with a rate
 * limit it never earned, before any model call was attempted.
 */
const MESSAGES_PATH = "/v1/messages";

/** Headers that carry a credential, stripped from anything not Anthropic. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "proxy-authorization"
] as const;

export interface EgressBudget {
  /**
   * Whether a model call may proceed. Consulted **before** forwarding, so a
   * refusal costs nothing upstream.
   *
   * Failing here is treated as a refusal, not as permission — see the note on
   * `#refuse` below. That is the opposite of the `shouldHandleTurn` gate in
   * core, and deliberately so: a gate that fails open costs a wrong reply, this
   * one would cost an unbounded spend against somebody's subscription.
   */
  check: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface EgressConfig {
  /**
   * The real credential, as a thunk.
   *
   * A thunk rather than a string so a rotated secret is picked up without
   * rebuilding the plugin list — the same reason `ClaudeCodeConfig.credential`
   * is one. Called per request; it must be cheap.
   */
  credential: () => string;
  /**
   * Hosts the container may reach, matched **exactly** on hostname.
   *
   * No wildcards, and that is not an omission. `*.example.com` is how an
   * allowlist quietly becomes an anylist — one CDN or object-storage domain with
   * user-controlled subdomains and the boundary is gone. List the hosts.
   *
   * `api.anthropic.com` is always allowed and need not appear here.
   */
  allowHosts: readonly string[];
  budget?: EgressBudget;
  /** Named in log lines so one Worker's several gateways stay tellable apart. */
  label?: string;
}

/** The Anthropic error shape, so the client recognises what it is being told. */
function apiError(type: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "content-type": "application/json" }
    }
  );
}

/**
 * Build the `Fetcher` a `WorkspaceEgressPolicy` takes.
 *
 * A real object rather than a cast: `Fetcher` requires `connect` as well as
 * `fetch`, and container egress is HTTP only, so `connect` throws a sentence
 * naming why instead of being absent. If a future `computerd` ever opens a raw
 * socket through this policy, the failure says so rather than arriving as
 * `undefined is not a function` several frames away.
 */
export function claudeCodeEgress(config: EgressConfig): Fetcher {
  const allowed = new Set([ANTHROPIC_HOST, ...config.allowHosts]);
  const tag = config.label
    ? `claude-code-egress:${config.label}`
    : "claude-code-egress";

  const handle = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return apiError("invalid_request_error", "unparseable egress URL", 400);
    }

    if (!allowed.has(url.hostname)) {
      // Logged, because this is the line that makes a failing install
      // intelligible. A container that cannot reach its registry produces a
      // hundred lines of npm output and no mention of egress.
      console.warn(
        `[${tag}] refused a request to a host not on the allowlist`,
        {
          host: url.hostname,
          method: request.method
        }
      );
      return apiError(
        "permission_error",
        `${url.hostname} is not on this workspace's egress allowlist`,
        403
      );
    }

    const headers = new Headers(request.headers);

    if (url.hostname !== ANTHROPIC_HOST) {
      // The placeholder must not leave the boundary either. It is worthless to
      // whoever receives it, but a credential-shaped header sent to a third
      // party is a credential leak in every log it lands in.
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      return await fetch(new Request(url, new Request(request, { headers })));
    }

    // Anthropic, and only Anthropic, from here down.
    if (config.budget && url.pathname.startsWith(MESSAGES_PATH)) {
      const verdict = await config.budget
        .check()
        .catch((err: unknown) => ({ ok: false as const, reason: String(err) }));

      if (!verdict.ok) {
        console.warn(`[${tag}] refused a model call over budget`, {
          reason: verdict.reason
        });
        /**
         * 429, and **no `retry-after`**.
         *
         * The status is honest — this is a rate limit — and Claude Code renders
         * it as a `system/api_retry` event with `error: "rate_limit"`, which the
         * drain surfaces as progress, so the run that ends shortly afterwards is
         * explained rather than mysterious.
         *
         * The missing header is the deliberate part. A `retry-after` we invent
         * would make the client sleep *inside the container*, on the Looping
         * chunk's clock — the one budget this gateway cannot see. Without it the
         * client's own short backoff runs out quickly and the run fails cleanly,
         * which is what an exhausted budget should look like.
         */
        return apiError("rate_limit_error", verdict.reason, 429);
      }
    }

    const credential = config.credential();
    if (!credential) {
      // Fail rather than forward the placeholder. Upstream would refuse it
      // anyway, and it would refuse it as an authentication error — sending an
      // operator to rotate a credential when the real fault is a missing secret.
      console.error(`[${tag}] no credential configured; refusing to forward`);
      return apiError(
        "authentication_error",
        "the egress gateway has no Anthropic credential configured",
        500
      );
    }

    /**
     * The swap, and it is the whole point of the file.
     *
     * `authorization` is set and `x-api-key` removed because that is the shape
     * the sanctioned client sends — the Phase 0 capture showed `authorization:
     * Bearer …` with no `x-api-key` at all. Everything else is forwarded
     * untouched: the `anthropic-beta` list (which carries
     * `claude-code-20250219` and `oauth-2025-04-20`, almost certainly part of
     * what marks the request as coming from the client) and the `user-agent`
     * are not ours to normalise or reorder.
     */
    headers.set("authorization", `Bearer ${credential}`);
    headers.delete("x-api-key");

    return await fetch(new Request(url, new Request(request, { headers })));
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input as RequestInfo, init)),
    connect(): never {
      throw new Error(
        "the claude-code egress gateway is HTTP only; a raw socket cannot be " +
          "credential-swapped or budget-gated, so it is refused rather than " +
          "silently passed through"
      );
    }
  };
}
