import { describe, it, expect } from "vitest";
import {
  COLOR_NAMES,
  colorHistogram,
  colorName,
  colorSpans,
  connectedComponents,
  describeBox,
  describeCell,
  diffGrids,
  diffShapes,
  describeShift,
  fillRatio,
  lastGrid,
  locateComponents,
  matchShapes,
  parseGrid,
  renderGrid,
  renderLegend,
  renderRegion,
  renderShapeDelta,
  renderShapes,
  renderTravel,
  trackTravel,
  type ShapeTravel,
  serializeGrid,
  MAX_SHAPE_CHANGES
} from "./analysis.js";
import { LS20_LEVEL1_BEFORE } from "../../test/arc-agi/ls20-level1.js";

/** A tiny grid for readable assertions. */
const GRID: number[][] = [
  [0, 1, 1],
  [0, 2, 1],
  [3, 3, 0]
];

describe("lastGrid", () => {
  it("returns the final grid of a frame array (the current board)", () => {
    expect(lastGrid([[[0]], [[1]], [[2]]])).toEqual([[2]]);
  });
  it("returns an empty grid for an empty frame", () => {
    expect(lastGrid([])).toEqual([]);
  });
});

describe("the palette", () => {
  /**
   * Pinned to `agents/templates/multimodal.py` in `arcprize/ARC-AGI-3-Agents`.
   * This is the one mapping in the recipe that is worse than useless if wrong —
   * a model told "red" about a green cell reasons confidently in the wrong
   * direction — and ARC-AGI-3's palette is NOT ARC-AGI-1's, so a plausible-looking
   * edit is exactly the failure to guard against.
   */
  it("matches the ARC-AGI-3 palette exactly, index for index", () => {
    expect([...COLOR_NAMES]).toEqual([
      "white",
      "off-white",
      "neutral-light",
      "neutral",
      "off-black",
      "black",
      "magenta",
      "magenta-light",
      "red",
      "blue",
      "blue-light",
      "yellow",
      "orange",
      "maroon",
      "green",
      "purple"
    ]);
  });

  it("is not the ARC-AGI-1 palette", () => {
    // The familiar mapping would put black at 0 and blue at 1. Getting this
    // backwards is the specific mistake this suite exists to catch.
    expect(colorName(0)).toBe("white");
    expect(colorName(5)).toBe("black");
  });

  it("degrades an out-of-range index instead of throwing", () => {
    expect(colorName(99)).toBe("color 99");
    expect(colorName(-1)).toBe("color -1");
  });
});

describe("serializeGrid / parseGrid", () => {
  it("renders each row as single hex digits", () => {
    expect(
      serializeGrid([
        [0, 10, 15],
        [1, 2, 3]
      ])
    ).toBe("0af\n123");
  });

  it("round-trips a full 64×64 grid", () => {
    const grid = Array.from({ length: 64 }, (_, r) =>
      Array.from({ length: 64 }, (_, c) => (r + c) % 16)
    );
    expect(parseGrid(serializeGrid(grid))).toEqual(grid);
  });

  it("round-trips an empty grid", () => {
    expect(parseGrid(serializeGrid([]))).toEqual([]);
  });
});

describe("diffGrids", () => {
  it("reports -1 changed for a null previous frame (first frame)", () => {
    expect(diffGrids(null, GRID).changed).toBe(-1);
  });

  it("counts changed cells and lists them (capped)", () => {
    const a = [
      [0, 0],
      [0, 0]
    ];
    const b = [
      [0, 1],
      [2, 0]
    ];
    const diff = diffGrids(a, b);
    expect(diff.changed).toBe(2);
    expect(diff.cells).toEqual([
      { row: 0, col: 1, from: 0, to: 1 },
      { row: 1, col: 0, from: 0, to: 2 }
    ]);
    expect(diff.box).toEqual({ top: 0, left: 0, bottom: 1, right: 1 });
  });

  it("caps the cell list while still counting all changes", () => {
    const a = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const b = Array.from({ length: 4 }, () => new Array(4).fill(7));
    const diff = diffGrids(a, b, 3);
    expect(diff.changed).toBe(16);
    expect(diff.cells).toHaveLength(3);
  });

  it("boxes every change, not just the cells that fit under the cap", () => {
    const a = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const b = a.map((row) => [...row]);
    b[1][2] = 4;
    b[6][5] = 4;
    // Cap of 1 keeps only the first cell, but the box must still span both.
    const diff = diffGrids(a, b, 1);
    expect(diff.cells).toHaveLength(1);
    expect(diff.box).toEqual({ top: 1, left: 2, bottom: 6, right: 5 });
  });

  it("has no box when nothing changed", () => {
    expect(diffGrids(GRID, GRID).box).toBeNull();
  });
});

