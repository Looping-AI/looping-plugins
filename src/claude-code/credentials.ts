/**
 * `@loopingai/plugins/claude-code` — the credential pool, and how exhaustion is
 * detected.
 *
 * ## Why a pool rather than a budget
 *
 * A Claude subscription has two limits that matter here: a rolling 5-hour
 * session bucket and a weekly one. Neither is readable, and 0.5.0 tried to stay
 * under them by *estimating* spend — a counter in dollars, a cap, and a gate
 * that refused to start work when the counter got high.
 *
 * That was the wrong instrument. The estimate is a guess about a bucket nobody
 * can see, and it only moved when a run *ended* (usage is learned from the
 * terminal `result` event), so it was never a cap on spend at all — only a gate
 * on starting. Meanwhile the bucket itself says so, precisely, the moment it is
 * empty: Anthropic answers `429`.
 *
 * So this module does not predict. It **detects and routes around**: the
 * credential becomes an ordered pool, the gateway uses the first usable entry,
 * and a refusal moves the lead on. One mechanism covers both the 5-hour and the
 * weekly limit, because to this code they differ only in how far out the reset
 * is.
 *
 * ## Everything here is pure
 *
 * No storage, no `fetch`, no Durable Object — the host passes a
 * {@link CredentialStore} and the clock. That is the discipline `JobLifecycle`
 * and `InstallProbe` already set in this repository, and it is what lets the
 * rotation rules be specified without a container: a pool with a fake store is
 * two object literals.
 */

/**
 * One entry's state, as the host persists it.
 *
 * `resetAt` is a wall-clock ms deadline; `0` means usable now. `dead` is a
 * different claim from an exhausted bucket and is kept separate for that reason:
 * a spent credential recovers by itself at `resetAt`, a rejected one never does
 * and needs an operator. Collapsing them would either resurrect a revoked token
 * on a timer or retire a good one permanently.
 */
export interface CredentialState {
  resetAt: number;
  dead?: boolean;
}

/**
 * Where the host keeps the map.
 *
 * Two methods so a spec can pass an object literal, and deliberately *not* a
 * Durable Object: the state is per-workspace by design (see the package README),
 * so the only thing this module needs to know is how to read and write an array.
 */
export interface CredentialStore {
  read(): Promise<CredentialState[]>;
  write(states: CredentialState[]): Promise<void>;
}

/**
 * Which credential to use now, or when to come back.
 *
 * `retryAt` is **absent** rather than infinite when nothing will recover on its
 * own — every entry rejected, or no credentials configured at all. The
 * difference is what a caller tells a human: "try again after 15:04" versus
 * "an operator has to fix this", and a sentinel timestamp would render the
 * second as the first.
 */
export type Lead =
  { ok: true; index: number; token: string } | { ok: false; retryAt?: number };

export interface CredentialPool {
  /** The entry to use for the next request. Reads storage; writes nothing. */
  lead(): Promise<Lead>;
  /**
   * Entry `index`'s bucket is empty until `resetAt`. Returns the new lead, so a
   * caller learns in one round trip whether rotation actually got it anywhere.
   */
  spend(index: number, resetAt: number): Promise<Lead>;
  /** Entry `index` is not a valid credential — revoked or malformed, not spent. */
  reject(index: number): Promise<Lead>;
}

export interface CredentialPoolConfig {
  /**
   * The pool, in priority order. Index 0 is tried first.
   *
   * A thunk for the same reason the single credential was one: a rotated secret
   * is picked up without rebuilding the plugin list. Empty strings are ignored,
   * so a deployment with one token can pass
   * `[env.TOKEN_1, env.TOKEN_2].filter(Boolean)` — or not filter at all — and
   * the pool degrades to today's single-credential behaviour.
   */
  credentials: () => readonly string[];
  store: CredentialStore;
  now?: () => number;
}

/**
 * Line up persisted state with the configured credentials.
 *
 * The two can disagree — an operator adds a third token, or removes the second —
 * and the stored array is keyed by nothing but position. So it is truncated and
 * padded to the current length rather than trusted. The failure this avoids is
 * quiet and bad: a shortened pool would otherwise leave a stale `resetAt`
 * governing whichever credential slid into that index.
 */
function align(
  stored: readonly CredentialState[],
  count: number
): CredentialState[] {
  return Array.from({ length: count }, (_, i) => stored[i] ?? { resetAt: 0 });
}

