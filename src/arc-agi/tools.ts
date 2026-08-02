import { tool } from "ai";
import { z } from "zod";
import type { ToolFamilyContext, RecipeToolSet } from "@loopingai/core";
import { runtimeAs } from "@loopingai/core/subtasks";
import { makeArcClient } from "./client.js";
import {
  colorHistogram,
  colorName,
  describeBox,
  describeCell,
  diffGrids,
  diffShapes,
  lastGrid,
  parseGrid,
  renderGrid,
  renderRegion,
  renderShapeDelta,
  renderShapes,
  renderTravel,
  serializeGrid,
  trackTravel,
  type GridDiff,
  type ShapeDelta,
  type ShapeTravel
} from "./analysis.js";
import {
  ARC_SESSION_PATH,
  type ArcRuntime,
  type ArcSession,
  type FrameResponse
} from "./types.js";

/**
 * The `arc-game` tool family: act / inspect against the ARC-AGI-3 REST API. All
 * durable session state (cookies, guid, frames, metrics) lives in the workspace
 * at {@link ARC_SESSION_PATH}, so the run resumes across chunks and isolate
 * eviction. The API key is closed over from the plugin's config, never model
 * input.
 *
 * This family **plays**; it does not manage scorecards. The game arrives as a
 * validated Subtask param and the card as parent-resolved runtime (leased by
 * {@link file://./scorecard.ts}), so nothing here ever opens, closes, or chooses
 * a card.
 *
 * **Nothing here ever RESETs.** The play is opened once per (card, game) by the
 * parent (`resolvePlay`) and arrives as `runtime.guid`; this family only joins
 * it. That is the whole point: a guid is mintable only by RESET, and a second
 * RESET is a second run on the card, so a family that could reset would be able
 * to throw away a play by retrying it. Instead a WIN or GAME_OVER is the result
 * this card recorded for this game, and the model reports it.
 *
 * The session file is a local cache of that play, not its identity — the guid in
 * `runtime` is. A subagent that lost its workspace, or a re-dispatched Subtask,
 * rebuilds the file around the same guid and plays on.
 *
 * Transient ARC faults surface to the model as tool errors (the SDK captures a
 * throwing tool as an in-band `tool-error` result, not a rejected generation);
 * the soul tells the model to give up and report after repeated failures, and the
 * turn budget bounds it.
 */
/**
 * This family's key in a Recipe's `toolFamilies`. Exported because it is also
 * what tells the parent a Subtask needs a scorecard leased before it can run —
 * see `resolveRuntime` in the ReactiveAgent DO.
 */
export const ARC_GAME_FAMILY = "arc-game";

