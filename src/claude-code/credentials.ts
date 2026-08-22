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
  /**
   * Which credential this state describes — see {@link fingerprint}.
   *
   * **It binds the state to a credential rather than to a slot**, and that is
   * the whole reason it exists. State keyed by array position looks fine until
   * an operator edits the secrets, and then it is quietly wrong at the worst
   * possible moment: rotating a spent token — the exact thing an operator does
   * when the pool has stalled — would leave the fresh credential inheriting the
   * old one's `resetAt`, or its `dead` flag, which nothing clears. Removing the
   * first secret so the second slides down has the same effect, and the
   * documented `.filter(Boolean)` pattern makes that a one-character change.
   *
   * Keying on the credential fixes reordering for free, and makes a replaced
   * credential simply *unknown* — which is the fail-open direction, and the
   * right one: an unknown credential gets tried.
   */
  id: string;
  resetAt: number;
  dead?: boolean;
}

/**
 * A stable, non-secret identifier for a credential.
 *
 * The first eight bytes of its SHA-256, hex-encoded. **Not the token, and not a
 * slice of it** — this is written to durable storage, so anything derived by
 * truncating the credential itself would put credential material there, which is
 * the one thing this whole package exists to avoid.
 *
 * Truncated because the job is telling two or three credentials apart, not
 * resisting a preimage attack.
 */
export async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  | { ok: true; index: number; id: string; token: string }
  | { ok: false; retryAt?: number };

export interface CredentialPool {
  /** The entry to use for the next request. Reads storage; writes nothing. */
  lead(): Promise<Lead>;
  /**
   * This credential's bucket is empty until `resetAt`. Returns the new lead, so
   * a caller learns in one round trip whether rotation got it anywhere.
   *
   * Keyed on {@link Lead.id}, never on the index the caller was handed. A
   * refusal arrives after an `await`, and the pool can have been reconfigured in
   * between — an index would then mark whichever credential had moved into that
   * slot, which is the same class of mistake `id` exists to prevent. An id no
   * longer in the pool is a no-op, which is exactly right.
   */
  spend(id: string, resetAt: number): Promise<Lead>;
  /** This credential is not valid — revoked, not spent. See {@link spend}. */
  reject(id: string): Promise<Lead>;
}

export interface CredentialPoolConfig {
  /**
   * The pool, in priority order. Index 0 is tried first.
   *
   * A thunk for the same reason the single credential was one: a rotated secret
   * is picked up without rebuilding the plugin list — and rotating one **does**
   * work, because state is keyed on the credential rather than the slot (see
   * {@link CredentialState.id}).
   *
   * Empty strings are skipped rather than sent as a bare `Bearer `, which is
   * defence against a secret that is declared and unset. It is not a substitute
   * for declaring the right ones: a host that lists a secret it does not have
   * gets a definite-string type for an undefined value, and a warning on every
   * local run. An array of one is a complete deployment — it simply gives up
   * when its bucket empties instead of rotating.
   */
  credentials: () => readonly string[];
  store: CredentialStore;
  now?: () => number;
}

/**
 * Fold two views of one credential's state together.
 *
 * Safe to apply in any order and any number of times, because both fields are
 * **monotonic**: `resetAt` only moves later (a bucket does not un-empty early)
 * and `dead` only turns on. That is what lets storage and the in-memory mirror
 * below be merged rather than one of them being chosen — there is no ordering in
 * which the merge loses information.
 */
function merge(a: CredentialState, b: CredentialState): CredentialState {
  const dead = a.dead === true || b.dead === true;
  return {
    id: a.id,
    resetAt: Math.max(a.resetAt, b.resetAt),
    ...(dead ? { dead: true } : {})
  };
}

