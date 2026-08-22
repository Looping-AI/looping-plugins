import { describe, expect, it } from "vitest";
import {
  credentialPool,
  fingerprint,
  readRefusal,
  type CredentialState,
  type CredentialStore
} from "./credentials.js";

/**
 * The pool exists because a subscription's buckets are not readable, and the
 * only honest signal is Anthropic refusing a request. So the tests here are
 * about *not overreacting to a refusal* as much as about acting on one: the
 * expensive mistakes are symmetrical, and both are one line of carelessness.
 */

const A = "token-a";
const B = "token-b";
const C = "token-c";

function memoryStore(initial: CredentialState[] = []): CredentialStore & {
  states: () => CredentialState[];
} {
  let states = initial;
  return {
    read: async () => states,
    write: async (next) => {
      states = next;
    },
    states: () => states
  };
}

/** A pool on a clock the test owns, so nothing here waits on real time. */
function pool(tokens: readonly string[], at = 1_000_000) {
  const store = memoryStore();
  let clock = at;
  return {
    store,
    advance: (ms: number) => (clock += ms),
    pool: credentialPool({
      credentials: () => tokens,
      store,
      now: () => clock
    })
  };
}

/** The id a token will be stored under. */
const idOf = (token: string) => fingerprint(token);

/** Resolve a lead to the id it names, so mutations can be keyed on it. */
async function leadId(p: { lead(): Promise<unknown> }): Promise<string> {
  const lead = (await p.lead()) as { ok: boolean; id?: string };
  if (!lead.ok || !lead.id) throw new Error("expected a usable lead");
  return lead.id;
}

describe("picking a lead", () => {
  it("uses the first entry, because order is priority", async () => {
    const { pool: p } = pool([A, B]);
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: A });
  });

  it("skips an empty slot rather than handing back an empty token", async () => {
    // `[env.TOKEN_1, env.TOKEN_2]` with the second secret unset is the ordinary
    // one-credential deployment, and it must not forward an empty `Bearer `.
    const { pool: p } = pool(["", B]);
    expect(await p.lead()).toMatchObject({ ok: true, index: 1, token: B });
  });

  it("reports nothing recoverable when the pool is empty", async () => {
    const { pool: p } = pool([]);
    // No `retryAt`: nothing will fix this on a timer, and a caller must be able
    // to tell that apart from "come back at 15:04".
    expect(await p.lead()).toEqual({ ok: false });
  });
});

describe("spending an entry", () => {
  it("advances the lead and says where it landed", async () => {
    const { pool: p } = pool([A, B]);
    const next = await p.spend(await idOf(A), 1_000_000 + 60 * 60_000);
    expect(next).toMatchObject({ ok: true, index: 1, token: B });
  });

  it("brings a spent entry back by itself once its reset passes", async () => {
    const { pool: p, advance } = pool([A]);
    await p.spend(await idOf(A), 1_000_000 + 120_000);

    expect(await p.lead()).toEqual({ ok: false, retryAt: 1_120_000 });
    advance(121_000);
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: A });
  });

  /**
   * Two concurrent requests can both be refused and both report a reset, and
   * the staler one must not make a spent credential look usable earlier than it
   * is. `max`, never assignment.
   */
  it("never shortens a reset that is already further out", async () => {
    const { pool: p, store } = pool([A]);
    await p.spend(await idOf(A), 1_000_000 + 4 * 60 * 60_000);
    await p.spend(await idOf(A), 1_000_000 + 60_000);

    expect(store.states()[0]!.resetAt).toBe(1_000_000 + 4 * 60 * 60_000);
  });

  /**
   * The message a human acts on. With several entries spent at different times
   * the useful number is the first one back, not the last one written.
   */
  it("reports the earliest reset when everything is spent", async () => {
    const { pool: p } = pool([A, B, C]);
    await p.spend(await idOf(A), 5_000_000);
    await p.spend(await idOf(B), 2_000_000);
    const last = await p.spend(await idOf(C), 9_000_000);

    expect(last).toEqual({ ok: false, retryAt: 2_000_000 });
  });
});

describe("rejecting an entry", () => {
  it("takes it out for good, not until a reset", async () => {
    const { pool: p, advance } = pool([A, B]);
    await p.reject(await idOf(A));
    advance(365 * 24 * 60 * 60_000);

    // A revoked credential does not heal on a timer. Collapsing `dead` into a
    // very distant `resetAt` would resurrect it eventually — quietly, and long
    // after anyone remembers why it was retired.
    expect(await p.lead()).toMatchObject({ ok: true, index: 1, token: B });
  });

  it("reports an all-rejected pool as unrecoverable, not as a wait", async () => {
    const { pool: p } = pool([A, B]);
    await p.reject(await idOf(A));
    expect(await p.reject(await idOf(B))).toEqual({ ok: false });
  });
});

