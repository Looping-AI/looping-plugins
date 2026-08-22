import {
  credentialPool,
  readRefusal,
  type CredentialStore,
  type Lead
} from "./credentials.js";

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
 * 3. **Exhaustion is seen, so it can be routed around.** This is the only place
 *    Anthropic's actual response is visible, and therefore the only place that
 *    can learn a subscription bucket is empty. See {@link EgressConfig.store}
 *    and `credentials.ts`.
 *
 * ## What this deliberately does not do
 *
 * It does not meter. 0.5.0 had a budget gate that estimated spend in dollars and
 * refused to start work over a cap; 0.6.0 deleted it. An estimate is a guess
 * about a bucket nobody can read, it only moved once per run, and the bucket
 * itself announces the answer exactly — see the docblock in `credentials.ts`.
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

/**
 * The hostname a rule should be matched against, not the one the URL reports.
 *
 * `URL.hostname` is not canonical for this purpose in two ways that both defeat
 * an exact-match set:
 *
 * - **IPv6 keeps its brackets.** `new URL("http://[::1]/").hostname` is
 *   `"[::1]"`, so a set holding `"::1"` never matches.
 * - **A trailing dot survives.** `computer.internal.` and `api.anthropic.com.`
 *   are the same destinations as their undotted forms and compare unequal.
 *
 * The second one cuts both ways and is the more dangerous: an undotted
 * comparison against {@link ANTHROPIC_HOST} would send `api.anthropic.com.` down
 * the *non-Anthropic* branch, which strips the credential — fail-safe, but it
 * also means a spent bucket is never noticed on that spelling.
 */
function canonicalHost(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** Headers that carry a credential, stripped from anything not Anthropic. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "x-api-key",
  "proxy-authorization"
] as const;

/**
 * What a rotated request is told to wait.
 *
 * One second, not zero: the point is to get the client retrying promptly onto
 * the credential that just became the lead, not to remove its backoff. Claude
 * Code honours `retry-after`, so leaving the upstream value in place — four
 * hours, on a spent 5-hour bucket — would stall the session rather than rotate
 * it. This rewrite is what turns the client's own retry into the rotation, and
 * it is why nothing here has to buffer a request body.
 */
const ROTATED_RETRY_AFTER = "1";

/** How much of an unrecognised body to keep in the log. */
const CAPTURE_BYTES = 2048;

export interface EgressConfig {
  /**
   * The credential pool, in priority order — index 0 is tried first.
   *
   * A thunk so a rotated secret is picked up without rebuilding the plugin list.
   * Called per request; it must be cheap. **None of these values enters the
   * container**: the session is launched with `CREDENTIAL_PLACEHOLDER` and the
   * swap happens here.
   *
   * An array of one is entirely valid and behaves as 0.5.0's single credential
   * did — used until its bucket empties, after which requests are refused with
   * the reset time.
   */
  credentials: () => readonly string[];
  /**
   * Where the pool's `{ index → resetAt }` map is persisted.
   *
   * Supplied by the host because the state belongs to the host's storage: it is
   * kept per workspace Durable Object, so each workspace learns a rotation
   * independently. The cost of that is one wasted `429` per workspace per
   * rotation; the saving is a Durable Object class, a binding and a migration.
   */
  store: CredentialStore;
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
  /** Named in log lines so one Worker's several gateways stay tellable apart. */
  label?: string;
  now?: () => number;
}

/** The Anthropic error shape, so the client recognises what it is being told. */
function apiError(
  type: string,
  message: string,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "content-type": "application/json", ...headers }
    }
  );
}