export function buildArcGameTools(
  apiKey: string,
  ctx: ToolFamilyContext
): RecipeToolSet {
  const { workspace, emitProgress, params } = ctx;
  // Closed over from the plugin's config, never `ctx.env`. The predecessor
  // passed the Worker `env` to every tool family, which a published package
  // cannot do — `Env` is the ambient interface `wrangler types` generates into a
  // *consumer's* app and does not exist here. Config-at-instantiation is also
  // the only thing that works on Workers at all, where `env` has no module scope.
  const client = makeArcClient(apiKey);
  const runtime = runtimeAs<ArcRuntime>(ctx.runtime);

  // All settled before the model runs — it cannot pick a different game, and it
  // cannot see, choose, or name a card or a play at all. The game is the type's
  // declared param; the card and the guid are what the parent resolved for this
  // chunk, and the guid in particular is the play it must join rather than open.
  const gameId = params.game_id;
  const cardId = runtime.cardId;
  const guid = runtime.guid;

  const load = (): Promise<ArcSession | null> =>
    workspace.readJson<ArcSession>(ARC_SESSION_PATH);
  const save = (s: ArcSession): Promise<void> =>
    workspace.writeJson(ARC_SESSION_PATH, s);
  /** The stored board as a grid, or null when no frame has been recorded yet. */
  const board = (s: ArcSession): number[][] | null =>
    s.lastGridHex === null ? null : parseGrid(s.lastGridHex);

  /**
   * The session for the play in `runtime`, from the workspace or rebuilt around
   * the resolved guid. Never opens a play — there is nothing here that could.
   *
   * The rebuilt case is a real one (fresh workspace, re-dispatched Subtask), and
   * it is why {@link ArcSession.availableActions} may be empty: the parent's
   * opening frame is handed over only to whoever opened the play, and no ARC
   * endpoint reads a board back. An empty list means *unknown*, not *none* — the
   * first ACTION returns a full frame and fills it in.
   *
   * **Once the file exists it is the play**, and a later chunk's lease cannot
   * pull it onto a different card or a different guid. A rollover — the reuse
   * window elapsing between two chunk starts, so an ARC outage or an exhausted
   * step retry rather than anything a play did — leases a fresh card, and a fresh
   * card has no recorded guid, so the parent RESETs. `runtime.guid` then names a
   * play with nothing in it while this file names the play holding every level
   * reached. Joining the new one would throw the real one away, so the divergence
   * is logged and not acted on — and logged rather than silent because both of its
   * residuals are outside this family's reach:
   *
   * - the parent's RESET already recorded a second, empty run on the new card, and
   * - `enrichResult` reads the score from the *leased* card, so the report
   *   describes that empty run instead of this play.
   */
  const resume = async (): Promise<ArcSession> => {
    const stored = await load();
    if (stored) {
      if (guid !== undefined && stored.guid !== guid) {
        console.warn("[arc-game] play/lease divergence", {
          gameId,
          playing: stored.guid,
          resolved: guid,
          playCard: stored.cardId,
          leaseCard: cardId
        });
      }
      return stored;
    }
    if (guid === undefined || cardId === undefined) {
      // Only reachable if a Subtask ran this family without the parent resolving
      // a play — `buildRecipeTools` gates the family on the card and
      // `resolveRuntime` settles both together. Nothing here can recover:
      // minting a guid is exactly the power this family does not have.
      const missing = [
        guid === undefined ? "runtime.guid" : null,
        cardId === undefined ? "runtime.cardId" : null
      ].filter((field) => field !== null);
      throw new Error(
        `arc-game: no play was resolved for this subtask (missing ${missing.join(" and ")})`
      );
    }
    const session = joinSession(gameId, cardId, guid, runtime);
    await save(session);
    return session;
  };

  /**
   * True once this chunk has told the model where it is.
   *
   * The tool family is rebuilt per chunk (`buildRecipeTools` in the subagent
   * facet), so this closure variable *is* the chunk boundary — and a chunk
   * boundary is exactly where the model's context window was trimmed.
   */
  let oriented = false;

  /**
   * The last `arc_inspect` this chunk served — its arguments and the board they
   * were rendered from. A closure variable for the same reason `oriented` is one:
   * it must reset exactly where the model's context was trimmed.
   */
  let lastView: { key: string; gridHex: string | null } | null = null;

  /**
   * The orientation to prepend to this chunk's first tool result, and "" after.
   *
   * Completing a level emits progress, and progress ends the chunk, so the model
   * resumes every new level with its recent turns trimmed away. Leading its next
   * result with the board costs no game action and no extra turn — it rides on a
   * call it was making anyway — where re-inspecting to get its bearings costs a
   * turn out of the run's budget, once per level.
   *
   * `withBoard` is false for `arc_inspect`, whose view already *is* the board;
   * repeating it as shapes would say the same thing twice.
   */
  const orient = (session: ArcSession, withBoard: boolean): string => {
    if (oriented) return "";
    oriented = true;
    return withBoard
      ? `${describeState(session, `Playing ${gameId}.`)}\n`
      : `Playing ${gameId}. ${stateLine(session)}\n`;
  };

  const tools = {
    arc_act: tool({
      description:
        "Take one or more actions in the current game, in order. Only use actions listed in the latest available_actions. Returns one line per step naming what that action changed — which shapes moved and how far, which were repainted or appeared, and `0 cells changed` when the game refused it outright — then the net effect over the batch and the new level, state and available_actions. Batch the whole path you intend to walk: a batch runs to the end whatever happens, so the report tells you exactly which steps did nothing rather than stopping. Every step is a real action counted against the game's baseline, so batch a route you have reason to believe in, not a guess.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              action: z
                .number()
                .int()
                .min(1)
                .max(7)
                .describe(
                  "1=up 2=down 3=left 4=right 5=interact 6=click(x,y) 7=undo"
                ),
              x: z
                .number()
                .int()
                .min(0)
                .max(63)
                .optional()
                .describe("column, action 6 only"),
              y: z
                .number()
                .int()
                .min(0)
                .max(63)
                .optional()
                .describe("row, action 6 only")
            })
          )
          .min(1)
          .max(MAX_STEPS)
          .describe(
            `the actions to take in order, 1–${MAX_STEPS}; each is sent separately and reported separately`
          ),
        note: z
          .string()
          .max(2000)
          .optional()
          .describe("brief reasoning for this move or sequence")
      }),
      execute: async ({ steps, note }) => {
        // Acting immediately is right — the results below carry the board — but
        // this chunk's orientation goes out first, so the model is never acting
        // on a board it can no longer see.
        const session = await resume();
        const opening = orient(session, true);
        if (session.state === "WIN" || session.state === "GAME_OVER") {
          return (
            opening +
            `This play is over (state=${session.state}). ` +
            "Write your final report."
          );
        }

        // Reconcile a possibly-interrupted prior action (crash between send and record).
        let recovery = "";
        if (session.pendingAction) {
          recovery =
            "\n(A previous action may have been interrupted and not recorded; the board may have advanced.)";
          session.pendingAction = null;
        }

        // Detail per step is budgeted across the sequence, so a long batch cannot
        // flood the context: a single step shows plenty, eight show a little each.
        const cellCap = Math.max(3, Math.floor(24 / steps.length));
        const trace: string[] = [];
        let sent = 0;
        let stopped: string | null = null;

        // Where the batch left each shape — keyed by where that shape currently
        // is, see {@link trackTravel} — plus counts of the steps that did little.
        // All three exist for the net line: a model reading five per-step lines
        // should not have to add up its own position, and "4 of 5 steps did
        // nothing" is the sentence that would have told this play it was walking
        // into a wall.
        //
        // The two idle counts are kept apart because only one of them is evidence
        // of a refusal. `noChange` is the cell diff's own verdict and cannot be
        // argued with; `noMove` is a board that changed with nothing travelling
        // across it, which is a wall in a game you steer and an ordinary move in a
        // game you click. Folding the second into the first told a logged `ft09`
        // play that five clicks were "every one of them refused or blocked" when
        // four of them had each toggled a 36-cell block.
        const travels = new Map<string, ShapeTravel>();
        let noChange = 0;
        let noMove = 0;

        for (const [index, step] of steps.entries()) {
          const { action, x, y } = step;

          // Guard before sending: these are requests the API would reject or that
          // cannot mean anything, so spending an action on them is pure waste.
          //
          // An empty list is *unknown*, not *none* — a session rebuilt around a
          // resolved guid has not seen a frame yet. Guessing "nothing is legal"
          // there would deadlock the play, so the API is left to judge, and its
          // response fills the list in for every step after this one.
          if (
            session.availableActions.length > 0 &&
            !session.availableActions.includes(action)
          ) {
            stopped =
              `${actionName(action)} is not available ` +
              `(available: ${namedActions(session.availableActions)})`;
          } else if (action === 6 && (x === undefined || y === undefined)) {
            stopped = "click (action 6) requires x and y (0–63)";
          }
          if (stopped) {
            trace.push(remaining(steps.length, index, stopped));
            break;
          }

          // Write-ahead intent, then send, then record — the crash window is
          // between, and it stays per-step so a crash mid-sequence is recoverable
          // exactly as a crash mid-action always was.
          session.pendingAction = { action, x, y };
          await save(session);

          const { frame, cookies } = await client.act(
            { action, gameId: session.gameId, guid: session.guid, x, y, note },
            session.cookies
          );

          // Diff against the board as it was immediately BEFORE this step, so each
          // line attributes its change to the one action that caused it. That
          // attribution is what makes batching safe: without it the model would see
          // that the board changed but not which action changed it.
          //
          // Both diffs, always: the cell diff is the ground truth for "did anything
          // change at all", and the shape delta is the only one of the two that can
          // say a *wall* was hit on a board where something else ticks every turn.
          const before = board(session);
          const next = lastGrid(frame.frame);
          const diff = diffGrids(before, next, cellCap);
          const delta = diffShapes(before, next);
          const prevLevel = session.levelsCompleted;

          // `changed < 0` is the first frame — nothing to compare against, so it
          // is neither idle nor active.
          if (diff.changed === 0) noChange++;
          else if (diff.changed > 0 && delta?.moved.length === 0) noMove++;
          if (delta) trackTravel(travels, delta.moved);

          session.cookies = cookies;
          session.guid = frame.guid;
          session.state = frame.state;
          session.levelsCompleted = frame.levels_completed;
          session.availableActions = frame.available_actions;
          if (frame.win_levels) session.winLevels = frame.win_levels;
          session.lastGridHex = serializeGrid(next);
          session.actionsSent++;
          session.pendingAction = null;
          sent++;

          if (
            frame.levels_completed > prevLevel &&
            !session.levelsReported.includes(frame.levels_completed)
          ) {
            session.levelsReported.push(frame.levels_completed);
            emitProgress({
              // One play per execution, so the level alone identifies the note;
              // the gateway dedupes on this key.
              key: `arc:${session.gameId}:level:${frame.levels_completed}`,
              text:
                `ARC ${session.gameId}: reached level ${frame.levels_completed}` +
                `${session.winLevels ? `/${session.winLevels}` : ""} ` +
                `(${session.actionsSent} actions).`
            });
          }

          await save(session);
          trace.push(
            `${index + 1}. ${actionName(action, x, y)} → ${renderEffect(diff, delta)}`
          );

          // The play ended mid-sequence: anything after this would act on a
          // finished game.
          if (session.state === "WIN" || session.state === "GAME_OVER") {
            if (index + 1 < steps.length) {
              trace.push(
                remaining(
                  steps.length,
                  index + 1,
                  `state became ${session.state}`
                )
              );
            }
            break;
          }
        }

        const terminal =
          session.state === "WIN" || session.state === "GAME_OVER"
            ? "\nThis play is over — write your final report."
            : "";
        const header =
          steps.length === 1
            ? ""
            : `${steps.length} steps requested, ${sent} sent.\n`;
        return (
          opening +
          header +
          trace.join("\n") +
          renderNet(travels, sent, noChange, noMove) +
          "\n" +
          stateLine(session) +
          terminal +
          recovery
        );
      }
    }),

    arc_inspect: tool({
      description:
        "Look at the current board without taking a game action. Views: 'shapes' (every colored region with its row/column box, and for large sparse ones — walls, floors, frames — the columns they occupy in each band of rows; this is the map, and usually what you want), 'grid' (the whole 64×64 board, one character per cell with a legend and a column ruler; identical rows collapse, so it is cheaper than it sounds), 'region' (a labeled, ruled square around x,y — for fine detail, not for mapping), 'histogram' (how many cells of each color).",
      inputSchema: z.object({
        view: z.enum(["grid", "region", "histogram", "shapes"]),
        x: z.number().int().min(0).max(63).optional(),
        y: z.number().int().min(0).max(63).optional(),
        radius: z.number().int().min(1).max(20).optional()
      }),
      execute: async ({ view, x, y, radius }) => {
        const session = await resume();
        const grid = board(session);
        // Ahead of `orient`, so a chunk that opens on a boardless inspect has not
        // spent its one orientation on a message that cannot carry it: this
        // reply already says the board is unknown, and the next call — the first
        // `arc_act`, or an inspect once a frame has landed — orients instead.
        if (grid === null) {
          return (
            "No board received yet for this play — the frame arrives with your " +
            "first `arc_act`, so take one action and inspect after it."
          );
        }
        const opening = orient(session, false);

        // The same view of a board nothing has touched, again. Redrawing it
        // re-answers a question already answered and teaches nothing, so say what
        // is actually true instead. Scoped to this chunk
        // by `lastView` being a closure variable: across a chunk boundary the
        // earlier render has been trimmed out of context, and pointing at a view
        // the model can no longer see would be worse than repeating it.
        const key = JSON.stringify({ view, x, y, radius });
        if (
          lastView !== null &&
          lastView.key === key &&
          lastView.gridHex === session.lastGridHex
        ) {
          return (
            opening +
            `Unchanged since your last \`${view}\` view — not one cell of the ` +
            "board has changed since, so what you saw then still holds. Act on " +
            "it rather than looking again."
          );
        }
        lastView = { key, gridHex: session.lastGridHex };

        const rendered = ((): string => {
          switch (view) {
            case "grid":
              return renderGrid(grid);
            case "region":
              if (x === undefined || y === undefined)
                return "region view needs x and y.";
              return renderRegion(grid, y, x, radius);
            case "histogram":
              return colorHistogram(grid)
                .map((h) => `${colorName(h.color)}: ${h.count} cells`)
                .join("\n");
            case "shapes":
              return renderShapes(grid);
          }
        })();
        return opening + rendered;
      }
    })
  };

  // No `abort` hook: the only external state this family used to hold was the
  // scorecard, and nothing closes one any more — the API retires an idle card on
  // its own. A play left unfinished is simply a run the card records as
  // incomplete.
  return { tools };
}

