import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_HOST, claudeCodeEgress } from "./egress.js";

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
function stubUpstream(status = 200) {
  const sent: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input as RequestInfo, init));
      return new Response("upstream", { status });
    })
  );
  return sent;
}

const REAL = "sk-ant-oat01-REAL-CREDENTIAL";
const PLACEHOLDER = "sk-ant-oat01-000000000000";

/** A gateway restricted to one host — most tests below are about restriction. */
const gateway = (over: Partial<Parameters<typeof claudeCodeEgress>[0]> = {}) =>
  claudeCodeEgress({
    credential: () => REAL,
    restrictToHosts: ["registry.npmjs.org"],
    ...over
  });

/** The shipped default: no restriction configured at all. */
const openGateway = (
  over: Partial<Parameters<typeof claudeCodeEgress>[0]> = {}
) => claudeCodeEgress({ credential: () => REAL, ...over });

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
    const response = await gateway({ credential: () => "" }).fetch(modelCall());

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
      credential: () => REAL,
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

    it("still refuses over budget", async () => {
      const sent = stubUpstream();
      const response = await openGateway({
        budget: { check: async () => ({ ok: false as const, reason: "cap" }) }
      }).fetch(modelCall());

      expect(response.status).toBe(429);
      expect(sent).toHaveLength(0);
    });

    it("treats an empty array as Anthropic only, not as unrestricted", async () => {
      const sent = stubUpstream();
      const response = await claudeCodeEgress({
        credential: () => REAL,
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

    it("says which rule refused it, so the log is actionable", async () => {
      const response = await openGateway().fetch(
        new Request("http://computer.internal/ws")
      );
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/names the egress gateway itself/);
    });
  });
});

describe("the budget gate", () => {
  const overBudget = {
    check: async () => ({ ok: false as const, reason: "cap reached" })
  };

  it("refuses a model call over cap, with a rate limit the client understands", async () => {
    const sent = stubUpstream();
    const response = await gateway({ budget: overBudget }).fetch(modelCall());

    expect(response.status).toBe(429);
    expect(sent).toHaveLength(0);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "cap reached" }
    });
  });

  /**
   * A `retry-after` we invented would make the client sleep inside the
   * container, on the Looping chunk's clock — the one budget this gateway cannot
   * see. Without it the client's own short backoff runs out and the run fails.
   */
  it("sends no retry-after, so the client does not sleep on our clock", async () => {
    const response = await gateway({ budget: overBudget }).fetch(modelCall());
    expect(response.headers.get("retry-after")).toBeNull();
  });

  /**
   * The opposite of core's `shouldHandleTurn`, which fails open. A gate that
   * fails open there costs a wrong reply; one that failed open here would cost
   * an unbounded spend against somebody's subscription.
   */
  it("treats a gate that throws as a refusal, not as permission", async () => {
    const sent = stubUpstream();
    const response = await gateway({
      budget: {
        check: async () => {
          throw new Error("storage unavailable");
        }
      }
    }).fetch(modelCall());

    expect(response.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  /**
   * The preflight is unauthenticated and costs nothing. Gating it would fail a
   * run at startup with a rate limit it never earned, before a single model call
   * was attempted.
   */
  it("lets the unauthenticated preflight through even when over cap", async () => {
    const sent = stubUpstream();
    const response = await gateway({ budget: overBudget }).fetch(
      new Request(`https://${ANTHROPIC_HOST}/api/hello`, { method: "HEAD" })
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("does not gate a non-Anthropic host", async () => {
    const sent = stubUpstream();
    await gateway({ budget: overBudget }).fetch(
      new Request("https://registry.npmjs.org/left-pad")
    );
    expect(sent).toHaveLength(1);
  });

  it("forwards when the gate says there is budget", async () => {
    const sent = stubUpstream();
    await gateway({
      budget: { check: async () => ({ ok: true as const }) }
    }).fetch(modelCall());
    expect(sent).toHaveLength(1);
  });
});

describe("connect", () => {
  it("refuses a raw socket with a sentence naming why", () => {
    expect(() => gateway().connect("example.com:443")).toThrow(/HTTP only/);
  });
});
