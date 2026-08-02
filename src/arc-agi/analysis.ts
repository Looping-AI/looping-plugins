/**
 * Pure grid-analysis helpers for ARC-AGI-3 frames. No I/O — every function is a
 * deterministic transform of a 64×64 grid (color values 0–15), unit-tested in
 * isolation. The tool family calls these to render compact observations for the
 * model instead of dumping raw grids into context.
 *
 * Two rendering registers, deliberately kept apart:
 *
 * - **Prose** (diffs, shapes, histogram) names its colors: `blue->white` carries
 *   structure a bare `9->0` hides, and no tool input ever takes a color, so the
 *   index is never needed as an argument.
 * - **Grids** ({@link renderGrid}, {@link renderRegion}) stay one character per
 *   cell and carry a {@link renderLegend} instead. One char per cell is the only
 *   reason a 64×64 board is legible at all; a named cell would be unreadable and
 *   cost ~50× the tokens.
 */

/**
 * The ARC-AGI-3 16-color palette, index → name.
 *
 * Source: `agents/templates/multimodal.py` in `arcprize/ARC-AGI-3-Agents` (ARC
 * Prize's own agent template), which maps these indices to RGBA for multimodal
 * play. Taken from there rather than assumed, because **ARC-AGI-3's palette is
 * unrelated to ARC-AGI-1's**: here 0 is *white* and 1–5 are a greyscale ramp,
 * where the familiar ARC-AGI-1 mapping would say 0=black, 1=blue, 2=red. Note
 * that same repo carries a second, contradictory `COLOR_PALETTE` in
 * `langgraph_thinking/vision.py` — that one is incomplete and does not match the
 * engine; do not use it.
 *
 * The pairs matter to a player: 6/7 and 9/10 and 2/3 are related shades, which
 * the names convey and the indices do not.
 */
export const COLOR_NAMES = [
  "white", // 0  #FFFFFF
  "off-white", // 1  #CCCCCC
  "neutral-light", // 2  #999999
  "neutral", // 3  #666666
  "off-black", // 4  #333333
  "black", // 5  #000000
  "magenta", // 6  #E53AA3
  "magenta-light", // 7  #FF7BCC
  "red", // 8  #F93C31
  "blue", // 9  #1E93FF
  "blue-light", // 10 #88D8F1
  "yellow", // 11 #FFDC00
  "orange", // 12 #FF851B
  "maroon", // 13 #921231
  "green", // 14 #4FCC30
  "purple" // 15 #A356D6
] as const;

/** Color 0 (white) — treated as background by {@link locateComponents}. */
export const BACKGROUND_COLOR = 0;

/**
 * Name of a color index. An out-of-range value renders as `color <n>` rather
 * than throwing: a malformed frame should degrade the wording, not fail the turn.
 */
export function colorName(color: number): string {
  return COLOR_NAMES[color] ?? `color ${color}`;
}

/** The single character a color occupies in a grid render. */
function colorChar(color: number): string {
  return color >= 0 && color < 16 ? color.toString(16) : "?";
}

/** The current board: the LAST grid of a frame response's grid array. */
export function lastGrid(frame: number[][][]): number[][] {
  return frame.length === 0 ? [] : frame[frame.length - 1];
}

/**
 * Bare hex rows, one char per cell, no labels — the round-trippable **storage**
 * form, paired with {@link parseGrid}. Deliberately distinct from
 * {@link renderGrid}, which adds a legend, rulers and row collapsing and so
 * cannot be parsed back.
 */
export function serializeGrid(grid: number[][]): string {
  return grid.map((row) => row.map(colorChar).join("")).join("\n");
}

/** Inverse of {@link serializeGrid}. */
export function parseGrid(hex: string): number[][] {
  if (hex === "") return [];
  return hex
    .split("\n")
    .map((line) => [...line].map((ch) => parseInt(ch, 16) || 0));
}

export interface CellChange {
  row: number;
  col: number;
  from: number;
  to: number;
}

/** The rectangle enclosing a set of cells. */
export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface GridDiff {
  changed: number;
  /** Up to `cap` changed cells (for a compact summary of a large change). */
  cells: CellChange[];
  /** Rectangle enclosing ALL changed cells (not just the capped ones). */
  box: Box | null;
}

