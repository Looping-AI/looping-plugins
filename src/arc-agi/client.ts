import {
  ARC_BASE_URL,
  type CookieJar,
  type FrameResponse,
  type GameInfo,
  type ScorecardSummary
} from "./types.js";

/**
 * Typed client for the ARC-AGI-3 REST API.
 *
 * Two Workers-specific concerns are handled explicitly, because `fetch` in a
 * Worker manages neither:
 *
 * - **Session affinity**: the API pins a game session to a load-balancer via
 *   `AWSALB*` cookies returned on RESET/ACTION responses; they MUST be echoed on
 *   every subsequent request. The jar is passed in and returned as plain data
 *   (not a stateful client), so it checkpoints into the workspace and survives
 *   isolate eviction between chunks.
 * - **Rate limiting**: 600 RPM → 429; we honor `Retry-After` with bounded
 *   exponential backoff. Exhausted retries and 5xx throw (transient — the
 *   Workflow step retries and the runner resumes from its checkpoint); a 401
 *   throws a tagged deterministic error (bad key — a terminal failure).
 */
export interface ArcClient {
  listGames(
    cookies: CookieJar
  ): Promise<{ games: GameInfo[]; cookies: CookieJar }>;
  openScorecard(
    cookies: CookieJar
  ): Promise<{ cardId: string; cookies: CookieJar }>;
  /**
   * The whole card, with one `environments` entry per game played on it.
   * Readable while the card is still open, which is what lets a result be
   * reported without anything closing a card.
   */
  getScorecard(
    cardId: string,
    cookies: CookieJar
  ): Promise<{ summary: ScorecardSummary; cookies: CookieJar }>;
  reset(
    input: { gameId: string; cardId: string; guid?: string },
    cookies: CookieJar
  ): Promise<{ frame: FrameResponse; cookies: CookieJar }>;
  act(
    input: {
      action: number;
      gameId: string;
      guid: string;
      x?: number;
      y?: number;
      note?: string;
    },
    cookies: CookieJar
  ): Promise<{ frame: FrameResponse; cookies: CookieJar }>;
}

/** Message prefix of the deterministic (non-retryable) auth error. */
export const ARC_AUTH_ERROR = "arc-client: unauthorized";

export interface ArcClientOptions {
  fetchFn?: typeof fetch;
  /** Injected for tests; defaults to a real timed sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts per request before a 429/5xx becomes a thrown transient fault. */
  maxAttempts?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Merge `set-cookie` headers from a response into the jar (name=value pairs). */
function mergeCookies(jar: CookieJar, res: Response): CookieJar {
  const next = { ...jar };
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    next[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return next;
}

/** Serialize the jar to a `Cookie` request header, or undefined when empty. */
function cookieHeader(jar: CookieJar): string | undefined {
  const parts = Object.entries(jar).map(([k, v]) => `${k}=${v}`);
  return parts.length === 0 ? undefined : parts.join("; ");
}

export function makeArcClient(
  apiKey: string,
  options: ArcClientOptions = {}
): ArcClient {
  const doFetch = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const maxAttempts = options.maxAttempts ?? 4;

  async function request<T>(
    path: string,
    init: { method: string; body?: unknown },
    cookies: CookieJar
  ): Promise<{ data: T; cookies: CookieJar }> {
    const headers: Record<string, string> = {
      "X-API-Key": apiKey,
      accept: "application/json"
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const cookie = cookieHeader(cookies);
    if (cookie) headers["cookie"] = cookie;

    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await doFetch(`${ARC_BASE_URL}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });

      if (res.ok) {
        const nextCookies = mergeCookies(cookies, res);
        const data = (await res.json()) as T;
        return { data, cookies: nextCookies };
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`${ARC_AUTH_ERROR} (HTTP ${res.status})`);
      }

      // 429 / 5xx: retry with backoff, honoring Retry-After when present.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxAttempts) {
        throw new Error(
          `arc-client: ${init.method} ${path} failed (HTTP ${res.status})`
        );
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 8000);
      await sleep(backoffMs);
    }
  }

  return {
    async listGames(cookies) {
      const { data, cookies: next } = await request<GameInfo[]>(
        "/api/games",
        { method: "GET" },
        cookies
      );
      return { games: data, cookies: next };
    },

    async openScorecard(cookies) {
      const { data, cookies: next } = await request<{ card_id: string }>(
        "/api/scorecard/open",
        { method: "POST", body: {} },
        cookies
      );
      return { cardId: data.card_id, cookies: next };
    },

    async getScorecard(cardId, cookies) {
      const { data, cookies: next } = await request<ScorecardSummary>(
        `/api/scorecard/${encodeURIComponent(cardId)}`,
        { method: "GET" },
        cookies
      );
      return { summary: data, cookies: next };
    },

    async reset(input, cookies) {
      const body: Record<string, unknown> = {
        game_id: input.gameId,
        card_id: input.cardId
      };
      if (input.guid !== undefined) body.guid = input.guid;
      const { data, cookies: next } = await request<FrameResponse>(
        "/api/cmd/RESET",
        { method: "POST", body },
        cookies
      );
      return { frame: data, cookies: next };
    },

    async act(input, cookies) {
      const body: Record<string, unknown> = {
        game_id: input.gameId,
        guid: input.guid
      };
      if (input.action === 6) {
        body.x = input.x;
        body.y = input.y;
      }
      if (input.note !== undefined) body.reasoning = { text: input.note };
      const { data, cookies: next } = await request<FrameResponse>(
        `/api/cmd/ACTION${input.action}`,
        { method: "POST", body },
        cookies
      );
      return { frame: data, cookies: next };
    }
  };
}
