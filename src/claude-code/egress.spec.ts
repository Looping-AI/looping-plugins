import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_HOST, claudeCodeEgress } from "./egress.js";
import type { CredentialState, CredentialStore } from "./credentials.js";

/**
 * The gateway is the whole of the containment, so every test here is a
 * containment property rather than a behaviour.
 *
 * The container runs a coding agent over a cloned repository, and the repository
 * is a stranger's: `npm ci` runs its `postinstall`, the agent runs its test
 * suite. Nothing inside is trusted, nothing inside holds a secret, and this
 * function is the only route out. What it forwards is the boundary.
 */

afterEach(() => vi.unstubAllGlobals());

/** Capture what actually left, which is the only thing worth asserting. */
function stubUpstream(status = 200, headers: Record<string, string> = {}) {
  const sent: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input as RequestInfo, init));
      return new Response("upstream", { status, headers });
    })
  );
  return sent;
}

/**
 * An upstream that answers per credential, which is what a rotation test needs:
 * the whole question is whether the *second* attempt carries a different token.
 */
function stubPerCredential(
  answer: (token: string | null) => Response
): Request[] {
  const sent: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      sent.push(request);
      return answer(request.headers.get("authorization"));
    })
  );
  return sent;
}

const REAL = "sk-ant-oat01-REAL-CREDENTIAL";
const SECOND = "sk-ant-oat01-SECOND-CREDENTIAL";
const PLACEHOLDER = "sk-ant-oat01-000000000000";

/** An in-memory pool store — the host supplies one over its own storage. */
function memoryStore(initial: CredentialState[] = []): CredentialStore {
  let states = initial;
  return {
    read: async () => states,
    write: async (next) => {
      states = next;
    }
  };
}

/** A gateway restricted to one host — most tests below are about restriction. */
const gateway = (over: Partial<Parameters<typeof claudeCodeEgress>[0]> = {}) =>
  claudeCodeEgress({
    credentials: () => [REAL],
    store: memoryStore(),
    restrictToHosts: ["registry.npmjs.org"],
    ...over
  });

/** The shipped default: no restriction configured at all. */
const openGateway = (
  over: Partial<Parameters<typeof claudeCodeEgress>[0]> = {}
) =>
  claudeCodeEgress({
    credentials: () => [REAL],
    store: memoryStore(),
    ...over
  });

/** How Claude Code 2.1.238 actually sends a model call — see the Phase 0 capture. */
function modelCall(): Request {
  return new Request(`https://${ANTHROPIC_HOST}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PLACEHOLDER}`,
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24",
      "user-agent": "claude-cli/2.1.238 (external, sdk-cli)",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: "claude-opus-5" })
  });
}