describe("describeBox", () => {
  it("names a range", () => {
    expect(describeBox({ top: 3, left: 10, bottom: 5, right: 12 })).toBe(
      "rows 3-5, cols 10-12"
    );
  });
  it("drops the range for a single row or column", () => {
    expect(describeBox({ top: 12, left: 30, bottom: 12, right: 31 })).toBe(
      "row 12, cols 30-31"
    );
    expect(describeBox({ top: 1, left: 4, bottom: 2, right: 4 })).toBe(
      "rows 1-2, col 4"
    );
  });
});

describe("describeCell", () => {
  it("names both colors", () => {
    expect(describeCell({ row: 12, col: 30, from: 9, to: 0 })).toBe(
      "(12,30) blue->white"
    );
  });
  it("marks a cell that had no previous value", () => {
    expect(describeCell({ row: 0, col: 0, from: -1, to: 11 })).toBe(
      "(0,0) off-grid->yellow"
    );
  });
});

describe("colorHistogram", () => {
  it("counts colors descending by frequency", () => {
    expect(colorHistogram(GRID)).toEqual([
      { color: 0, count: 3 },
      { color: 1, count: 3 },
      { color: 3, count: 2 },
      { color: 2, count: 1 }
    ]);
  });
});

describe("locateComponents", () => {
  it("reports the bounding box and size of each region, largest first", () => {
    // color 1 spans (0,1),(0,2),(1,2); color 3 spans (2,0),(2,1); color 2 is (1,1).
    expect(locateComponents(GRID)).toEqual([
      { color: 1, size: 3, top: 0, left: 1, bottom: 1, right: 2 },
      { color: 3, size: 2, top: 2, left: 0, bottom: 2, right: 1 },
      { color: 2, size: 1, top: 1, left: 1, bottom: 1, right: 1 }
    ]);
  });

  it("skips white as background", () => {
    expect(locateComponents(GRID).some((c) => c.color === 0)).toBe(false);
  });

  it("separates disconnected same-color regions and locates each", () => {
    const grid = [
      [1, 0, 1],
      [0, 0, 0],
      [1, 0, 1]
    ];
    const found = locateComponents(grid);
    expect(found).toHaveLength(4);
    expect(found.map((c) => [c.top, c.left])).toEqual(
      expect.arrayContaining([
        [0, 0],
        [0, 2],
        [2, 0],
        [2, 2]
      ])
    );
  });

  it("returns nothing for an all-background board", () => {
    expect(
      locateComponents([
        [0, 0],
        [0, 0]
      ])
    ).toEqual([]);
  });
});

describe("connectedComponents", () => {
  it("counts 4-connected same-color components, skipping background 0", () => {
    const summary = connectedComponents(GRID);
    const byColor = new Map(summary.map((s) => [s.color, s]));
    expect(byColor.get(1)).toEqual({ color: 1, components: 1, largest: 3 });
    expect(byColor.get(3)).toEqual({ color: 3, components: 1, largest: 2 });
    expect(byColor.get(2)).toEqual({ color: 2, components: 1, largest: 1 });
    expect(byColor.has(0)).toBe(false);
  });

  it("separates disconnected same-color regions", () => {
    const grid = [
      [1, 0, 1],
      [0, 0, 0],
      [1, 0, 1]
    ];
    const c1 = connectedComponents(grid).find((s) => s.color === 1);
    expect(c1).toEqual({ color: 1, components: 4, largest: 1 });
  });
});