/**
 * State follows the **credential**, not the slot.
 *
 * Position-keyed state looks fine until an operator edits the secrets, and it is
 * then wrong at the worst possible moment: rotating a spent token is exactly
 * what an operator does when the pool has stalled, and the fresh credential
 * would inherit the old one's `resetAt` — or its `dead` flag, which nothing
 * clears. The tests below are that failure, from three directions.
 */
describe("state that no longer matches the credentials", () => {
  /** The one that matters most: recovery by rotating a secret must work. */
  it("does not hand a replaced credential its predecessor's state", async () => {
    const store = memoryStore();
    let token = A;
    const p = credentialPool({
      credentials: () => [token],
      store,
      now: () => 1_000_000
    });

    await p.reject(await idOf(A));
    expect(await p.lead()).toEqual({ ok: false });

    // The operator mints a fresh credential into the same secret. It must be
    // tried — under position keys it would inherit `dead: true` and the pool
    // would stay unusable with no way to clear it short of wiping storage.
    token = B;
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: B });
  });

  /**
   * The `.filter(Boolean)` case, which the README documents and which makes
   * this a one-character mistake: drop the first secret and the second slides
   * into index 0, inheriting a `resetAt` that was never about it.
   */
  it("keeps a credential's state with it when the pool shifts", async () => {
    const store = memoryStore();
    let tokens: string[] = [A, B];
    const p = credentialPool({
      credentials: () => tokens,
      store,
      now: () => 1_000_000
    });

    await p.spend(await idOf(A), 9_999_999_999);
    tokens = [B];

    // B is untouched, so it leads — and it must not have picked up A's reset.
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: B });
  });

  it("ignores state for a credential that is no longer configured", async () => {
    const store = memoryStore([
      { id: await idOf(C), resetAt: 9_999_999_999, dead: true }
    ]);
    const p = credentialPool({
      credentials: () => [A],
      store,
      now: () => 1_000_000
    });
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: A });
  });

  it("treats a newly added credential as usable", async () => {
    const store = memoryStore([{ id: await idOf(A), resetAt: 9_999_999_999 }]);
    const p = credentialPool({
      credentials: () => [A, B],
      store,
      now: () => 1_000_000
    });
    expect(await p.lead()).toMatchObject({ ok: true, index: 1, token: B });
  });

  /**
   * A refusal arrives after an `await`, so the pool can be reconfigured between
   * the request going out and the answer coming back. Marking the *slot* would
   * then spend whichever credential had moved into it.
   */
  it("is a no-op when the refused credential is gone", async () => {
    const store = memoryStore();
    let tokens: string[] = [A];
    const p = credentialPool({
      credentials: () => tokens,
      store,
      now: () => 1_000_000
    });
    const stale = await idOf(C);

    tokens = [A];
    expect(await p.spend(stale, 9_999_999_999)).toMatchObject({
      ok: true,
      token: A
    });
  });
});

/**
 * A storage outage must not become a hot retry loop.
 *
 * This is the failure mode both halves below share, and it is worse than losing
 * the state: the gateway rotates, tells the client to retry in a second, and the
 * retry lands on the same spent credential — a one-second loop against a bucket
 * already known to be empty, for as long as the outage lasts.
 *
 * The fix is a process-local mirror, merged with storage rather than chosen
 * over it. Both fields are monotonic, so the merge cannot lose information in
 * either direction.
 */
describe("when storage is unavailable", () => {
  const brokenRead = (): CredentialStore => ({
    read: async () => {
      throw new Error("storage unavailable");
    },
    write: async () => {}
  });

  // Reads fine, never persists — so storage stays permanently empty and only the
  // mirror carries what the gateway has already promised the client.
  const brokenWrite = (): CredentialStore => ({
    read: async () => [],
    write: async () => {
      throw new Error("storage unavailable");
    }
  });

  /**
   * Failing open on the *first* read is deliberate: the cost of being wrong is
   * one 429 per entry, and the cost of failing closed is a workspace that can
   * never call a model again.
   */
  it("still hands out a lead on a read failure", async () => {
    const p = credentialPool({
      credentials: () => [A],
      store: brokenRead(),
      now: () => 1_000_000
    });
    expect(await p.lead()).toMatchObject({ ok: true, index: 0, token: A });
  });

  it("remembers a rotation across a read failure", async () => {
    const p = credentialPool({
      credentials: () => [A, B],
      store: brokenRead(),
      now: () => 1_000_000
    });

    await p.spend(await leadId(p), 9_999_999_999);

    // Without the mirror this snaps back to A on every request, and the client
    // retries into it once a second until the session times out.
    expect(await p.lead()).toMatchObject({ ok: true, index: 1, token: B });
  });

  it("remembers a rotation the write could not persist", async () => {
    const p = credentialPool({
      credentials: () => [A, B],
      store: brokenWrite(),
      now: () => 1_000_000
    });

    const next = await p.spend(await leadId(p), 9_999_999_999);

    // The gateway has already told the client "retry, I have moved on". That
    // promise has to survive the next request, or it was a lie.
    expect(next).toMatchObject({ ok: true, token: B });
    expect(await p.lead()).toMatchObject({ ok: true, index: 1, token: B });
  });
});

