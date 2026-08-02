import { z } from "zod";
import type { ArcClient } from "./client.js";
import type {
  CookieJar,
  FrameResponse,
  Scorecard,
  ScorecardSummary
} from "./types.js";

/**
 * The `arc-game` recipe's scorecard policy: which card a play runs on, and what
 * that play scored.
 *
 * Neither is a model's decision any more. The ARC API auto-closes a card after
 * ~15 minutes idle, which makes the whole open/close lifecycle the *server's* —
 * so the only judgement left is arithmetic: a card used recently is still alive
 * and every concurrent play should share it; an older one is gone and a new card
 * has to be opened. That is {@link resolveScorecard}, run by the parent once per
 * durable chunk (a subagent facet has no DB, so it cannot own this).
 *
 * Because nothing closes a card, the score is *read* rather than returned:
 * `GET /api/scorecard/{card_id}` works on an open card, and
 * {@link gameScoreReport} appends the finished game's entry to its play's report.
 *
 * Handlers are exported separately from any tool wiring so they unit-test without
 * an LLM, and {@link ScorecardStore} is a narrow interface (`AgentDB.scorecards`
 * satisfies it structurally) so tests can pass an in-memory fake.
 */

/**
 * How long a card stays reusable. Deliberately a minute short of the API's ~15
 * minute idle auto-close: the clock is bumped per durable chunk, and a chunk is
 * capped at `CHUNK_SOFT_MS` (4 minutes), so the margin only has to cover the gap
 * between two bumps — not a whole play.
 */
export const SCORECARD_REUSE_MS = 14 * 60_000;

/** The slice of `AgentDB.scorecards` the scorecard policy needs. */
export interface ScorecardStore {
  findRecent(since: number): Scorecard | null;
  get(cardId: string): Scorecard | null;
  open(cardId: string, cookies: CookieJar): Scorecard;
  setGuid(cardId: string, gameId: string, guid: string): void;
  touch(cardId: string): void;
}

export interface ArcScorecardDeps {
  store: ScorecardStore;
  client: ArcClient;
}

/** The resolved card a play runs on: its id, and the jar the API pinned to it. */
export interface ResolvedScorecard {
  cardId: string;
  cookies: CookieJar;
}

/**
 * Lease a scorecard for a play: reuse the most recently used live card, or open a
 * new one. Either way the card's clock is restarted, so a play that keeps calling
 * this (once per chunk) keeps its own card alive for as long as it runs.
 *
 * `now` is injected so the window is testable at its boundary.
 */
export async function resolveScorecard(
  deps: ArcScorecardDeps,
  now: number = Date.now()
): Promise<ResolvedScorecard> {
  const recent = deps.store.findRecent(now - SCORECARD_REUSE_MS);
  if (recent) {
    deps.store.touch(recent.cardId);
    return { cardId: recent.cardId, cookies: recent.cookies };
  }
  const { cardId, cookies } = await deps.client.openScorecard({});
  deps.store.open(cardId, cookies);
  return { cardId, cookies };
}

/** A play a subagent can join: the card, and the ARC session handle on it. */
export interface ResolvedPlay extends ResolvedScorecard {
  /** The ARC play handle. Every ACTION is addressed to it. */
  guid: string;
  /**
   * The opening frame — present **only** on the call that minted the guid, and
   * absent on every later resolution of the same play. There is no ARC endpoint
   * that reads a board back, so this is the one chance to hand one over; a
   * subagent that joins later learns the board from its first ACTION instead.
   */
  frame?: FrameResponse;
}

/**
 * Resolve the play a Subtask runs: the leased card, plus the guid for this game
 * on it — reusing the recorded one, or RESETting **once** to mint it.
 *
 * This is the only RESET in the system. A guid is mintable only by RESET, and a
 * second RESET is a second run on the card: separately scored, with whatever the
 * first play reached left behind. Pinning one guid per (card, game) in the store
 * is what makes a re-dispatched Subtask, a lost workspace, or a later chunk
 * rejoin the play in progress instead of quietly starting another — so a
 * GAME_OVER stays the result this card recorded for this game.
 */