describe("renderShapes", () => {
  it("names each region and says where it is", () => {
    expect(renderShapes(GRID)).toBe(
      [
        "off-white: rows 0-1, cols 1-2 (3 cells)",
        "neutral: row 2, cols 0-1 (2 cells)",
        "neutral-light: row 1, col 1 (1 cell)"
      ].join("\n")
    );
  });

  it("says so when the board is empty of shapes", () => {
    expect(
      renderShapes([
        [0, 0],
        [0, 0]
      ])
    ).toContain("no shapes");
  });

  it("caps the list and says how many it withheld", () => {
    // A checkerboard of single-cell regions, far more than the cap.
    const grid = Array.from({ length: 8 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => ((r + c) % 2 === 0 ? 9 : 0))
    );
    const out = renderShapes(grid, 5).split("\n");
    expect(out).toHaveLength(6);
    expect(out[5]).toBe("+27 more shape(s), smaller than these.");
  });

  /**
   * The failure this whole rendering exists for, on the board where it happened.
   * `off-black` is the `ls20` maze: one component, 2129 cells, and a bounding box
   * of the entire 64×64 board. Told only that, a play read its route off the box
   * and walked into walls; the columns below are the walls it could not see.
   */
  describe("on a real ls20 board", () => {
    const grid = parseGrid(LS20_LEVEL1_BEFORE);
    const out = renderShapes(grid);

    it("does not describe the maze by a box that spans the whole board", () => {
      expect(out).not.toContain("off-black: rows 0-63, cols 0-63");
      expect(out).toContain(
        "off-black: 2129 cells in 1 region(s), 52% of rows 0-63, cols 0-63"
      );
    });

    it("gives the wall's columns band by band", () => {
      // The play walked left twice from cols 29-33 at rows 15-19 and reported
      // `nothing moved` both times. Its destination, cols 24-28, is named here.
      expect(out).toContain("  rows 15-19: cols 4-8, 24-28, 39-43, 54-63");
      expect(out).toContain("  rows 20-24: cols 4-8, 24-28, 39-48, 59-63");
    });

    it("gives the walkable floor the same treatment, so corridors are named", () => {
      // The old line asserted a 50×50 open arena of which 46% was wall — the
      // more dangerous of the two, since a box that says nothing at least does
      // not mislead.
      expect(out).not.toContain("neutral: rows 5-54, cols 9-58");
      expect(out).toContain(
        "neutral: 1380 cells in 4 region(s), 48% of rows 5-62, cols 9-58"
      );
      expect(out).toContain("  row 15: cols 9-23, 29-38, 44-53");
      expect(out).toContain("  rows 25-29: cols 14-18, 34-43, 49-58");
    });

    it("leaves regions that fill their box as a single line", () => {
      // The 5×5 selector and the 3×3 donut: a box describes these exactly, and
      // spending twenty lines on them would bury the terrain that needs them.
      expect(out).toContain("blue: rows 42-44, cols 34-38 (15 cells)");
      expect(out).toContain("orange: rows 40-41, cols 34-38 (10 cells)");
      expect(out).toContain("yellow: rows 16-18, cols 15-17 (8 cells)");
    });

    it("names every band of both terrain layers without clipping", () => {
      expect(out).not.toContain("more row band(s)");
    });

    /**
     * This render rides on every chunk's free orientation (`describeState`), so
     * its size is charged to the model's context window on every play. A ceiling
     * rather than an exact length: the point is that it cannot quietly grow into
     * the thing it replaced.
     */
    it("stays within its context budget", () => {
      expect(out.length).toBeLessThan(3000);
    });
  });

  it("bounds the render on a board this encoding suits badly", () => {
    // Three combs: huge single components with a run every other column, and no
    // two rows alike, so neither the run cap nor the band cap can be skipped.
    const grid = Array.from({ length: 64 }, (_, r) =>
      Array.from({ length: 64 }, (_, c) => {
        if (r < 3) return [4, 9, 11][r];
        return c % 2 === 0 ? [4, 9, 11][(r + c) % 3] : 3;
      })
    );
    const out = renderShapes(grid);
    expect(out).toContain("more run(s)");
    expect(out).toContain("more row band(s)");
    expect(out.split("\n").length).toBeLessThan(64);
  });
});