describe("the credential swap", () => {
  it("replaces the placeholder with the real credential for Anthropic", async () => {
    const sent = stubUpstream();
    await gateway().fetch(modelCall());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  /**
   * The placeholder is what the container holds, and the swap is the reason it
   * can hold something worthless. A test that only checked the real credential
   * arrived would pass on an implementation that sent both.
   */
  it("leaves no trace of the placeholder", async () => {
    const sent = stubUpstream();
    await gateway().fetch(modelCall());

    const headers = [...sent[0]!.headers.values()].join(" ");
    expect(headers).not.toContain(PLACEHOLDER);
    expect(sent[0]!.headers.get("x-api-key")).toBeNull();
  });

  /**
   * `claude-code-20250219` and `oauth-2025-04-20` are almost certainly part of
   * what marks this as the sanctioned client — the same subscription credential
   * 429s at zero tokens against the raw Messages API. Normalising or reordering
   * these headers is the kind of helpfulness that would break the whole premise.
   */
  it("forwards the beta list and user-agent untouched", async () => {
    const sent = stubUpstream();
    await gateway().fetch(modelCall());

    expect(sent[0]!.headers.get("anthropic-beta")).toBe(
      "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24"
    );
    expect(sent[0]!.headers.get("user-agent")).toBe(
      "claude-cli/2.1.238 (external, sdk-cli)"
    );
  });

  it("keeps the method, the query string and the body", async () => {
    const sent = stubUpstream();
    await gateway().fetch(modelCall());

    expect(sent[0]!.method).toBe("POST");
    expect(new URL(sent[0]!.url).search).toBe("?beta=true");
    expect(await sent[0]!.text()).toBe('{"model":"claude-opus-5"}');
  });

  it("refuses rather than forwarding when no credential is configured", async () => {
    const sent = stubUpstream();
    const response = await gateway({ credentials: () => [] }).fetch(
      modelCall()
    );

    // 500, not 429: an empty pool does not recover on a timer, and a rate limit
    // would have the client retry against a wall for the rest of the session.
    expect(response.status).toBe(500);
    // The important half: nothing left the boundary. Forwarding the placeholder
    // would come back as an authentication error and send an operator to rotate
    // a credential when the real fault is a missing secret.
    expect(sent).toHaveLength(0);
  });
});

describe("the host restriction", () => {
  it("passes an allowed host through", async () => {
    const sent = stubUpstream();
    const response = await gateway().fetch(
      new Request("https://registry.npmjs.org/left-pad")
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  /**
   * The repo plugin keeps git on the Worker: clone, fetch and push all run as
   * isomorphic-git inside the Durable Object, so the container never needs forge
   * access and the forge token never enters it. That is true whether or not a
   * restriction is configured — this only checks that a configured one bites.
   */
  it("refuses github.com when a restriction is configured", async () => {
    const sent = stubUpstream();
    const response = await gateway().fetch(new Request("https://github.com/x"));

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  /**
   * No wildcards, deliberately. A rule like `*.npmjs.org` is how an allowlist
   * becomes an anylist the first time a host serves user-controlled subdomains.
   */
  it("does not treat a subdomain of an allowed host as allowed", async () => {
    const sent = stubUpstream();
    const response = await gateway().fetch(
      new Request("https://evil.registry.npmjs.org/x")
    );

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  /**
   * A placeholder sent to a third party is worthless to them and still a
   * credential leak in every log it lands in.
   */
  it("strips credential headers from anything that is not Anthropic", async () => {
    const sent = stubUpstream();
    await gateway().fetch(
      new Request("https://registry.npmjs.org/left-pad", {
        headers: {
          authorization: `Bearer ${PLACEHOLDER}`,
          "x-api-key": PLACEHOLDER,
          "proxy-authorization": "Basic abc"
        }
      })
    );

    expect(sent[0]!.headers.get("authorization")).toBeNull();
    expect(sent[0]!.headers.get("x-api-key")).toBeNull();
    expect(sent[0]!.headers.get("proxy-authorization")).toBeNull();
  });

  it("allows api.anthropic.com without it being listed", async () => {
    const sent = stubUpstream();
    await claudeCodeEgress({
      credentials: () => [REAL],
      store: memoryStore(),
      restrictToHosts: []
    }).fetch(modelCall());
    expect(sent).toHaveLength(1);
  });

  /**
   * The three-way semantics, and the reason `[]` is not the same as omitting.
   *
   * A host computing this list — `repos.flatMap(hostsFor)` — that happens to
   * produce `[]` means "nothing extra". Collapsing that into "everything" would
   * hand the widest possible policy to an expression that returned nothing.
   */
  describe("the default is unrestricted", () => {
    it("lets an arbitrary host through when nothing is configured", async () => {
      const sent = stubUpstream();
      const response = await openGateway().fetch(
        new Request("https://objects.githubusercontent.com/some-binary.tgz")
      );

      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it("still strips credential headers from that arbitrary host", async () => {
      // The invariant that does *not* depend on the restriction, and the reason
      // opening the default up costs nothing where the credential is concerned.
      const sent = stubUpstream();
      await openGateway().fetch(
        new Request("https://anywhere.example", {
          headers: { authorization: `Bearer ${PLACEHOLDER}` }
        })
      );

      expect(sent[0]!.headers.get("authorization")).toBeNull();
    });

    it("still swaps the credential for Anthropic", async () => {
      const sent = stubUpstream();
      await openGateway().fetch(modelCall());
      expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
    });

    it("treats an empty array as Anthropic only, not as unrestricted", async () => {
      const sent = stubUpstream();
      const response = await claudeCodeEgress({
        credentials: () => [REAL],
        store: memoryStore(),
        restrictToHosts: []
      }).fetch(new Request("https://registry.npmjs.org/left-pad"));

      expect(response.status).toBe(403);
      expect(sent).toHaveLength(0);
    });
  });

  /**
   * Under `mode: "direct"` the container's traffic leaves from the container's
   * own network position; under `http-gateway` **the Worker makes the request**.
   * So an unrestricted policy hands the container the Worker's reach, and the
   * loopback the intercept itself rides on is never a legitimate destination.
   */
  describe("the gateway's own side of the boundary", () => {
    it.each(["computer.internal", "localhost", "127.0.0.1", "0.0.0.0"])(
      "refuses %s even with no restriction configured",
      async (host) => {
        const sent = stubUpstream();
        const response = await openGateway().fetch(
          new Request(`http://${host}/ws`)
        );

        expect(response.status).toBe(403);
        expect(sent).toHaveLength(0);
      }
    );

    /**
     * `URL.hostname` is not canonical for an exact-match set. IPv6 keeps its
     * brackets (`http://[::1]/` reports `[::1]`, not `::1`) and a trailing dot
     * survives (`computer.internal.` resolves to the same place). Either
     * spelling walks straight past a naive `Set.has`.
     */
    it.each([
      ["http://[::1]/ws", "bracketed IPv6"],
      ["http://computer.internal./ws", "trailing dot"],
      ["http://COMPUTER.INTERNAL/ws", "uppercase"]
    ])("refuses %s (%s)", async (url) => {
      const sent = stubUpstream();
      const response = await openGateway().fetch(new Request(url));

      expect(response.status).toBe(403);
      expect(sent).toHaveLength(0);
    });

    it("says which rule refused it, so the log is actionable", async () => {
      const response = await openGateway().fetch(
        new Request("http://computer.internal/ws")
      );
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/names the egress gateway itself/);
    });
  });
});

/**
 * The host matched; the scheme is the rest of the question.
 *
 * Nothing stops a process in the container asking for
 * `http://api.anthropic.com/…`, and this gateway would otherwise fetch it —
 * putting the real subscription token on the wire in plaintext, from the Worker,
 * at the request of code the workspace does not trust.
 */
describe("plaintext to Anthropic", () => {
  it("refuses http, before the credential is even read", async () => {
    const sent = stubUpstream();
    const response = await claudeCodeEgress({
      credentials: () => {
        throw new Error("the credential must not be read on this path");
      },
      store: memoryStore(),
      restrictToHosts: []
    }).fetch(
      new Request(`http://${ANTHROPIC_HOST}/v1/messages`, { method: "POST" })
    );

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("refuses the plaintext preflight too", async () => {
    const sent = stubUpstream();
    const response = await openGateway().fetch(
      new Request(`http://${ANTHROPIC_HOST}/api/hello`, { method: "HEAD" })
    );

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  /**
   * The trailing dot is the same destination, so it must take the same branch —
   * otherwise it would slip past as an ordinary host: credential stripped (safe)
   * but a spent bucket never noticed on that spelling (not).
   */
  it("treats a trailing-dot Anthropic host as Anthropic", async () => {
    const sent = stubUpstream();
    await openGateway().fetch(
      new Request(`https://${ANTHROPIC_HOST}./v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${PLACEHOLDER}` }
      })
    );

    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  it("rotates on a trailing-dot Anthropic host too", async () => {
    const sent = stubPerCredential((token) =>
      token === `Bearer ${REAL}`
        ? new Response("{}", {
            status: 429,
            headers: { "retry-after": "14400" }
          })
        : new Response("ok", { status: 200 })
    );
    const rotating = claudeCodeEgress({
      credentials: () => [REAL, SECOND],
      store: memoryStore()
    });
    const url = `https://${ANTHROPIC_HOST}./v1/messages`;

    await rotating.fetch(new Request(url, { method: "POST" }));
    await rotating.fetch(new Request(url, { method: "POST" }));

    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${SECOND}`);
  });
});

/**
 * Rotation is what replaced the budget gate, and the difference is the whole
 * design: a budget *predicts* a bucket nobody can read, rotation *reads* the
 * one place the bucket announces itself — Anthropic's own response.
 *
 * Every test here is about not overreacting. The expensive mistakes are
 * symmetrical and both are cheap to make: retiring a working credential because
 * of an ordinary slow-down, and failing to notice a spent one.
 */
describe("credential rotation", () => {
  /** A spent 5-hour bucket, as far as anything here can know one. */
  const EXHAUSTED = { status: 429, headers: { "retry-after": "14400" } };

  const rotating = (
    over: Partial<Parameters<typeof claudeCodeEgress>[0]> = {}
  ) =>
    claudeCodeEgress({
      credentials: () => [REAL, SECOND],
      store: memoryStore(),
      ...over
    });

  it("moves the lead on when a credential's bucket is spent", async () => {
    const sent = stubPerCredential((token) =>
      token === `Bearer ${REAL}`
        ? new Response("{}", EXHAUSTED)
        : new Response("ok", { status: 200 })
    );
    const egress = rotating();

    await egress.fetch(modelCall());
    const second = await egress.fetch(modelCall());

    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${SECOND}`);
    expect(second.status).toBe(200);
  });

  /**
   * The rewrite is what turns the client's own retry into the rotation, and it
   * is the reason nothing here buffers a request body. Left at the upstream's
   * value the client would sleep for four hours holding a chunk open, which is
   * a stall rather than a rotation.
   */
  it("tells the client to retry in a second, not in four hours", async () => {
    stubUpstream(429, { "retry-after": "14400" });
    const response = await rotating().fetch(modelCall());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  /**
   * An ordinary slow-down is not this credential's fault. Rotating on one would
   * retire a perfectly good credential for whatever window the header named —
   * and with a small pool, two speed bumps would empty it.
   */
  it("does not rotate on a transient 429", async () => {
    const sent = stubPerCredential(
      () => new Response("{}", { status: 429, headers: { "retry-after": "5" } })
    );
    const egress = rotating();

    const first = await egress.fetch(modelCall());
    await egress.fetch(modelCall());

    // Passed through exactly as it came: same wait, same status.
    expect(first.headers.get("retry-after")).toBe("5");
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  /**
   * A revoked credential is a different claim from a spent one — it never
   * recovers — so it is taken out for good rather than until a reset.
   *
   * The status is rewritten to 429 on the way out, and that is deliberate: a
   * client does not retry a 401, so passing one through would fail the run on a
   * credential the gateway has already stopped using.
   */
  it("retires a rejected credential and asks the client to retry", async () => {
    const sent = stubPerCredential((token) =>
      token === `Bearer ${REAL}`
        ? new Response("{}", { status: 401 })
        : new Response("ok", { status: 200 })
    );
    const egress = rotating();

    const first = await egress.fetch(modelCall());
    await egress.fetch(modelCall());

    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${SECOND}`);
  });

  /**
   * The give-up path, and the one place the short `retry-after` would be
   * actively harmful: there is nothing left to rotate to, so a one-second wait
   * would spin the client against a wall for the rest of the session.
   */
  it("passes the real wait through once every credential is spent", async () => {
    stubUpstream(429, { "retry-after": "14400" });
    const egress = rotating();

    await egress.fetch(modelCall()); // spends REAL
    await egress.fetch(modelCall()); // spends SECOND
    const exhausted = await egress.fetch(modelCall());

    expect(exhausted.status).toBe(429);
    expect(Number(exhausted.headers.get("retry-after"))).toBeGreaterThan(1000);
    const body = (await exhausted.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/every Anthropic credential/);
  });

  /**
   * A rejected pool does not recover on a timer, so it is a 500 rather than a
   * rate limit — the operator has to act, and a 429 would hide that behind a
   * retry loop.
   */
  it("reports an all-rejected pool as needing an operator", async () => {
    stubUpstream(401);
    const egress = rotating();

    await egress.fetch(modelCall());
    await egress.fetch(modelCall());
    const dead = await egress.fetch(modelCall());

    expect(dead.status).toBe(500);
    expect(dead.headers.get("retry-after")).toBeNull();
  });

  /**
   * The hot path. A successful model call is a streamed SSE body that must reach
   * the container untouched — inspecting it, or cloning it to look, would be
   * paid on every response rather than on the rare refusal.
   */
  it("passes a successful response straight through", async () => {
    stubUpstream(200);
    const response = await rotating().fetch(modelCall());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upstream");
  });

  /**
   * An ordinary client error is not a statement about the credential. Rotating
   * on one would empty the pool on a malformed request.
   */
  it("leaves an unrecognised 4xx alone", async () => {
    const sent = stubPerCredential(
      () => new Response("bad request", { status: 400 })
    );
    const egress = rotating();

    const response = await egress.fetch(modelCall());
    await egress.fetch(modelCall());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad request");
    expect(sent[1]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  /**
   * A pool of one is the ordinary single-credential deployment, and it must not
   * become unusable the moment it is refused once — it comes back at its reset,
   * with no operator involvement and nothing to clear.
   */
  it("recovers a single-credential pool once its reset has passed", async () => {
    stubUpstream(429, { "retry-after": "120" });
    const store = memoryStore();
    let clock = 1_000_000;
    const egress = claudeCodeEgress({
      credentials: () => [REAL],
      store,
      now: () => clock
    });

    const refused = await egress.fetch(modelCall());
    expect(refused.status).toBe(429);

    clock += 121_000;
    const sent = stubUpstream(200);
    const after = await egress.fetch(modelCall());

    expect(after.status).toBe(200);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });
});

describe("connect", () => {
  it("refuses a raw socket with a sentence naming why", () => {
    expect(() => gateway().connect("example.com:443")).toThrow(/HTTP only/);
  });
});