/**
 * A session file for the resolved play, built from whatever the parent could
 * supply.
 *
 * With `runtime.frame` — this chunk is the one that opened the play — the state
 * is complete and indistinguishable from what a local RESET used to produce.
 * Without it the play already existed, so everything a frame carries is unknown:
 * empty `availableActions` and a null board, both filled in by the first ACTION.
 * Only `guid` matters for correctness, and it always comes from the parent.
 */
function joinSession(
  gameId: string,
  cardId: string,
  guid: string,
  runtime: { cookies?: Record<string, string>; frame?: FrameResponse }
): ArcSession {
  const frame = runtime.frame;
  return {
    cardId,
    gameId,
    guid,
    cookies: runtime.cookies ?? {},
    winLevels: frame?.win_levels ?? 0,
    levelsCompleted: frame?.levels_completed ?? 0,
    state: frame?.state ?? "NOT_FINISHED",
    availableActions: frame?.available_actions ?? [],
    actionsSent: 0,
    levelsReported: [],
    lastGridHex: frame ? serializeGrid(lastGrid(frame.frame)) : null,
    pendingAction: null
  };
}

/** Human names for the seven actions, so results read as moves not opcodes. */
const ACTION_NAMES: Record<number, string> = {
  1: "up",
  2: "down",
  3: "left",
  4: "right",
  5: "interact",
  6: "click",
  7: "undo"
};