describe("colorSpans", () => {
  it("gives the column runs of one color, row by row", () => {
    expect(
      colorSpans(
        [
          [9, 0, 9, 9],
          [0, 0, 0, 9]
        ],
        9
      )
    ).toEqual([
      {
        top: 0,
        bottom: 0,
        cols: [
          [0, 0],
          [2, 3]
        ],
        hidden: 0
      },
      { top: 1, bottom: 1, cols: [[3, 3]], hidden: 0 }
    ]);
  });

  it("collapses consecutive rows whose runs are identical into one band", () => {
    const grid = Array.from({ length: 6 }, () => [9, 0, 9]);
    expect(colorSpans(grid, 9)).toEqual([
      {
        top: 0,
        bottom: 5,
        cols: [
          [0, 0],
          [2, 2]
        ],
        hidden: 0
      }
    ]);
  });

  it("skips rows the color is absent from rather than emitting empty bands", () => {
    expect(
      colorSpans([[9], [0], [9]], 9).map((b) => [b.top, b.bottom])
    ).toEqual([
      [0, 0],
      [2, 2]
    ]);
  });

  /**
   * One color, several components. The flood fill's notion of connectedness is
   * an implementation detail to a player: a wall a doorway splits in two is one
   * wall, and it must read as one terrain layer.
   */
  it("spans a color across every component of it at once", () => {
    const bands = colorSpans(
      [
        [4, 4, 4],
        [0, 0, 0],
        [4, 4, 4]
      ],
      4
    );
    expect(bands).toHaveLength(2);
    expect(bands.every((b) => b.cols.length === 1)).toBe(true);
  });
});

describe("fillRatio", () => {
  it("is 1 for a region that fills its box and lower for one that does not", () => {
    const box = { top: 0, left: 0, bottom: 3, right: 3 };
    expect(fillRatio(box, 16)).toBe(1);
    expect(fillRatio(box, 8)).toBe(0.5);
  });
});

describe("renderLegend", () => {
  it("maps grid characters to names, ascending, present colors only", () => {
    expect(renderLegend(GRID)).toBe(
      "colors: 0=white 1=off-white 2=neutral-light 3=neutral"
    );
  });

  it("uses hex characters for colors above 9", () => {
    expect(renderLegend([[10, 11]])).toBe("colors: a=blue-light b=yellow");
  });
});

describe("renderGrid", () => {
  it("labels rows and columns and leads with a legend", () => {
    expect(renderGrid(GRID)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light 3=neutral",
        "      0",
        "      |",
        "  0 | 011",
        "  1 | 021",
        "  2 | 330"
      ].join("\n")
    );
  });

  it("collapses runs of identical rows into one labeled band", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(5));
    const lines = renderGrid(grid).split("\n");
    // Legend + two ruler lines + a single band, instead of 64 row lines.
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(` 0-63 | ${"5".repeat(64)}`);
  });

  it("keeps distinct rows distinct while collapsing the bands around them", () => {
    const grid = Array.from({ length: 6 }, (_, r) =>
      r === 3 ? [1, 1] : [0, 0]
    );
    const rows = renderGrid(grid)
      .split("\n")
      .slice(3)
      .map((l) => l.split(" | ")[0].trim());
    expect(rows).toEqual(["0-2", "3", "4-5"]);
  });

  it("aligns the column ruler with the grid body", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(0));
    const lines = renderGrid(grid).split("\n");
    const body = lines[3];
    const gutter = body.indexOf("| ") + 2;
    // Every tick on the ruler must sit exactly over the column it labels.
    for (const col of [0, 10, 20, 30, 40, 50, 60]) {
      expect(lines[2][gutter + col]).toBe("|");
    }
    expect(lines[1].slice(gutter, gutter + 1)).toBe("0");
    expect(lines[1].slice(gutter + 10, gutter + 12)).toBe("10");
  });

  it("reports an empty grid rather than rendering nothing", () => {
    expect(renderGrid([])).toBe("empty grid.");
  });
});

