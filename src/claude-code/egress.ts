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
 * 2. **Any restriction that is applied is total.** Not a policy the container
 *    cooperates with; the only route out. Restriction is **off by default** —
 *    see {@link EgressConfig.restrictToHosts} for why.
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
 *
 * And it does not, by default, **bound exfiltration**. The container holds the
 * checkout, and with no restriction configured it can send it anywhere. That is
 * a deliberate default rather than an oversight — the reasoning is on
 * {@link EgressConfig.restrictToHosts} — and what it means for a reader is that
 * the containment here is "the container holds no credential", full stop. Do not
 * read a host restriction that is switched off as a boundary that exists.
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

/**
 * Hosts that name **this** side of the boundary, refused whatever the policy.
 *
 * The reason is a difference between the two egress modes that is easy to miss.
 * Under `mode: "direct"` the container's traffic leaves from the container's own
 * network position. Under `http-gateway` **the Worker makes the request**, so an
 * unrestricted policy hands the container the Worker's reach rather than its
 * own — and `computer.internal` is the loopback the intercept itself rides on.
 * Bouncing a request back into it is never a legitimate fetch, so it is refused
 * before any policy is consulted.
 *
 * A workspace that overrides `egressHost` on its `CloudflareContainerBackend`
 * should add that name here; the default is what the backend uses when nothing
 * says otherwise.
 */
const NEVER_ALLOWED = new Set([
  "computer.internal",
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0"
]);

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
   * Failing here is treated as a refusal, not as permission, which is the
   * opposite of core's `shouldHandleTurn` gate and deliberately so: a gate that
   * fails open there costs a wrong reply, one that failed open here would cost
   * an unbounded spend against somebody's subscription.
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
   * Restrict the container to these hosts, plus `api.anthropic.com`.
   *
   * **Three-way, and each value means literally what it says:**
   *
   * | Value | Effect |
   * |---|---|
   * | omitted | unrestricted — the default |
   * | `["registry.npmjs.org"]` | that host, plus Anthropic |
   * | `[]` | Anthropic only |
   *
   * An empty array is *not* the same as omitting the field, deliberately. A host
   * computing this list — `repos.flatMap(hostsFor)`, say — that happens to
   * produce `[]` means "nothing extra", and collapsing that into "everything"
   * would hand the widest possible policy to an expression that returned
   * nothing.
   *
   * ## Why unrestricted is the default
   *
   * A curated list is permanently wrong for a coding agent. `esbuild`, `swc` and
   * `sharp` fetch prebuilt binaries from release CDNs; Playwright downloads
   * browsers from a third host; corepack fetches package managers; and reading
   * documentation is part of the job. The failure mode is the bad one — `npm ci`
   * dying inside a `postinstall` with a network error nobody connects to a list
   * three files away.
   *
   * Little is lost by defaulting open, because **the restriction was never what
   * protected the credential**. The swap is keyed on the destination being
   * Anthropic and credential headers are stripped from everything else, so both
   * hold whatever this says. What an unrestricted policy does give up is a bound
   * on *exfiltration*: the container holds the checkout and can send it
   * anywhere. That matches `/computer`, whose egress has always been
   * unrestricted, for the same reason.
   *
   * Matched **exactly** on hostname when set. No wildcards, and that is not an
   * omission: `*.example.com` is how a restriction quietly becomes no
   * restriction, the first time a host serves user-controlled subdomains.
   */
  restrictToHosts?: readonly string[];
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
  // Resolved once. `undefined` is unrestricted; a list — including an empty one
  // — is a restriction that always admits Anthropic.
  const allowed =
    config.restrictToHosts === undefined
      ? undefined
      : new Set([ANTHROPIC_HOST, ...config.restrictToHosts]);
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

    // Before any policy: this side of the boundary is never a destination.
    if (NEVER_ALLOWED.has(url.hostname)) {
      console.warn(`[${tag}] refused a request aimed back at the gateway`, {
        host: url.hostname,
        method: request.method
      });
      return apiError(
        "permission_error",
        `${url.hostname} names the egress gateway itself and is never ` +
          "reachable from inside the workspace",
        403
      );
    }

    if (allowed && !allowed.has(url.hostname)) {
      // Logged, because this is the line that makes a failing install
      // intelligible. A container that cannot reach its registry produces a
      // hundred lines of npm output and no mention of egress.
      console.warn(`[${tag}] refused a request outside the host restriction`, {
        host: url.hostname,
        method: request.method
      });
      return apiError(
        "permission_error",
        `${url.hostname} is outside this workspace's egress host restriction`,
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