/** How many actions one `arc_act` call may carry. */
const MAX_STEPS = 8;

function actionName(action: number, x?: number, y?: number): string {
  const name = ACTION_NAMES[action] ?? `action ${action}`;
  return action === 6 && x !== undefined && y !== undefined
    ? `${name}(${x},${y})`
    : name;
}

/**
 * `3=left, 6=click` — the legal actions as number **and** name.
 *
 * The number alone is ambiguous in exactly the case that matters most. A
 * click-only game offers `[6]`, and `available actions: 6` reads as *six actions
 * are available* at least as naturally as it reads as *action 6 is available* —
 * one of the two lines every result of a logged `ft09` play ended on. Naming them
 * costs a few tokens and cannot be misread, and the number stays because the
 * number is what `arc_act` takes.
 */
function namedActions(actions: number[]): string {
  if (actions.length === 0) return "none";
  return actions
    .map((action) => {
      const name = ACTION_NAMES[action];
      return name === undefined ? String(action) : `${action}=${name}`;
    })
    .join(", ");
}

/** "5-8. not sent: <why>" — an aborted tail, named so it is never assumed to have run. */
function remaining(total: number, from: number, why: string): string {
  const label = from + 1 === total ? `${total}.` : `${from + 1}-${total}.`;
  return `${label} not sent: ${why}`;
}