/** Every header on a response, for the capture log. */
function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
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
  const now = config.now ?? Date.now;
  const pool = credentialPool({
    credentials: config.credentials,
    store: config.store,
    ...(config.now ? { now: config.now } : {})
  });

  /**
   * What the client is told when no credential in the pool is usable.
   *
   * Two different answers, because they are two different situations and the
   * client's correct reaction differs. A pool with a `retryAt` **will** recover
   * on its own, so it is an honest `429` carrying the real wait — the client
   * backs off, and if the wait outlives the session the run ends cleanly having
   * said why. A pool with none will not: every entry was rejected as invalid, or
   * none is configured. That needs an operator, and a `429` there would put the
   * client in a retry loop against a wall for the rest of the session.
   */
  const spent = (lead: Extract<Lead, { ok: false }>): Response => {
    if (lead.retryAt === undefined) {
      console.error(
        `[${tag}] no usable credential, and none will recover on its own`
      );
      return apiError(
        "authentication_error",
        "no Anthropic credential in this deployment's pool is usable and none " +
          "will recover on its own — every entry was rejected as invalid, or " +
          "none is configured",
        500
      );
    }

    const waitMs = lead.retryAt - now();
    console.error(`[${tag}] every credential in the pool is rate limited`, {
      retryAt: new Date(lead.retryAt).toISOString()
    });
    return apiError(
      "rate_limit_error",
      "every Anthropic credential in this deployment's pool is rate limited; " +
        `the earliest resets at ${new Date(lead.retryAt).toISOString()}`,
      429,
      // The **real** wait, not the rotation's one second. There is nothing to
      // rotate to, so shortening it here would only spin the client.
      { "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))) }
    );
  };

  const handle = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return apiError("invalid_request_error", "unparseable egress URL", 400);
    }

    const host = canonicalHost(url);

    // Before any policy: this side of the boundary is never a destination.
    if (NEVER_ALLOWED.has(host)) {
      console.warn(`[${tag}] refused a request aimed back at the gateway`, {
        host,
        method: request.method
      });
      return apiError(
        "permission_error",
        `${url.hostname} names the egress gateway itself and is never ` +
          "reachable from inside the workspace",
        403
      );
    }

    if (allowed && !allowed.has(host)) {
      // Logged, because this is the line that makes a failing install
      // intelligible. A container that cannot reach its registry produces a
      // hundred lines of npm output and no mention of egress.
      console.warn(`[${tag}] refused a request outside the host restriction`, {
        host,
        method: request.method
      });
      return apiError(
        "permission_error",
        `${host} is outside this workspace's egress host restriction`,
        403
      );
    }

    const headers = new Headers(request.headers);

    if (host !== ANTHROPIC_HOST) {
      // The placeholder must not leave the boundary either. It is worthless to
      // whoever receives it, but a credential-shaped header sent to a third
      // party is a credential leak in every log it lands in.
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      return await fetch(new Request(url, new Request(request, { headers })));
    }

    /**
     * Anthropic over TLS, and only that, from here down.
     *
     * Checked **before** a credential is read, let alone attached. Nothing stops
     * a process in the container asking for `http://api.anthropic.com/…`, and
     * this function would otherwise fetch it — putting a real subscription token
     * on the wire in plaintext, from the Worker, at the request of code the
     * workspace does not trust. The host matched; the scheme is the rest of the
     * question.
     */
    if (url.protocol !== "https:") {
      console.warn(`[${tag}] refused a plaintext request to Anthropic`, {
        protocol: url.protocol,
        method: request.method
      });
      return apiError(
        "permission_error",
        `${ANTHROPIC_HOST} is reachable over https only; a credential is never ` +
          "attached to a plaintext request",
        403
      );
    }

    const lead = await pool.lead();
    if (!lead.ok) return spent(lead);

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
     *
     * Claude Code also sends an unauthenticated `HEAD /api/hello` preflight.
     * It gets a credential too, harmlessly, and nothing keys on the path: a
     * bucket that is empty is empty for every endpoint.
     */
    headers.set("authorization", `Bearer ${lead.token}`);
    headers.delete("x-api-key");

    const response = await fetch(
      new Request(url, new Request(request, { headers }))
    );

    // The overwhelming majority: a normal answer, streamed straight back with
    // its body untouched. Nothing below this line runs on the hot path.
    if (
      response.status !== 429 &&
      response.status !== 401 &&
      response.status !== 403
    ) {
      return response;
    }

    return await rotate(request, response, lead.id, lead.index);
  };

  /**
   * Read a refusal, move the lead if it earned one, and shape what the client
   * sees so its own retry lands on the new credential.
   */
  const rotate = async (
    request: Request,
    response: Response,
    /** Which credential sent this — see `CredentialPool.spend`. */
    id: string,
    /** Its slot, for the log line only. An operator reads "1", not a hash. */
    index: number
  ): Promise<Response> => {
    const at = now();
    const verdict = readRefusal(response, at);

    /**
     * Capture the whole thing, every time.
     *
     * **No genuine subscription-exhaustion `429` has ever been observed through
     * this path** — the Phase 0 spike's 429s were the raw-API refusal, which is
     * a different response — so the rules in `readRefusal` are inferences from
     * the documented API rate limits. This log is the instrument that replaces
     * them with a fact, and it costs nothing: these statuses are rare, and the
     * body of one is a few hundred bytes.
     */
    const body = await response
      .clone()
      .text()
      .then((text) => text.slice(0, CAPTURE_BYTES))
      .catch(() => "<unreadable>");
    console.warn(`[${tag}] Anthropic refused a request`, {
      status: response.status,
      method: request.method,
      credential: index,
      verdict: verdict?.kind ?? "unrecognised",
      headers: headerMap(response.headers),
      body
    });

    // Unrecognised, or an ordinary slow-down: not this credential's fault, so
    // forward it exactly as it came. Rotating on a speed bump would retire a
    // working credential for whatever window the header happened to name.
    if (!verdict || verdict.kind === "transient") return response;

    const next =
      verdict.kind === "invalid"
        ? await pool.reject(id)
        : await pool.spend(id, verdict.resetAt);

    if (!next.ok) return spent(next);

    console.warn(`[${tag}] rotated to the next credential`, {
      from: index,
      to: next.index,
      reason: verdict.kind
    });

    /**
     * A `429` with a one-second `retry-after`, whatever the upstream status was.
     *
     * The status is rewritten for the `invalid` case and that is deliberate: a
     * client does not retry a `401`, so passing one through would fail the run
     * on a credential we have already stopped using. From the client's point of
     * view "this did not work, try again shortly" is exactly true — the next
     * attempt carries a different credential — and the operator-facing detail is
     * in the log line above, which names the rejection explicitly.
     */
    return apiError(
      "rate_limit_error",
      verdict.kind === "invalid"
        ? "that Anthropic credential was rejected; the gateway has moved to " +
            "the next one in the pool — retry"
        : "that Anthropic credential's limit is reached; the gateway has moved " +
            "to the next one in the pool — retry",
      429,
      { "retry-after": ROTATED_RETRY_AFTER }
    );
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input as RequestInfo, init)),
    connect(): never {
      throw new Error(
        "the claude-code egress gateway is HTTP only; a raw socket cannot be " +
          "credential-swapped or rotated, so it is refused rather than " +
          "silently passed through"
      );
    }
  };
}