export function credentialPool(config: CredentialPoolConfig): CredentialPool {
  const now = config.now ?? Date.now;

  const load = async (): Promise<{
    tokens: readonly string[];
    states: CredentialState[];
  }> => {
    const tokens = config.credentials();
    const stored = await config.store.read().catch((err: unknown) => {
      // A store that cannot be read is not a reason to refuse every request:
      // treat it as "nothing known yet", which retries the whole pool from the
      // top. The cost of being wrong is one 429 per entry; the cost of failing
      // closed here is a workspace that can never call a model again.
      console.error("[claude-code] could not read the credential pool", {
        err: String(err)
      });
      return [] as CredentialState[];
    });
    return { tokens, states: align(stored, tokens.length) };
  };

  const pick = (
    tokens: readonly string[],
    states: readonly CredentialState[]
  ): Lead => {
    const at = now();
    let earliest: number | undefined;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const state = states[i];
      if (!token || state?.dead) continue;
      const resetAt = state?.resetAt ?? 0;
      if (resetAt <= at) return { ok: true, index: i, token };
      // Not usable yet, but it will be — a candidate for what to tell a human.
      if (earliest === undefined || resetAt < earliest) earliest = resetAt;
    }

    return earliest === undefined
      ? { ok: false }
      : { ok: false, retryAt: earliest };
  };

  const update = async (
    index: number,
    change: (state: CredentialState) => CredentialState
  ): Promise<Lead> => {
    const { tokens, states } = await load();
    if (index >= 0 && index < states.length) {
      states[index] = change(states[index] ?? { resetAt: 0 });
      await config.store.write(states).catch((err: unknown) => {
        // Losing the write costs one wasted 429 the next time round, which the
        // next refusal corrects. Failing the request over it would turn a
        // recoverable rotation into a failed run.
        console.error("[claude-code] could not persist the credential pool", {
          index,
          err: String(err)
        });
      });
    }
    return pick(tokens, states);
  };

  return {
    async lead(): Promise<Lead> {
      const { tokens, states } = await load();
      return pick(tokens, states);
    },

    spend(index: number, resetAt: number): Promise<Lead> {
      return update(index, (state) => ({
        ...state,
        // `max`, never plain assignment. Two concurrent requests can both be
        // refused and both report a reset, and the staler one must not make a
        // spent credential look usable earlier than it is.
        resetAt: Math.max(state.resetAt, resetAt)
      }));
    },

    reject(index: number): Promise<Lead> {
      return update(index, (state) => ({ ...state, dead: true }));
    }
  };
}

/**
 * What an Anthropic refusal means for the credential that sent it.
 *
 * `transient` is not a rotation: it is the ordinary "slow down" that any client
 * rides out, and treating it as exhaustion would retire a perfectly good
 * credential for however long the header claimed.
 */
export type Refusal =
  | { kind: "exhausted"; resetAt: number }
  | { kind: "invalid" }
  | { kind: "transient"; retryAfterMs: number };

/**
 * Below this, a `429` is a speed bump rather than an empty bucket.
 *
 * The asymmetry is deliberate. Reading a spent bucket as transient costs a
 * client retry loop until the session times out; reading a speed bump as
 * exhaustion costs a credential for the window it named. A floor this low means
 * a misread on the *cheap* side, and the 5-hour and weekly limits are both
 * orders of magnitude above it.
 */
const TRANSIENT_MS = 60_000;

/** Fallback when a `429` names no reset at all. Long enough to mean "later". */
const DEFAULT_RESET_MS = 5 * 60 * 60_000;

/**
 * Parse a `retry-after`: delta-seconds or an HTTP-date, per RFC 9110.
 *
 * Both forms are legal and Anthropic has been observed sending the numeric one;
 * the date form is handled because "we only saw one form" is not the same as
 * "only one form is sent".
 */
function retryAfterMs(value: string | null, at: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : Math.max(0, parsed - at);
}

/**
 * Parse a reset header, which may be unix seconds or an RFC 3339 timestamp.
 *
 * Anthropic documents the `anthropic-ratelimit-*-reset` family as RFC 3339, and
 * the unified variant has been reported as an epoch. Both are accepted rather
 * than guessed at, because this is exactly the field the box in the plan says is
 * unverified — and a parser that handles both cannot be wrong about which.
 */
function resetAtFrom(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // Ten digits is an epoch in seconds; thirteen is already milliseconds.
    return seconds > 1e11 ? seconds : seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Read a response as a verdict on the credential that produced it.
 *
 * Returns `undefined` for anything it does not recognise — which the caller
 * treats as "forward it unchanged, and log the whole thing". That branch is not
 * a fallback, it is the instrument: **no genuine subscription-exhaustion `429`
 * has ever been observed through this path**, so the rules below are inferences
 * from the documented API rate limits, and the first real one is what will
 * settle them.
 */
export function readRefusal(
  response: Response,
  at: number
): Refusal | undefined {
  if (response.status === 401 || response.status === 403)
    return { kind: "invalid" };
  if (response.status !== 429) return undefined;

  const headers = response.headers;
  const delta = retryAfterMs(headers.get("retry-after"), at);
  const reset =
    resetAtFrom(headers.get("anthropic-ratelimit-unified-reset")) ??
    resetAtFrom(headers.get("anthropic-ratelimit-requests-reset"));

  // Prefer whichever is furthest out. A `retry-after` of a few seconds
  // alongside a reset four hours away is one bucket saying "not for a while"
  // and another saying "not this second"; the credential is spent either way.
  const candidates = [
    delta === undefined ? undefined : at + delta,
    reset
  ].filter((v): v is number => v !== undefined);
  const resetAt = candidates.length
    ? Math.max(...candidates)
    : at + DEFAULT_RESET_MS;

  return resetAt - at < TRANSIENT_MS
    ? { kind: "transient", retryAfterMs: resetAt - at }
    : { kind: "exhausted", resetAt };
}