/**
 * What one action did, in the most informative register the frames support.
 *
 * Shapes first, because "nothing moved" and "the orange 5×5 went right 5" are the
 * two answers a player needs and neither is recoverable from a cell count. The
 * cell diff takes over whenever the shape view declines — no pairing at all, or a
 * repaint of everything — so a board this heuristic cannot read is described as
 * fully as it always was, never as a confident "nothing moved".
 */
function renderEffect(diff: GridDiff, delta: ShapeDelta | null): string {
  if (diff.changed < 0) return "first frame";
  // Nothing changed anywhere, counters included: worth saying in its own words,
  // since it means the game refused the action outright rather than absorbing it.
  if (diff.changed === 0) return "0 cells changed (no effect at all)";
  const shapes = delta === null ? null : renderShapeDelta(delta);
  return shapes ?? renderDiff(diff);
}

/**
 * Where a whole batch left things: net travel per shape, then how many of its
 * steps did nothing and how many moved nothing.
 *
 * The idle counts are what this rendering exists for. A batch is not stopped when
 * a step does nothing — different games mean different things by it, and guessing
 * would throw away legitimate sequences — so the batch runs to the end and is
 * *told on*. "4 of 5 steps changed not one cell" is a sentence a model cannot
 * misread; four consecutive fuel-bar diffs, as these logs show, is one it can.
 *
 * They are reported as two separate sentences because they carry different
 * weight. A step that changed not one cell was refused, and this line says so. A
 * step that changed the board without moving a shape is stated as exactly that
 * and no more — reading it as a wall is a judgement about the game's rules, which
 * belongs to the model and the soul, not to a renderer that has never been told
 * whether this game moves anything at all.
 */