describe("renderRegion", () => {
  it("labels absolute rows and columns, clipping at the edges", () => {
    // Center (row 0, col 0), radius 1 → the window wants cols -1..1 and rows
    // -1..1, and is clipped to the board on both. Nothing is padded: the first
    // character of each line is column 0, exactly as the header says.
    expect(renderRegion(GRID, 0, 0, 1)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light",
        "rows 0-1, cols 0-1 (centered on row 0, col 0)",
        "    0",
        "    |",
        "0 | 01",
        "1 | 02"
      ].join("\n")
    );
  });

  it("anchors the first character at the labeled column, not at the center", () => {
    // The bottom-right corner: clipped on the far side, and starting at col 1.
    // A leading pad here would make the header's `cols 1-2` a lie and send a
    // click one column off. Cols 1-2 contain no ruler mark, and the ruler is
    // omitted rather than drawn blank.
    expect(renderRegion(GRID, 2, 2, 1)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light 3=neutral",
        "rows 1-2, cols 1-2 (centered on row 2, col 2)",
        "1 | 21",
        "2 | 30"
      ].join("\n")
    );
  });

  it("labels rows with their real indices away from the origin", () => {
    const grid = Array.from({ length: 64 }, (_, r) =>
      new Array(64).fill(r % 16)
    );
    const lines = renderRegion(grid, 40, 30, 2).split("\n");
    expect(lines[1]).toBe(
      "rows 38-42, cols 28-32 (centered on row 40, col 30)"
    );
    expect(lines.slice(4).map((l) => l.split(" | ")[0])).toEqual([
      "38",
      "39",
      "40",
      "41",
      "42"
    ]);
  });

  /**
   * The reason the ruler was added: a model asked to place a cell in an 11-wide
   * window counted the characters by hand and got them wrong. A mark whose label
   * does not sit exactly above the cell it names would be worse than none.
   */
  it("rules absolute columns, aligned over the cells they label", () => {
    const grid = Array.from({ length: 64 }, () =>
      Array.from({ length: 64 }, (_, c) => c % 16)
    );
    const [marks, ticks, first] = renderRegion(grid, 40, 47, 5)
      .split("\n")
      .slice(2);
    // Window is cols 42-52, so 45 and 50 are the marks; each label starts where
    // its tick is, and the body's `40 | ` prefix is five characters wide.
    expect(ticks).toBe("        |    |");
    expect(marks).toBe("        45   50");
    expect(ticks.indexOf("|")).toBe(5 + (45 - 42));
    // And the cell under that tick really is column 45.
    expect(first.slice(5)[45 - 42]).toBe((45 % 16).toString(16));
  });

  it("reports an empty grid rather than rendering nothing", () => {
    expect(renderRegion([], 0, 0)).toBe("empty grid.");
  });
});

/**
 * Shape matching is the answer to a specific failure: on a board with a step
 * counter, every action changes cells, so a cell diff can never say "that move
 * was blocked". These tests are about the two claims the renderer makes —
 * something moved, or nothing did — and about it declining when it cannot tell.
 */