export async function resolvePlay(
  deps: ArcScorecardDeps,
  gameId: string,
  now: number = Date.now()
): Promise<ResolvedPlay> {
  const { cardId, cookies } = await resolveScorecard(deps, now);
  const recorded = deps.store.get(cardId)?.guids[gameId];
  if (recorded !== undefined) return { cardId, cookies, guid: recorded };

  const { frame, cookies: next } = await deps.client.reset(
    { gameId, cardId },
    cookies
  );
  deps.store.setGuid(cardId, gameId, frame.guid);

  // `setGuid` keeps the first guid written, so losing a race to a concurrent
  // resolution means this RESET opened a play nobody will join. Hand back the
  // guid that won — and not this frame, which belongs to the abandoned play.
  const winner = deps.store.get(cardId)?.guids[gameId] ?? frame.guid;
  return winner === frame.guid
    ? { cardId, cookies: next, guid: frame.guid, frame }
    : { cardId, cookies: next, guid: winner };
}

/**
 * Loose on purpose: a field the API adds tomorrow must not turn a real result
 * into a parse error. The fields asserted here are the ones
 * {@link renderGameScore} actually renders.
 */
const runSchema = z.looseObject({
  guid: z.string(),
  actions: z.number(),
  completed: z.boolean(),
  levels_completed: z.number(),
  resets: z.number(),
  score: z.number(),
  state: z.enum(["NOT_STARTED", "NOT_FINISHED", "WIN", "GAME_OVER"])
});

const environmentSchema = z.looseObject({
  id: z.string(),
  actions: z.number(),
  completed: z.boolean(),
  level_count: z.number(),
  levels_completed: z.number(),
  resets: z.number(),
  score: z.number(),
  runs: z.array(runSchema)
});

const summarySchema = z.looseObject({
  card_id: z.string(),
  environments: z.array(environmentSchema)
});

/**
 * Exactly what a game's report may be built from — deliberately narrower than
 * {@link ScorecardSummary}, which also carries card-wide totals. Narrowing it
 * here makes quoting one of those totals as a game's own result a type error
 * rather than a judgement call, which is the mistake this guards.
 */
export type GameScoreSource = Pick<
  ScorecardSummary,
  "card_id" | "environments"
>;

/**
 * What one game scored on a card: its aggregate, then a line per play.
 *
 * Reads **only** the game's own `environments` entry. Every top-level field of
 * the response (`score`, `total_actions`, `total_levels_completed`, …) covers the
 * whole card, and since concurrent plays share a card by design, quoting one as
 * this game's result would be a straightforward mislabeling — verified against
 * the live API, where a card with two games reported both games' actions at the
 * top level.
 */
export function renderGameScore(
  summary: GameScoreSource,
  gameId: string
): string {
  // Match by id rather than taking the sole entry on trust: a mislabeled result
  // is worse than none.
  const env = summary.environments.find((e) => e.id === gameId);
  if (!env || env.runs.length === 0) {
    return `Scorecard ${summary.card_id} recorded no plays of ${gameId}.`;
  }
  const header =
    `Score for ${gameId} on scorecard ${summary.card_id}: ` +
    `${env.score} — ${env.levels_completed}/${env.level_count} levels, ` +
    `${env.actions} actions across ${env.runs.length} play(s)` +
    (env.completed ? " (completed)" : "") +
    ".";
  const plays = env.runs.map(
    (run, index) =>
      `- play ${index + 1}: ${run.state}, ${run.levels_completed} level(s), ` +
      `${run.actions} actions, score ${run.score}`
  );
  return `${header}\n${plays.join("\n")}`;
}

/**
 * The finished play's score, as a line to append to its report — or null if it
 * cannot be read.
 *
 * Best-effort by contract: this runs *after* a play has already succeeded, so a
 * rate-limited or malformed score response must cost the run nothing. Every
 * failure is logged and swallowed.
 *
 * Reads with the card's stored jar rather than the play's: the play's jar drifted
 * across chunks, while the stored one is the session the API pinned the card to.
 */
export async function gameScoreReport(
  deps: ArcScorecardDeps,
  cardId: string,
  gameId: string
): Promise<string | null> {
  try {
    const card = deps.store.get(cardId);
    const { summary } = await deps.client.getScorecard(
      cardId,
      card?.cookies ?? {}
    );
    return renderGameScore(
      summarySchema.parse(summary) as GameScoreSource,
      gameId
    );
  } catch (err) {
    console.warn("[arc-game] scorecard read failed", {
      cardId,
      gameId,
      err: String(err)
    });
    return null;
  }
}