export function credentialPool(config: CredentialPoolConfig): CredentialPool {
  const now = config.now ?? Date.now;

  /** Fingerprints are stable per token; hashing every request would be waste. */
  const ids = new Map<string, string>();
  const idFor = async (token: string): Promise<string> => {
    const known = ids.get(token);
    if (known !== undefined) return known;
    const id = await fingerprint(token);
    ids.set(token, id);
    return id;
  };

  /**
   * The last state this isolate knows of, held in memory.
   *
   * Not a cache — storage is still read every time and wins where it is ahead.
   * This is what makes a **storage failure survivable** rather than a hot loop,
   * and both directions matter:
   *
   * - A failed *read* would otherwise report every credential fresh, so the lead
   *   snaps back to entry 0 on every request. The gateway rotates, tells the
   *   client to retry in a second, and the retry lands on entry 0 again — a
   *   one-second loop against a bucket already known to be empty, for as long as
   *   the outage lasts.
   * - A failed *write* would otherwise let the gateway advertise a rotation that
   *   the next request cannot see, which is the same loop reached the other way.
   *
   * Merging rather than preferring either side is what makes this correct
   * without tracking which of the two is stale; see {@link merge}.
   */
  let mirror: CredentialState[] = [];

  const load = async (): Promise<{
    tokens: readonly string[];
    keys: string[];
    states: CredentialState[];
  }> => {
    const tokens = config.credentials();
    const keys = await Promise.all(
      tokens.map((token) => (token ? idFor(token) : Promise.resolve("")))
    );

    const stored = await config.store.read().catch((err: unknown) => {
      console.error("[claude-code] could not read the credential pool", {
        err: String(err)
      });
      return [] as CredentialState[];
    });

    // Keyed by credential, never by slot. State for a credential that is no
    // longer configured is simply never looked up, and a credential with no
    // state is unknown — which is the fail-open direction, and the right one: an
    // unknown credential gets tried.
    const known = new Map<string, CredentialState>();
    for (const state of [...stored, ...mirror]) {
      if (!state?.id) continue;
      const previous = known.get(state.id);
      known.set(state.id, previous ? merge(previous, state) : state);
    }

    const states = keys.map((id) => known.get(id) ?? { id, resetAt: 0 });
    mirror = states;
    return { tokens, keys, states };
  };

  const pick = (
    tokens: readonly string[],
    keys: readonly string[],
    states: readonly CredentialState[]
  ): Lead => {
    const at = now();
    let earliest: number | undefined;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const state = states[i];
      if (!token || state?.dead) continue;
      const resetAt = state?.resetAt ?? 0;
      if (resetAt <= at) {
        return { ok: true, index: i, id: keys[i] ?? "", token };
      }
      // Not usable yet, but it will be — a candidate for what to tell a human.
      if (earliest === undefined || resetAt < earliest) earliest = resetAt;
    }

    return earliest === undefined
      ? { ok: false }
      : { ok: false, retryAt: earliest };
  };

  const update = async (
    id: string,
    change: (state: CredentialState) => CredentialState
  ): Promise<Lead> => {
    const { tokens, keys, states } = await load();
    const index = keys.indexOf(id);

    // An id that is no longer configured: the operator replaced that credential
    // between the request going out and its refusal coming back. There is
    // nothing to mark, and marking the slot instead is the bug `id` exists to
    // prevent — so this returns the current lead and moves on.
    if (id && index >= 0) {
      states[index] = change(states[index] ?? { id, resetAt: 0 });
      // The mirror is updated **before** the write is attempted, so a write that
      // fails still changes what this isolate does next.
      mirror = states;
      await config.store.write(states).catch((err: unknown) => {
        console.error("[claude-code] could not persist the credential pool", {
          id,
          err: String(err)
        });
      });
    }
    return pick(tokens, keys, states);
  };

  return {
    async lead(): Promise<Lead> {
      const { tokens, keys, states } = await load();
      return pick(tokens, keys, states);
    },

    spend(id: string, resetAt: number): Promise<Lead> {
      return update(id, (state) => ({
        ...state,
        // `max`, never plain assignment. Two concurrent requests can both be
        // refused and both report a reset, and the staler one must not make a
        // spent credential look usable earlier than it is.
        resetAt: Math.max(state.resetAt, resetAt)
      }));
    },

    reject(id: string): Promise<Lead> {
      return update(id, (state) => ({ ...state, dead: true }));
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
 * The only status that retires a credential.
 *
 * **401 alone, and deliberately not 403.** Anthropic returns `401
 * authentication_error` for a credential it does not accept, and `403
 * permission_error` for a credential that is fine but may not have the thing
 * being asked for. Reading the second as "this credential is bad" turns a
 * *configuration* mistake — a model the subscription cannot reach, say — into a
 * permanent, pool-wide outage: every credential 403s in turn, every one is
 * retired, and `dead` is the one state nothing clears on its own. An operator
 * would have to delete Durable Object storage to recover from a typo.
 *
 * A 403 is therefore left unclassified: forwarded to the client untouched, and
 * logged whole by the gateway. That is the same treatment every other
 * unrecognised refusal gets, and for the same reason — see {@link readRefusal}.
 */
const INVALID_STATUS = 401;

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
  if (response.status === INVALID_STATUS) return { kind: "invalid" };
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