describe("matchShapes", () => {
  /** A grid with one 2×2 blue block whose top-left sits at (top, left). */
  const block = (top: number, left: number, color = 9): number[][] => {
    const grid = Array.from({ length: 8 }, () => new Array(8).fill(0));
    for (const [r, c] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1]
    ]) {
      grid[top + r][left + c] = color;
    }
    return grid;
  };

  it("reports a rigid shape that travelled, with its displacement", () => {
    const { moved, other } = matchShapes(
      locateComponents(block(1, 1)),
      locateComponents(block(1, 4))
    );
    expect(other).toEqual([]);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ dRow: 0, dCol: 3 });
    expect(moved[0].from).toMatchObject({ color: 9, size: 4, top: 1, left: 1 });
  });

  it("says nothing about a shape that did not move", () => {
    const same = locateComponents(block(1, 1));
    expect(matchShapes(same, same)).toEqual({ moved: [], other: [] });
  });

  it("calls a same-color shape with a different cell count a resize", () => {
    // A bar losing a cell, which is what a fuel or step counter looks like.
    const before = locateComponents([[11, 11, 11, 0]]);
    const after = locateComponents([[11, 11, 0, 0]]);
    const { moved, other } = matchShapes(before, after);
    expect(moved).toEqual([]);
    expect(other).toEqual([
      {
        kind: "resized",
        from: { color: 11, size: 3, top: 0, left: 0, bottom: 0, right: 2 },
        to: { color: 11, size: 2, top: 0, left: 0, bottom: 0, right: 1 }
      }
    ]);
  });

  it("calls a shape that changed color where it stood a repaint", () => {
    // What a click game does instead of moving anything. Paired by colour, this
    // is a blue block vanishing and an unrelated red one materializing on its
    // exact footprint — twenty of which a logged `ft09` play had to reassemble
    // into "clicking a block toggles it".
    const { moved, other } = matchShapes(
      locateComponents(block(1, 1)),
      locateComponents(block(1, 1, 8))
    );
    expect(moved).toEqual([]);
    expect(other).toEqual([
      {
        kind: "recolored",
        from: { color: 9, size: 4, top: 1, left: 1, bottom: 2, right: 2 },
        to: { color: 8, size: 4, top: 1, left: 1, bottom: 2, right: 2 }
      }
    ]);
  });

  it("keeps a repaint apart from a shape that both moved and changed color", () => {
    // Same colors, different footprint: nothing here says these are one object,
    // so the pass declines to claim it and the two events stand.
    const { other } = matchShapes(
      locateComponents(block(1, 1)),
      locateComponents(block(1, 4, 8))
    );
    expect(other.map((c) => c.kind).sort()).toEqual(["appeared", "gone"]);
  });

  it("reports arrivals and departures when nothing pairs up", () => {
    const { moved, other } = matchShapes(
      locateComponents([[9, 0]]),
      locateComponents([[0, 14]])
    );
    expect(moved).toEqual([]);
    expect(other.map((c) => c.kind).sort()).toEqual(["appeared", "gone"]);
  });

  it("pairs each shape with its nearest candidate, not the first one", () => {
    // Two identical blocks; the right one steps right. Matching by proximity keeps
    // that attribution — matching in list order would report both as moving.
    const before = [
      ...locateComponents(block(1, 1)),
      ...locateComponents(block(5, 5))
    ];
    const after = [
      ...locateComponents(block(1, 1)),
      ...locateComponents(block(5, 6))
    ];
    const { moved } = matchShapes(before, after);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ dRow: 0, dCol: 1 });
    expect(moved[0].from.top).toBe(5);
  });

  it("has nothing to compare against on the first frame", () => {
    expect(diffShapes(null, [[9]])).toBeNull();
  });
});

