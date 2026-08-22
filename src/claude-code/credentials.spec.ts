import { describe, expect, it } from "vitest";
import {
  credentialPool,
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

describe("picking a lead", () => {
  it("uses the first entry, because order is priority", async () => {
    const { pool: p } = pool([A, B]);
    expect(await p.lead()).toEqual({ ok: true, index: 0, token: A });
  });

  it("skips an empty slot rather than handing back an empty token", async () => {
    // `[env.TOKEN_1, env.TOKEN_2]` with the second secret unset is the ordinary
    // one-credential deployment, and it must not forward an empty `Bearer `.
    const { pool: p } = pool(["", B]);
    expect(await p.lead()).toEqual({ ok: true, index: 1, token: B });
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
    const next = await p.spend(0, 1_000_000 + 60 * 60_000);
    expect(next).toEqual({ ok: true, index: 1, token: B });
  });

  it("brings a spent entry back by itself once its reset passes", async () => {
    const { pool: p, advance } = pool([A]);
    await p.spend(0, 1_000_000 + 120_000);

    expect(await p.lead()).toEqual({ ok: false, retryAt: 1_120_000 });
    advance(121_000);
    expect(await p.lead()).toEqual({ ok: true, index: 0, token: A });
  });

  /**
   * Two concurrent requests can both be refused and both report a reset, and
   * the staler one must not make a spent credential look usable earlier than it
   * is. `max`, never assignment.
   */
  it("never shortens a reset that is already further out", async () => {
    const { pool: p, store } = pool([A]);
    await p.spend(0, 1_000_000 + 4 * 60 * 60_000);
    await p.spend(0, 1_000_000 + 60_000);

    expect(store.states()[0]!.resetAt).toBe(1_000_000 + 4 * 60 * 60_000);
  });

  /**
   * The message a human acts on. With several entries spent at different times
   * the useful number is the first one back, not the last one written.
   */
  it("reports the earliest reset when everything is spent", async () => {
    const { pool: p } = pool([A, B, C]);
    await p.spend(0, 5_000_000);
    await p.spend(1, 2_000_000);
    const last = await p.spend(2, 9_000_000);

    expect(last).toEqual({ ok: false, retryAt: 2_000_000 });
  });
});

describe("rejecting an entry", () => {
  it("takes it out for good, not until a reset", async () => {
    const { pool: p, advance } = pool([A, B]);
    await p.reject(0);
    advance(365 * 24 * 60 * 60_000);

    // A revoked credential does not heal on a timer. Collapsing `dead` into a
    // very distant `resetAt` would resurrect it eventually — quietly, and long
    // after anyone remembers why it was retired.
    expect(await p.lead()).toEqual({ ok: true, index: 1, token: B });
  });

  it("reports an all-rejected pool as unrecoverable, not as a wait", async () => {
    const { pool: p } = pool([A, B]);
    await p.reject(0);
    expect(await p.reject(1)).toEqual({ ok: false });
  });
});

/**
 * Stored state is keyed by position and nothing else, so it can disagree with
 * the configured credentials the moment an operator edits the secrets. Trusting
 * it would leave a stale `resetAt` governing whichever token slid into that
 * index — quiet, and wrong in the direction of not calling the model.
 */
describe("state that no longer matches the credentials", () => {
  it("ignores state past the end of a shortened pool", async () => {
    const store = memoryStore([{ resetAt: 0 }, { resetAt: 9_999_999_999 }]);
    const p = credentialPool({
      credentials: () => [A],
      store,
      now: () => 1_000_000
    });
    await p.spend(0, 1_000_000 + 60_000);
    expect(store.states()).toHaveLength(1);
  });

  it("treats a newly added credential as usable", async () => {
    const store = memoryStore([{ resetAt: 9_999_999_999 }]);
    const p = credentialPool({
      credentials: () => [A, B],
      store,
      now: () => 1_000_000
    });
    expect(await p.lead()).toEqual({ ok: true, index: 1, token: B });
  });

  /**
   * A store that cannot be read is not a reason to refuse every request: the
   * cost of retrying the pool from the top is one 429 per entry, and the cost of
   * failing closed is a workspace that can never call a model again.
   */
  it("falls back to an empty map when the store throws", async () => {
    const p = credentialPool({
      credentials: () => [A],
      store: {
        read: async () => {
          throw new Error("storage unavailable");
        },
        write: async () => {}
      },
      now: () => 1_000_000
    });
    expect(await p.lead()).toEqual({ ok: true, index: 0, token: A });
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

  it.each([401, 403])("reads %i as an invalid credential", (status) => {
    expect(readRefusal(new Response(null, { status }), NOW)).toEqual({
      kind: "invalid"
    });
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