/**
 * **No genuine subscription-exhaustion 429 has ever been observed through this
 * path** — the Phase 0 spike's 429s were the raw-API refusal, a different
 * response. So these rules are inferences from the documented API rate limits,
 * and the gateway logs every refusal whole so the first real one can replace
 * them with a fact. What the tests below pin is the *shape* of the judgement,
 * which is what should survive learning the exact header.
 */
describe("reading a refusal", () => {
  const NOW = 1_000_000;

  it("reads a distant retry-after as a spent bucket", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "retry-after": "14400" }
    });
    expect(readRefusal(response, NOW)).toEqual({
      kind: "exhausted",
      resetAt: NOW + 14_400_000
    });
  });

  /**
   * The asymmetry that sets the floor. Reading a speed bump as exhaustion
   * retires a working credential for the window it named; reading a spent
   * bucket as a speed bump costs a retry loop until the session times out. A
   * low floor means a misread lands on the cheap side.
   */
  it("reads a short retry-after as an ordinary slow-down", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "retry-after": "5" }
    });
    expect(readRefusal(response, NOW)).toEqual({
      kind: "transient",
      retryAfterMs: 5_000
    });
  });

  it("accepts a reset header as epoch seconds", () => {
    const response = new Response(null, {
      status: 429,
      headers: { "anthropic-ratelimit-unified-reset": "1755000000" }
    });
    expect(readRefusal(response, NOW)).toEqual({
      kind: "exhausted",
      resetAt: 1_755_000_000_000
    });
  });

  /**
   * Anthropic documents the `anthropic-ratelimit-*-reset` family as RFC 3339 and
   * the unified variant has been reported as an epoch. Both are parsed rather
   * than guessed at — a parser that handles both cannot be wrong about which.
   */
  it("accepts a reset header as an RFC 3339 timestamp", () => {
    const at = "2026-08-22T20:00:00Z";
    const response = new Response(null, {
      status: 429,
      headers: { "anthropic-ratelimit-unified-reset": at }
    });
    expect(readRefusal(response, NOW)).toEqual({
      kind: "exhausted",
      resetAt: Date.parse(at)
    });
  });

  /**
   * A `retry-after` of seconds beside a reset hours away is one bucket saying
   * "not this second" and another saying "not for a while". The credential is
   * spent either way, so the furthest-out wins.
   */
  it("takes the furthest-out of two disagreeing headers", () => {
    const response = new Response(null, {
      status: 429,
      headers: {
        "retry-after": "5",
        "anthropic-ratelimit-unified-reset": String((NOW + 3_600_000) / 1000)
      }
    });
    expect(readRefusal(response, NOW)).toEqual({
      kind: "exhausted",
      resetAt: NOW + 3_600_000
    });
  });

  it("assumes a long window when a 429 names no reset at all", () => {
    const verdict = readRefusal(new Response(null, { status: 429 }), NOW);
    expect(verdict?.kind).toBe("exhausted");
  });

  it("reads 401 as an invalid credential", () => {
    expect(readRefusal(new Response(null, { status: 401 }), NOW)).toEqual({
      kind: "invalid"
    });
  });

  /**
   * **403 is not 401**, and conflating them is how a typo becomes an outage.
   *
   * Anthropic returns `401 authentication_error` for a credential it does not
   * accept, and `403 permission_error` for a credential that is fine but may not
   * have the thing being asked for. Retiring on the second turns a
   * *configuration* mistake — a model the subscription cannot reach — into a
   * permanent, pool-wide failure: every credential 403s in turn, every one is
   * marked `dead`, and `dead` is the one state nothing clears on its own. An
   * operator would have to delete Durable Object storage to recover from it.
   *
   * So it is left unclassified, which forwards it untouched and logs it whole —
   * the same treatment every other unrecognised refusal gets.
   */
  it("does not retire a credential on a 403", () => {
    expect(
      readRefusal(new Response(null, { status: 403 }), NOW)
    ).toBeUndefined();
  });

  /**
   * `undefined` is not a fallback, it is the instrument: the gateway forwards
   * these untouched and logs them whole, which is how the rules above get
   * corrected rather than guessed at twice.
   */
  it.each([200, 400, 404, 500, 529])("has no verdict on %i", (status) => {
    expect(readRefusal(new Response(null, { status }), NOW)).toBeUndefined();
  });
});