describe("renderShapeDelta", () => {
  const moving = (dRow: number, dCol: number) =>
    matchShapes(
      locateComponents([
        [9, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
      ]),
      [{ color: 9, size: 1, top: dRow, left: dCol, bottom: dRow, right: dCol }]
    );

  it("names the shape, where it went, and how far", () => {
    expect(renderShapeDelta(moving(0, 2))).toBe(
      "blue 1×1 row 0, col 0 → cols 2-2 (right 2)"
    );
  });

  it("spells out both axes when a shape moves diagonally", () => {
    expect(renderShapeDelta(moving(1, 1))).toBe(
      "blue 1×1 row 0, col 0 → row 1, col 1 (down 1, right 1)"
    );
  });

  it("leads with `nothing moved` when only a counter changed", () => {
    // The line the whole matcher exists for: cells changed, position did not.
    const delta = matchShapes(
      locateComponents([[11, 11, 11]]),
      locateComponents([[11, 11, 0]])
    );
    expect(renderShapeDelta(delta)).toBe(
      "nothing moved; yellow row 0, cols 0-2 → row 0, cols 0-1 (3→2 cells)"
    );
  });

  it("does not say `nothing moved` over a board that changed", () => {
    // The phrase is the soul's signal for blocked-or-refused, so a step that
    // repainted a block must not lead with it: a click game moves nothing ever,
    // and every one of its steps would read as a refusal.
    const toggle = (color: number) =>
      locateComponents([
        [color, color, 0],
        [color, color, 0],
        [0, 0, 0]
      ]);
    const rendered = renderShapeDelta(matchShapes(toggle(9), toggle(8)));
    expect(rendered).toBe(
      "no shape travelled, but the board changed; " +
        "blue 2×2 at rows 0-1, cols 0-1 turned red"
    );
  });

  it("declines when the frames are identical, leaving the cell diff to speak", () => {
    expect(renderShapeDelta({ moved: [], other: [] })).toBeNull();
  });

  it("declines a repaint rather than narrating every shape of it", () => {
    // A level change replaces the board. Naming twenty arrivals says less than
    // the cell diff does, so this view stands aside.
    const scatter = (color: number) =>
      locateComponents(
        Array.from({ length: 9 }, (_, r) =>
          Array.from({ length: 9 }, (_, c) => ((r + c) % 2 === 0 ? color : 0))
        )
      );
    const delta = matchShapes(scatter(9), scatter(14));
    expect(delta.other.length).toBeGreaterThan(MAX_SHAPE_CHANGES);
    expect(renderShapeDelta(delta)).toBeNull();
  });
});

describe("renderTravel", () => {
  const shape = { color: 12, size: 25, top: 0, left: 0, bottom: 4, right: 4 };

  it("states the per-move stride when the total divides by the moves", () => {
    // Two presses of a selector that slides five cells are not "ten cells down":
    // a model reading it that way places itself ten cells from where it is.
    expect(renderTravel({ shape, dRow: 10, dCol: 0, moves: 2 })).toBe(
      "orange 5×5 down 10 over 2 moves, down 5 per move"
    );
  });

  it("gives the total alone when the moves were not uniform", () => {
    expect(renderTravel({ shape, dRow: 7, dCol: 0, moves: 2 })).toBe(
      "orange 5×5 down 7 over 2 moves"
    );
  });

  it("does not bother with a stride for a single move", () => {
    expect(renderTravel({ shape, dRow: 0, dCol: -5, moves: 1 })).toBe(
      "orange 5×5 left 5"
    );
  });

  it("says so when a shape ended up where it started", () => {
    expect(renderTravel({ shape, dRow: 0, dCol: 0, moves: 2 })).toBe(
      "orange 5×5 is back where it started after 2 move(s)"
    );
  });
});

describe("trackTravel", () => {
  /** A 1×1 shape at a cell, which is all identity here turns on. */
  const cell = (top: number, left: number, color = 9) => ({
    color,
    size: 1,
    top,
    left,
    bottom: top,
    right: left
  });
  const move = (from: ReturnType<typeof cell>, to: ReturnType<typeof cell>) =>
    ({
      kind: "moved",
      from,
      to,
      dRow: to.top - from.top,
      dCol: to.left - from.left
    }) as const;

  it("follows one shape across steps by where it landed", () => {
    const travels = new Map<string, ShapeTravel>();
    trackTravel(travels, [move(cell(0, 0), cell(0, 1))]);
    trackTravel(travels, [move(cell(0, 1), cell(0, 2))]);
    expect([...travels.values()].map(renderTravel)).toEqual([
      "blue 1×1 right 2 over 2 moves, right 1 per move"
    ]);
  });

  it("keeps two identical shapes apart instead of netting them to nothing", () => {
    // Same color, same size, opposite directions. Summed under one
    // color-and-size key this batch reads "back where it started" — a sentence
    // about a shape that does not exist, over two that both moved.
    const travels = new Map<string, ShapeTravel>();
    trackTravel(travels, [
      move(cell(0, 0), cell(0, 1)),
      move(cell(4, 4), cell(4, 3))
    ]);
    trackTravel(travels, [
      move(cell(0, 1), cell(0, 2)),
      move(cell(4, 3), cell(4, 2))
    ]);
    expect([...travels.values()].map(renderTravel)).toEqual([
      "blue 1×1 right 2 over 2 moves, right 1 per move",
      "blue 1×1 left 2 over 2 moves, left 1 per move"
    ]);
  });

  it("does not hand a shape the history of the one it displaced", () => {
    // A chases B down a row: A ends the step on the cell B started it on, and
    // must not inherit B's travel along with its position.
    const travels = new Map<string, ShapeTravel>();
    trackTravel(travels, [move(cell(0, 5), cell(0, 4))]);
    trackTravel(travels, [
      move(cell(0, 0), cell(0, 1)),
      move(cell(0, 4), cell(0, 3))
    ]);
    expect([...travels.values()].map(renderTravel)).toEqual([
      "blue 1×1 right 1",
      "blue 1×1 left 2 over 2 moves, left 1 per move"
    ]);
  });
});

describe("describeShift", () => {
  it("names directions rather than signed numbers", () => {
    expect(describeShift(-3, 0)).toBe("up 3");
    expect(describeShift(0, 4)).toBe("right 4");
    expect(describeShift(2, -1)).toBe("down 2, left 1");
    expect(describeShift(0, 0)).toBe("no shift");
  });
});