/** Cell-by-cell diff of two grids. `cap` bounds the returned cell list. */
export function diffGrids(
  a: number[][] | null,
  b: number[][],
  cap = 12
): GridDiff {
  if (a === null) return { changed: -1, cells: [], box: null };
  let changed = 0;
  const cells: CellChange[] = [];
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (let r = 0; r < b.length; r++) {
    const rowB = b[r];
    const rowA = a[r] ?? [];
    for (let c = 0; c < rowB.length; c++) {
      if (rowA[c] !== rowB[c]) {
        changed++;
        // The box spans every change, so it stays informative even when the
        // cell list is capped away to nothing.
        if (r < top) top = r;
        if (r > bottom) bottom = r;
        if (c < left) left = c;
        if (c > right) right = c;
        if (cells.length < cap) {
          cells.push({ row: r, col: c, from: rowA[c] ?? -1, to: rowB[c] });
        }
      }
    }
  }
  return {
    changed,
    cells,
    box: changed === 0 ? null : { top, left, bottom, right }
  };
}

/** `rows 3-5, cols 10-12` — or a single row/col rendered without the range. */
export function describeBox(box: Box): string {
  const rows =
    box.top === box.bottom ? `row ${box.top}` : `rows ${box.top}-${box.bottom}`;
  const cols =
    box.left === box.right
      ? `col ${box.left}`
      : `cols ${box.left}-${box.right}`;
  return `${rows}, ${cols}`;
}

/** `(3,10) blue->white` — one changed cell, colors named. */
export function describeCell(cell: CellChange): string {
  const from = cell.from < 0 ? "off-grid" : colorName(cell.from);
  return `(${cell.row},${cell.col}) ${from}->${colorName(cell.to)}`;
}

/** Count of each color present, descending by count. */
export function colorHistogram(
  grid: number[][]
): Array<{ color: number; count: number }> {
  const counts = new Map<number, number>();
  for (const row of grid) {
    for (const c of row) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((x, y) => y.count - x.count);
}

/** One 4-connected same-color region, with where it sits and how big it is. */
export interface Component extends Box {
  color: number;
  size: number;
}

export interface ComponentSummary {
  color: number;
  components: number;
  largest: number;
}

/**
 * Every 4-connected same-color region, with its bounding box, largest first.
 * Skips {@link BACKGROUND_COLOR}.
 *
 * The bounding boxes are the point: a rollup of counts alone tells the model
 * *that* there are three shapes and never *where* they are, which leaves dumping
 * the whole 64×64 grid as the only way to locate anything. The flood fill has to
 * visit every cell regardless, so tracking min/max row/col is free.
 */
export function locateComponents(grid: number[][]): Component[] {
  const rows = grid.length;
  const cols = rows === 0 ? 0 : grid[0].length;
  const seen = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  );
  const found: Component[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = grid[r][c];
      if (color === BACKGROUND_COLOR || seen[r][c]) continue;
      // Flood-fill this component (iterative, 4-connectivity).
      let size = 0;
      let top = r;
      let left = c;
      let bottom = r;
      let right = c;
      const stack: Array<[number, number]> = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        size++;
        if (cr < top) top = cr;
        if (cr > bottom) bottom = cr;
        if (cc < left) left = cc;
        if (cc > right) right = cc;
        const neighbors: Array<[number, number]> = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1]
        ];
        for (const [nr, nc] of neighbors) {
          if (
            nr >= 0 &&
            nr < rows &&
            nc >= 0 &&
            nc < cols &&
            !seen[nr][nc] &&
            grid[nr][nc] === color
          ) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      found.push({ color, size, top, left, bottom, right });
    }
  }

  return found.sort((x, y) => y.size - x.size);
}

/**
 * Summarize components per color: how many, and the largest. Derived from
 * {@link locateComponents} so only one flood fill ever runs.
 */
export function connectedComponents(grid: number[][]): ComponentSummary[] {
  const perColor = new Map<number, { components: number; largest: number }>();
  for (const comp of locateComponents(grid)) {
    const entry = perColor.get(comp.color) ?? { components: 0, largest: 0 };
    entry.components++;
    entry.largest = Math.max(entry.largest, comp.size);
    perColor.set(comp.color, entry);
  }
  return [...perColor.entries()]
    .map(([color, v]) => ({
      color,
      components: v.components,
      largest: v.largest
    }))
    .sort((x, y) => y.components - x.components);
}

/**
 * How much of its bounding box a region actually occupies, 0–1.
 *
 * Boxes are well formed by construction wherever this is used: every caller
 * passes either a {@link Component} from {@link locateComponents} or a
 * {@link unionBox} of those, and a flood fill cannot produce `bottom < top`. So
 * `area` is always at least 1, and the zero-area branch below is unreachable —
 * kept only so a malformed box degrades to 0 instead of dividing by zero.
 *
 * The result is deliberately **not** clamped into 0–1. An out-of-range value here
 * could only mean a caller broke that invariant, and the way to learn that is a
 * region classified absurdly, not a number quietly corrected into looking sane.
 */
export function fillRatio(box: Box, size: number): number {
  const area = (box.bottom - box.top + 1) * (box.right - box.left + 1);
  return area === 0 ? 0 : size / area;
}