function renderNet(
  travels: Map<string, ShapeTravel>,
  sent: number,
  noChange: number,
  noMove: number
): string {
  if (sent < 2) return "";
  const parts = [...travels.values()]
    .sort((a, b) => b.shape.size - a.shape.size)
    .slice(0, NET_SHAPES)
    .map(renderTravel);
  const moved =
    parts.length === 0 ? "no shape travelled" : `net: ${parts.join("; ")}`;
  const idle: string[] = [];
  if (noChange > 0) {
    idle.push(
      `${noChange} of ${sent} step(s) changed not one cell` +
        (noChange === sent ? " (every one of them was refused or blocked)" : "")
    );
  }
  if (noMove > 0) {
    idle.push(
      `${noMove} of ${sent} step(s) changed the board without moving a shape`
    );
  }
  return `\n${moved}${idle.length === 0 ? "" : ` — ${idle.join("; ")}`}.`;
}

/** How many shapes the net line names before it stops. */
const NET_SHAPES = 3;

/**
 * What one action did as cells: how much changed, where, and which colors.
 *
 * The fallback register — see {@link renderEffect}, which owns the "first frame"
 * and "nothing changed" cases so this one only ever describes a real change.
 */
function renderDiff(diff: GridDiff): string {
  const where = diff.box === null ? "" : `, ${describeBox(diff.box)}`;
  const examples =
    diff.cells.length === 0
      ? ""
      : ` (${diff.cells.length < diff.changed ? "e.g. " : ""}` +
        `${diff.cells.map(describeCell).join(", ")})`;
  return `${diff.changed} cells changed${where}${examples}`;
}

/**
 * Level / state / legal-actions — the board-independent status, one line.
 *
 * A session that joined a play without a frame knows none of it, and saying
 * `level 0 | state NOT_FINISHED | available actions: none` there would state
 * three placeholders as facts — the last of which reads as "you may do nothing".
 * Such a session is reported as what it is instead.
 */
function stateLine(session: ArcSession): string {
  if (session.availableActions.length === 0 && session.lastGridHex === null) {
    return "level, state and available actions arrive with your next action's result";
  }
  return [
    `level ${session.levelsCompleted}${session.winLevels ? `/${session.winLevels}` : ""}`,
    `state ${session.state}`,
    `available actions: ${namedActions(session.availableActions)}`
  ].join(" | ");
}

/**
 * Full summary used when `arc_act` joins the play, including where every shape
 * is. Orienting the model here is what keeps joining free: it never costs a turn
 * of its own, and the model is not left acting blind.
 */
function describeState(session: ArcSession, prefix: string): string {
  const grid =
    session.lastGridHex === null ? null : parseGrid(session.lastGridHex);
  const shapes = grid === null ? "" : `\nBoard:\n${renderShapes(grid)}`;
  return `${prefix} ${stateLine(session)}${shapes}`;
}
