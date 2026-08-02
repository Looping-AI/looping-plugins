import { describe, it, expect, vi } from "vitest";
import { makeArcClient, ARC_AUTH_ERROR } from "./client.js";
import type { CookieJar } from "./types.js";

/** A fetch double that records calls and returns scripted responses. */
function fetchStub(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses[Math.min(i++, responses.length - 1)];
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("makeArcClient", () => {
  it("sends the API key and parses the game list", async () => {
    const { fn, calls } = fetchStub([
      json([{ game_id: "ls20-abc", title: "LS20" }])
    ]);
    const client = makeArcClient("secret-key", { fetchFn: fn });

    const { games } = await client.listGames({});
    expect(games).toEqual([{ game_id: "ls20-abc", title: "LS20" }]);
    expect(calls[0].url).toBe("https://three.arcprize.org/api/games");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
  });

  it("captures set-cookie and echoes it on the next request", async () => {
    const withCookie = json(
      { card_id: "card-1" },
      { "set-cookie": "AWSALB=xyz; Path=/; HttpOnly" }
    );
    const { fn, calls } = fetchStub([withCookie, json({ ok: true })]);
    const client = makeArcClient("k", { fetchFn: fn });

    const opened = await client.openScorecard({});
    expect(opened.cardId).toBe("card-1");
    expect(opened.cookies).toEqual({ AWSALB: "xyz" });

    // The jar from the first call is threaded into the next request's Cookie header.
    await client.getScorecard("card-1", opened.cookies);
    const sent = new Headers(calls[1].init.headers);
    expect(sent.get("cookie")).toBe("AWSALB=xyz");
    expect(calls[0].url).toBe("https://three.arcprize.org/api/scorecard/open");
    expect(calls[1].url).toBe(
      "https://three.arcprize.org/api/scorecard/card-1"
    );
  });

  it("reads the whole card by GET, one environments entry per game", async () => {
    const { fn, calls } = fetchStub([
      json({
        card_id: "card-9",
        score: 2.5,
        total_actions: 41,
        total_environments: 1,
        total_environments_completed: 0,
        total_levels: 6,
        total_levels_completed: 2,
        environments: [
          { id: "ls20-abc", score: 2.5, actions: 41, runs: [{ guid: "g" }] }
        ]
      })
    ]);
    const { summary } = await makeArcClient("k", {
      fetchFn: fn
    }).getScorecard("card-9", {});

    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    // Nothing closes a card any more, so this read is the only path to a score.
    expect(summary.environments[0].id).toBe("ls20-abc");
    expect(summary.environments[0].score).toBe(2.5);
  });

  it("escapes the card id into the path rather than interpolating it raw", async () => {
    const { fn, calls } = fetchStub([json({})]);
    await makeArcClient("k", { fetchFn: fn })
      .getScorecard("card/9", {})
      .catch(() => {});
    expect(calls[0].url).toBe(
      "https://three.arcprize.org/api/scorecard/card%2F9"
    );
  });

  it("includes x,y only for ACTION6 and wraps the note as a reasoning object", async () => {
    const frame = () =>
      json({
        game_id: "g",
        guid: "gid",
        frame: [[[0]]],
        state: "NOT_FINISHED",
        levels_completed: 0,
        available_actions: [1, 6]
      });
    const { fn, calls } = fetchStub([frame(), frame()]);
    const client = makeArcClient("k", { fetchFn: fn });

    await client.act({ action: 1, gameId: "g", guid: "gid", note: "up" }, {});
    expect(calls[0].url).toBe("https://three.arcprize.org/api/cmd/ACTION1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      game_id: "g",
      guid: "gid",
      reasoning: { text: "up" }
    });

    await client.act({ action: 6, gameId: "g", guid: "gid", x: 3, y: 4 }, {});
    expect(calls[1].url).toBe("https://three.arcprize.org/api/cmd/ACTION6");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      game_id: "g",
      guid: "gid",
      x: 3,
      y: 4
    });
  });

  it("retries a 429 with backoff, honoring Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const rateLimited = new Response("slow down", {
      status: 429,
      headers: { "retry-after": "2" }
    });
    const { fn } = fetchStub([rateLimited, json([{ game_id: "ls20-abc" }])]);
    const client = makeArcClient("k", { fetchFn: fn, sleep });

    const { games } = await client.listGames({});
    expect(games).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("throws a tagged deterministic error on 401", async () => {
    const { fn } = fetchStub([new Response("nope", { status: 401 })]);
    await expect(
      makeArcClient("bad", { fetchFn: fn }).listGames({})
    ).rejects.toThrow(ARC_AUTH_ERROR);
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    const sleep = vi.fn(async () => {});
    const { fn } = fetchStub([new Response("down", { status: 503 })]);
    const client = makeArcClient("k", { fetchFn: fn, sleep, maxAttempts: 3 });
    await expect(client.listGames({})).rejects.toThrow(/HTTP 503/);
  });

  it("merges new cookies over an existing jar", async () => {
    const res = json([], { "set-cookie": "AWSALBCORS=new; Path=/" });
    const { fn } = fetchStub([res]);
    const jar: CookieJar = { AWSALB: "old" };
    const { cookies } = await makeArcClient("k", { fetchFn: fn }).listGames(
      jar
    );
    expect(cookies).toEqual({ AWSALB: "old", AWSALBCORS: "new" });
  });
});