/**
 * The rectangle enclosing several boxes. Takes a **non-empty** list — the reduce
 * has no seed, since there is no identity box to start from, so `[]` throws. Its
 * one caller filters components for a color it is already holding one of, and so
 * cannot pass an empty list.
 */
function unionBox(boxes: Box[]): Box {
  return boxes.reduce((a, b) => ({
    top: Math.min(a.top, b.top),
    left: Math.min(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.max(a.right, b.right)
  }));
}

/**
 * A band of consecutive rows in which one color occupies exactly the same
 * columns, and the column runs it occupies there.
 */
export interface SpanBand extends Pick<Box, "top" | "bottom"> {
  /** Inclusive `[first, last]` column runs, left to right. */
  cols: Array<[number, number]>;
  /** Runs the cap dropped, so a truncated band never reads as a complete one. */
  hidden: number;
}

/** Runs of `color` in one row, as inclusive `[first, last]` column pairs. */
function rowRuns(row: number[], color: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let c = 0; c <= row.length; c++) {
    const hit = c < row.length && row[c] === color;
    if (hit && start < 0) start = c;
    else if (!hit && start >= 0) {
      runs.push([start, c - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Where one color sits, row band by row band — the view a bounding box cannot
 * give for a maze, a frame, or any other structure that is mostly holes.
 *
 * Keyed by **color rather than component** on purpose. A wall that a doorway
 * splits into three components is one thing to a player, and three boxes describe
 * it worse than one span list does; the flood fill's notion of connectedness is an
 * implementation detail here, not something the model should have to reassemble.
 *
 * Rows whose runs are identical collapse into one band, the same trick
 * {@link renderGrid} uses — and for the same reason, since ARC boards are banded.
 * On a real 64×64 maze it turns 64 rows into ~20 bands.
 */
export function colorSpans(grid: number[][], color: number): SpanBand[] {
  const perRow = grid.map((row) => rowRuns(row, color));
  const keys = perRow.map((runs) =>
    runs.map(([a, b]) => `${a}:${b}`).join(" ")
  );
  const bands: SpanBand[] = [];
  for (let r = 0; r < perRow.length;) {
    let end = r;
    while (end + 1 < perRow.length && keys[end + 1] === keys[r]) end++;
    if (perRow[r].length > 0) {
      bands.push({
        top: r,
        bottom: end,
        cols: perRow[r].slice(0, MAX_SPAN_RUNS),
        hidden: Math.max(0, perRow[r].length - MAX_SPAN_RUNS)
      });
    }
    r = end + 1;
  }
  return bands;
}

/**
 * Runs named per band, one line each. Both caps exist to bound the render on a
 * board this encoding suits badly — a checkerboard is 32 runs in every one of 64
 * rows — and both announce themselves, so a clipped view is never mistaken for
 * the whole of one.
 */
export function renderSpans(bands: SpanBand[]): string {
  const lines = bands.slice(0, MAX_SPAN_BANDS).map((band) => {
    const rows =
      band.top === band.bottom
        ? `row ${band.top}`
        : `rows ${band.top}-${band.bottom}`;
    const cols = band.cols
      .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
      .join(", ");
    const more = band.hidden === 0 ? "" : `, +${band.hidden} more run(s)`;
    return `  ${rows}: cols ${cols}${more}`;
  });
  if (bands.length > MAX_SPAN_BANDS) {
    lines.push(`  +${bands.length - MAX_SPAN_BANDS} more row band(s)`);
  }
  return lines.join("\n");
}

/** Column runs named per band before {@link renderSpans} stops. */
const MAX_SPAN_RUNS = 8;

/**
 * Row bands named per color before {@link renderSpans} stops. Set from the real
 * `ls20` board, whose floor needs 25: a cap that clips a terrain layer three
 * quarters of the way down the board hides exactly the part a play reaches last.
 */
const MAX_SPAN_BANDS = 28;

/**
 * A region this big whose box it fills less than {@link SPRAWL_MAX_FILL} of is
 * described by spans instead. Both gates matter: fill alone would spend lines on
 * every small hollow glyph (a 3×3 donut fills 8/9 of its box, a 6×6 outline just
 * over half), and size alone would spend them on solid blocks that a box already
 * describes exactly.
 */
const SPRAWL_MIN_CELLS = 64;
const SPRAWL_MAX_FILL = 0.7;

/** How many colors {@link renderShapes} will describe by spans. */
const SPRAWL_COLORS = 3;

/**
 * Named regions with their positions, largest first — the locational view.
 *
 * A bounding box describes a region only when the region roughly fills it. That
 * holds for the movable pieces and fails for exactly the two things a route
 * depends on: on a real `ls20` board the model was told `off-black: rows 0-63,
 * cols 0-63 (2129 cells)` for the whole maze and `neutral: rows 5-54, cols 9-58
 * (1354 cells)` for the whole floor, both a shade over half-filled. The first says
 * nothing; the second is worse, asserting a 50×50 open arena of which 46% is wall.
 * Blind to both, the play read its route off the boxes and walked into walls, then
 * spent a dozen turns rebuilding the maze through 11×11 `region` peepholes.
 *
 * So a region that sprawls is rendered as {@link colorSpans} instead — every row
 * band and the columns it occupies, which is the same fact at a resolution that
 * can be acted on. Sprawl is judged per color and the whole color is then spanned
 * at once, so a wall and the doorway splitting it read as one terrain layer rather
 * than as two boxes that overlap everything.
 *
 * `cap` bounds the boxed list; anything beyond it is reported as a count so the
 * model knows the view is truncated rather than complete.
 */
export function renderShapes(grid: number[][], cap = 20): string {
  const comps = locateComponents(grid);
  if (comps.length === 0) return "no shapes (board is entirely white).";

  // Judged on the largest component of each color, walking largest-first: a color
  // whose biggest region is a sprawl is a terrain layer whatever its offcuts do.
  const sprawling = new Set<number>();
  const judged = new Set<number>();
  for (const s of comps) {
    if (judged.has(s.color)) continue;
    judged.add(s.color);
    if (sprawling.size >= SPRAWL_COLORS) break;
    if (s.size >= SPRAWL_MIN_CELLS && fillRatio(s, s.size) < SPRAWL_MAX_FILL) {
      sprawling.add(s.color);
    }
  }

  const lines: string[] = [];
  const spanned = new Set<number>();
  let boxed = 0;
  for (const s of comps) {
    if (sprawling.has(s.color)) {
      if (spanned.has(s.color)) continue;
      spanned.add(s.color);
      const parts = comps.filter((c) => c.color === s.color);
      const cells = parts.reduce((n, c) => n + c.size, 0);
      const box = unionBox(parts);
      const pct = Math.round(fillRatio(box, cells) * 100);
      lines.push(
        `${colorName(s.color)}: ${cells} cells in ${parts.length} region(s), ` +
          `${pct}% of ${describeBox(box)} — too sparse for a box, so by row:`
      );
      lines.push(renderSpans(colorSpans(grid, s.color)));
      continue;
    }
    if (boxed >= cap) continue;
    boxed++;
    lines.push(
      `${colorName(s.color)}: ${describeBox(s)} (${s.size} cell${s.size === 1 ? "" : "s"})`
    );
  }

  const rest = comps.filter((c) => !sprawling.has(c.color)).length - boxed;
  if (rest > 0) lines.push(`+${rest} more shape(s), smaller than these.`);
  return lines.join("\n");
}

/**
 * What became of one shape between two frames.
 *
 * The four cases are kept apart because only **one** of them answers the question
 * an action asks — did anything move? Folding a counter ticking down into the
 * same bucket as a step taken is exactly the mistake {@link diffGrids} cannot
 * help making: in `ls20` every action shrinks a fuel bar by four cells, so a move
 * into a wall reports "4 cells changed" and reads, to a model told that `0 cells
 * changed` means blocked, as a move that worked. It spent eleven actions on that
 * misreading. A wall is `moved: []` here, whatever else on the board ticked.
 */
export type ShapeChange =
  | {
      kind: "moved";
      /** Where it was, with its color and cell count. */
      from: Component;
      /** Where it is now — same color and same cell count, by construction. */
      to: Box;
      dRow: number;
      dCol: number;
    }
  /** Same color, still overlapping, different cell count — a bar, a trail, a fill. */
  | { kind: "resized"; from: Component; to: Component }
  /**
   * Same footprint and same cell count, a different color — a repaint in place,
   * which is what a click game does instead of moving anything.
   */
  | { kind: "recolored"; from: Component; to: Component }
  | { kind: "appeared"; shape: Component }
  | { kind: "gone"; shape: Component };

export type MovedShape = Extract<ShapeChange, { kind: "moved" }>;

/**
 * Two frames' shapes, matched. Split rather than one list because both consumers
 * want the split: the renderer leads with movement, and a caller summing a batch
 * accumulates only the moves.
 */
export interface ShapeDelta {
  /** Every shape that travelled, largest first. */
  moved: MovedShape[];
  /** Resized, appeared and disappeared shapes, largest first. */
  other: ShapeChange[];
}

/**
 * Above this many changed shapes, a frame is a repaint (a level change, a
 * transform) rather than a board where things moved, and naming twenty shapes
 * that all "appeared" says less than the cell diff does. {@link renderShapeDelta}
 * declines, and its caller falls back.
 */
export const MAX_SHAPE_CHANGES = 10;

/** Manhattan distance between two boxes' top-left corners. */
const originDistance = (a: Box, b: Box): number =>
  Math.abs(a.top - b.top) + Math.abs(a.left - b.left);

/**
 * Pair each `from` with its nearest unclaimed `to`, closest pair first — a greedy
 * assignment, which is right here because the alternative (a full optimal
 * matching) buys nothing: within one group every candidate is the same color and
 * the same size, and one action moves things by a few cells, so the nearest
 * candidate is the same object in all but contrived cases.
 */
function pairByProximity<T extends Box>(
  from: T[],
  to: T[]
): { pairs: Array<[T, T]>; unpairedFrom: T[]; unpairedTo: T[] } {
  const candidates: Array<{ a: number; b: number; d: number }> = [];
  for (const [a, fromShape] of from.entries()) {
    for (const [b, toShape] of to.entries()) {
      candidates.push({ a, b, d: originDistance(fromShape, toShape) });
    }
  }
  candidates.sort((x, y) => x.d - y.d);

  const claimedFrom = new Set<number>();
  const claimedTo = new Set<number>();
  const pairs: Array<[T, T]> = [];
  for (const { a, b } of candidates) {
    if (claimedFrom.has(a) || claimedTo.has(b)) continue;
    claimedFrom.add(a);
    claimedTo.add(b);
    pairs.push([from[a], to[b]]);
  }
  return {
    pairs,
    unpairedFrom: from.filter((_, i) => !claimedFrom.has(i)),
    unpairedTo: to.filter((_, i) => !claimedTo.has(i))
  };
}

/** Group shapes under a key, preserving each group's input order. */
function groupShapes(
  shapes: Component[],
  key: (s: Component) => string
): Map<string, Component[]> {
  const groups = new Map<string, Component[]>();
  for (const shape of shapes) {
    const k = key(shape);
    const group = groups.get(k);
    if (group) group.push(shape);
    else groups.set(k, [shape]);
  }
  return groups;
}

/**
 * Match the shapes of two frames: what moved, what changed size, what came and
 * went. Null when there is no earlier frame to compare against.
 *
 * Three passes, and the order is the whole design. Color **and** cell count
 * first, because a rigid object that travelled keeps both — that pass is what
 * finds a move, and its pairs are never reconsidered. Color alone second, over
 * what is left, which is what a bar losing cells or a trail growing looks like.
 * **Footprint** alone last, over what neither pass claimed, which is a shape that
 * changed color without moving — see {@link matchRepaints}.
 */
export function diffShapes(
  before: number[][] | null,
  after: number[][]
): ShapeDelta | null {
  if (before === null) return null;
  return matchShapes(locateComponents(before), locateComponents(after));
}

/** {@link diffShapes} over already-located components. Exported for tests. */
export function matchShapes(
  before: Component[],
  after: Component[]
): ShapeDelta {
  const moved: MovedShape[] = [];
  const other: ShapeChange[] = [];
  const leftFrom: Component[] = [];
  const leftTo: Component[] = [];

  const rigid = (s: Component): string => `${s.color}:${s.size}`;
  const beforeGroups = groupShapes(before, rigid);
  const afterGroups = groupShapes(after, rigid);
  for (const key of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const result = pairByProximity(
      beforeGroups.get(key) ?? [],
      afterGroups.get(key) ?? []
    );
    for (const [from, to] of result.pairs) {
      // Same color, same size, same corner: either it did not move, or it turned
      // in place. Both are silence here — a turn shows up in the cell diff, which
      // is what the caller falls back to when this delta explains nothing.
      if (from.top === to.top && from.left === to.left) continue;
      moved.push({
        kind: "moved",
        from,
        to,
        dRow: to.top - from.top,
        dCol: to.left - from.left
      });
    }
    leftFrom.push(...result.unpairedFrom);
    leftTo.push(...result.unpairedTo);
  }

  const byColor = (s: Component): string => String(s.color);
  const colorBefore = groupShapes(leftFrom, byColor);
  const colorAfter = groupShapes(leftTo, byColor);
  const gone: Component[] = [];
  const appeared: Component[] = [];
  for (const key of new Set([...colorBefore.keys(), ...colorAfter.keys()])) {
    const result = pairByProximity(
      colorBefore.get(key) ?? [],
      colorAfter.get(key) ?? []
    );
    for (const [from, to] of result.pairs) {
      other.push({ kind: "resized", from, to });
    }
    gone.push(...result.unpairedFrom);
    appeared.push(...result.unpairedTo);
  }
  other.push(...matchRepaints(gone, appeared));

  moved.sort((x, y) => y.from.size - x.from.size);
  other.sort((x, y) => shapeOf(y).size - shapeOf(x).size);
  return { moved, other };
}

/**
 * Pair off the shapes neither earlier pass claimed, by **footprint**: one that
 * vanished and one that arrived on the same box with the same cell count are one
 * shape repainted, not two events.
 *
 * A click game is the case this exists for. Nothing on such a board ever travels,
 * so both earlier passes — which pair within a color — leave every changed block
 * as a `gone` and an `appeared` at the same coordinates, and a whole play reads as
 * things vanishing and other things materializing where they stood. The logged
 * `ft09` play was told `blue 6×6 at rows 36-41, cols 36-41 is gone; red 6×6
 * appeared at rows 36-41, cols 36-41` twenty times and had to work out for itself,
 * across several turns, that a click toggles a block's color.
 *
 * Box and size together are strong evidence and not proof — two different shapes
 * can share a bounding box and a cell count without sharing a cell — but the
 * claim made from them is only that those cells changed color, which is true
 * either way. Colors necessarily differ: same-color leftovers were already paired
 * by {@link pairByProximity}, which leaves one side of each color empty.
 */
function matchRepaints(
  gone: Component[],
  appeared: Component[]
): ShapeChange[] {
  const footprint = (s: Component): string =>
    `${s.top},${s.left},${s.bottom},${s.right}:${s.size}`;
  const unclaimed = groupShapes(gone, footprint);
  const changes: ShapeChange[] = [];
  for (const shape of appeared) {
    const from = unclaimed.get(footprint(shape))?.shift();
    changes.push(
      from === undefined
        ? { kind: "appeared", shape }
        : { kind: "recolored", from, to: shape }
    );
  }
  for (const leftover of unclaimed.values()) {
    for (const shape of leftover) changes.push({ kind: "gone", shape });
  }
  return changes;
}

/** The component a change is about, whichever field carries it. */
function shapeOf(change: ShapeChange): Component {
  return change.kind === "appeared" || change.kind === "gone"
    ? change.shape
    : change.from;
}

/** `orange 2×5` — a shape's color and how much board it spans. */
function shapeLabel(s: Component): string {
  return `${colorName(s.color)} ${s.bottom - s.top + 1}×${s.right - s.left + 1}`;
}

/** `down 5, left 10` — a displacement in board directions, zero terms dropped. */
export function describeShift(dRow: number, dCol: number): string {
  const parts: string[] = [];
  if (dRow !== 0) parts.push(`${dRow > 0 ? "down" : "up"} ${Math.abs(dRow)}`);
  if (dCol !== 0)
    parts.push(`${dCol > 0 ? "right" : "left"} ${Math.abs(dCol)}`);
  return parts.length === 0 ? "no shift" : parts.join(", ");
}

/** Destination of a move, spelling out only the axis that changed. */
function describeDestination(change: MovedShape): string {
  if (change.dCol === 0) return `rows ${change.to.top}-${change.to.bottom}`;
  if (change.dRow === 0) return `cols ${change.to.left}-${change.to.right}`;
  return describeBox(change.to);
}

/**
 * One action's effect as movement: `nothing moved` when the board's objects
 * stayed put, whatever a counter did alongside them.
 *
 * That phrase is spent carefully, because the soul teaches it as the signal for
 * *blocked or refused*: it leads a step only when everything else the delta holds
 * is a {@link ShapeChange} of kind `resized`, which is a counter or a bar doing
 * its own bookkeeping. A step that repainted a block, or made one appear, changed
 * the board — no object travelled, and saying so as `nothing moved` told a logged
 * `ft09` play that twenty clicks which each toggled a 36-cell block had been
 * refused.
 *
 * Null means *this view has nothing to say* — either no shape can be paired
 * across the frames, or so many changed that they are a repaint
 * ({@link MAX_SHAPE_CHANGES}). Both leave the cell diff as the better witness, so
 * the caller renders that instead rather than printing a confident "nothing
 * moved" over a board that changed completely.
 */
export function renderShapeDelta(delta: ShapeDelta, cap = 6): string | null {
  const total = delta.moved.length + delta.other.length;
  if (total === 0 || total > MAX_SHAPE_CHANGES) return null;

  const lines: string[] = [];
  for (const change of delta.moved.slice(0, cap)) {
    lines.push(
      `${shapeLabel(change.from)} ${describeBox(change.from)} → ` +
        `${describeDestination(change)} (${describeShift(change.dRow, change.dCol)})`
    );
  }
  if (delta.moved.length === 0) {
    lines.push(
      delta.other.every((change) => change.kind === "resized")
        ? "nothing moved"
        : "no shape travelled, but the board changed"
    );
  }

  const room = Math.max(0, cap - lines.length);
  for (const change of delta.other.slice(0, room)) {
    switch (change.kind) {
      case "resized":
        lines.push(
          `${colorName(change.from.color)} ${describeBox(change.from)} → ` +
            `${describeBox(change.to)} (${change.from.size}→${change.to.size} cells)`
        );
        break;
      case "recolored":
        lines.push(
          `${shapeLabel(change.from)} at ${describeBox(change.from)} ` +
            `turned ${colorName(change.to.color)}`
        );
        break;
      case "appeared":
        lines.push(
          `${shapeLabel(change.shape)} appeared at ${describeBox(change.shape)}`
        );
        break;
      case "gone":
        lines.push(
          `${shapeLabel(change.shape)} at ${describeBox(change.shape)} is gone`
        );
        break;
    }
  }
  const shown =
    Math.min(delta.moved.length, cap) + Math.min(delta.other.length, room);
  if (total > shown) lines.push(`+${total - shown} more change(s)`);
  return lines.join("; ");
}

/** Where one shape ended up over a whole batch, and how many steps took it there. */
export interface ShapeTravel {
  shape: Component;
  dRow: number;
  dCol: number;
  /** Steps in which this shape moved at all. */
  moves: number;
}

/**
 * A shape's identity within a batch: what it is, and where it sits right now.
 * The box is passed apart from the color and cell count because a move's
 * destination carries only a box — same color, same size, by construction.
 */
const travelKey = (shape: Component, at: Box): string =>
  `${shape.color}:${shape.size}:${at.top},${at.left}`;

/**
 * Fold one step's moves into a batch's running totals.
 *
 * Identity is *position*, not appearance. Boards carrying two identical shapes
 * are the ordinary case, not the contrived one — a pair of blocks, a player and
 * its twin — and summing them under one color-and-size key reports two shapes
 * that passed each other as one shape that never moved, which is the single
 * worst thing this line could say.
 *
 * Each entry is re-keyed to where its shape landed, which is exactly where the
 * next step's diff will find it: the frames chain, step N's board being step
 * N+1's starting board, so a position is a stable handle for as long as the
 * shape keeps its color and size. Sources are cleared before any destination is
 * written, so a shape sliding into the cell another just vacated inherits its
 * own history rather than the vacater's.
 */
export function trackTravel(
  travels: Map<string, ShapeTravel>,
  moved: MovedShape[]
): void {
  const started = moved.map((move) => {
    const key = travelKey(move.from, move.from);
    const travel = travels.get(key) ?? {
      shape: move.from,
      dRow: 0,
      dCol: 0,
      moves: 0
    };
    travels.delete(key);
    return { move, travel };
  });
  for (const { move, travel } of started) {
    travel.dRow += move.dRow;
    travel.dCol += move.dCol;
    travel.moves++;
    travels.set(travelKey(move.from, move.to), travel);
  }
}

/**
 * A shape's net travel over a batch, counted in **moves** rather than cells.
 *
 * Cells are the misleading unit for a sequence: two presses that each slide a
 * selector five cells are not "ten cells down", they are two moves of five, and a
 * model reading the former will place itself ten cells from where it is. So the
 * per-move stride is stated whenever the total divides by the moves that produced
 * it — observed from the steps, never assumed.
 */
export function renderTravel(travel: ShapeTravel): string {
  const label = shapeLabel(travel.shape);
  if (travel.dRow === 0 && travel.dCol === 0) {
    return `${label} is back where it started after ${travel.moves} move(s)`;
  }
  const shift = describeShift(travel.dRow, travel.dCol);
  if (travel.moves <= 1) return `${label} ${shift}`;
  const even =
    travel.dRow % travel.moves === 0 && travel.dCol % travel.moves === 0;
  const stride = even
    ? `, ${describeShift(travel.dRow / travel.moves, travel.dCol / travel.moves)} per move`
    : "";
  return `${label} ${shift} over ${travel.moves} moves${stride}`;
}

/** `0=white 9=blue b=yellow` — maps grid characters to names, present colors only. */
export function renderLegend(grid: number[][]): string {
  const present = colorHistogram(grid).sort((a, b) => a.color - b.color);
  return (
    "colors: " +
    present.map((h) => `${colorChar(h.color)}=${colorName(h.color)}`).join(" ")
  );
}

/**
 * A column ruler for a labeled grid: a line labelling every `step`-th column and
 * a tick line beneath it, both indented past the row-label gutter.
 *
 * Labels are **absolute** column numbers — `firstCol` is where the drawn area
 * starts, so a clipped window rules to the same coordinates the rest of the
 * output uses. `step` narrows for a window, where every-tenth might not land at
 * all.
 */
function columnRuler(
  cols: number,
  gutter: number,
  firstCol = 0,
  step = 10
): string[] {
  let marks = "";
  let ticks = "";
  for (let c = 0; c < cols; c++) {
    const label = String(firstCol + c);
    // A label that would run off the end is dropped rather than widening the
    // ruler past the body it rules.
    if ((firstCol + c) % step === 0 && c + label.length <= cols) {
      marks += label;
      ticks += "|";
      // The multi-char label has already consumed the next columns' slots.
      c += label.length - 1;
      for (let i = 1; i < label.length; i++) ticks += " ";
    } else {
      marks += " ";
      ticks += " ";
    }
  }
  // A window too narrow to contain a single mark gets no ruler at all, rather
  // than two blank lines the caller would have to recognize as empty.
  if (marks.trim() === "") return [];
  const pad = " ".repeat(gutter);
  return [(pad + marks).trimEnd(), (pad + ticks).trimEnd()];
}

/** Ruler spacing for {@link renderRegion}, whose windows are at most 41 wide. */
const REGION_RULER_STEP = 5;

/**
 * The full board: a legend, a column ruler, then one labeled line per row —
 * with **runs of identical rows collapsed** into a single `12-31 |` band.
 *
 * Labels exist because a model cannot reliably count to column 37 across 64
 * undelimited characters; miscounting there costs a wrong click and two more
 * turns. Collapsing exploits how banded ARC boards are without run-length
 * encoding *within* a row, which would destroy the 2-D structure that this view
 * exists to convey.
 */
export function renderGrid(grid: number[][]): string {
  if (grid.length === 0) return "empty grid.";
  const rendered = grid.map((row) => row.map(colorChar).join(""));
  const cols = grid[0].length;

  // Gutter fits the widest row label, e.g. "62-63 | ".
  const widest = String(grid.length - 1).length;
  const gutter = widest * 2 + 1 + 3;

  const lines: string[] = [renderLegend(grid), ...columnRuler(cols, gutter)];
  for (let r = 0; r < rendered.length;) {
    let end = r;
    while (end + 1 < rendered.length && rendered[end + 1] === rendered[r])
      end++;
    const label = end === r ? String(r) : `${r}-${end}`;
    lines.push(`${label.padStart(gutter - 3)} | ${rendered[r]}`);
    r = end + 1;
  }
  return lines.join("\n");
}

/**
 * A localized view: a `radius`-cell square around (centerRow, centerCol), with
 * **absolute** row and column labels. The labels are what make the view usable —
 * an unlabeled block cannot be mapped back to a coordinate to click.
 *
 * The window is **clipped** on every side, never padded, which is what makes the
 * header's `cols` anchor true: character `i` of a body line is column
 * `firstCol + i`. Padding off-grid columns with spaces instead would shift that
 * mapping by up to `radius` near the left edge.
 *
 * The header used to be the only thing to count from, on the reasoning that a
 * window this narrow does not need a ruler. Logs disagree: asked to place a cell
 * in an 11-wide window, the model counted the characters by hand and got them
 * wrong — "cols 34-38, 5 chars wait that's 10... hmm" — then reasoned on the wrong
 * columns. So the window is ruled too, at {@link REGION_RULER_STEP} rather than
 * {@link renderGrid}'s tens, which a window this size can miss entirely.
 */
export function renderRegion(
  grid: number[][],
  centerRow: number,
  centerCol: number,
  radius = 5
): string {
  if (grid.length === 0) return "empty grid.";
  const firstRow = Math.max(0, centerRow - radius);
  const lastRow = Math.min(grid.length - 1, centerRow + radius);
  const firstCol = Math.max(0, centerCol - radius);

  const gutter = String(lastRow).length;
  const window: number[][] = [];
  const body: string[] = [];
  // Widest extent actually drawn, so the header says where the window ends as
  // well as where it starts. Each row is clipped on its own in case a frame
  // arrives ragged: that shortens a line, it never shifts one.
  let lastCol = firstCol;
  for (let r = firstRow; r <= lastRow; r++) {
    const end = Math.min(grid[r].length - 1, centerCol + radius);
    const cells = grid[r].slice(firstCol, end + 1);
    window.push(cells);
    body.push(
      `${String(r).padStart(gutter)} | ${cells.map(colorChar).join("")}`
    );
    lastCol = Math.max(lastCol, end);
  }

  return [
    renderLegend(window),
    `rows ${firstRow}-${lastRow}, cols ${firstCol}-${lastCol} ` +
      `(centered on row ${centerRow}, col ${centerCol})`,
    // `gutter + 3` is the body's `<label> | ` prefix, so the ruler sits over the
    // cells rather than over the labels.
    ...columnRuler(
      lastCol - firstCol + 1,
      gutter + 3,
      firstCol,
      REGION_RULER_STEP
    ),
    ...body
  ].join("\n");
}
