import { describe, it, expect } from "vitest";
import {
  cancelledNote,
  packBlocks,
  renderGrepMatches,
  renderResult,
  truncateOutput
} from "./render.js";

/**
 * Everything that decides what a result *looks like* by the time a model sees it.
 *
 * Pure functions over strings, so there is no workspace stub here and none is
 * wanted: every assertion below is about a budget being spent the way its content
 * deserves, and a container would only make that slower to find out.
 */

describe("truncateOutput", () => {
  it("keeps the head and the tail, which is where the error and the summary are", () => {
    const text = "A".repeat(200) + "B".repeat(200);
    const out = truncateOutput(text, 120);

    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("omitted from the middle");
  });

  /**
   * The regression this guard exists for. Without it, `half` goes negative,
   * `slice(-0)` returns the whole string, and the function hands back *more*
   * than it was given — a silent inversion of its only job, reachable from a
   * public config field.
   */
  it("never returns more than it was given, however small the budget", () => {
    for (const max of [0, 1, 40, 60, 80]) {
      expect(truncateOutput("x".repeat(500), max).length).toBeLessThanOrEqual(
        Math.max(max, 0)
      );
    }
  });
});

/**
 * What a command's result tells the model.
 *
 * The regression these guard is not a crash — it is a silence. When a successful
 * command reported no exit code, models compensated by writing
 * `npm run check; echo "EXIT_CODE=$?"` themselves, and one of those hand-rolled
 * workarounds reached for a bash builtin the container's `sh` does not have and
 * cost a 58-second re-run of the whole gate.
 */
describe("renderResult", () => {
  it("reports the exit code even when the command succeeded", () => {
    const out = renderResult(
      { exitCode: 0, stdout: "all good", stderr: "", status: "completed" },
      16_000
    );
    expect(out).toContain("all good");
    expect(out).toContain("--- exit 0 ---");
  });

  it("says when a command was killed rather than merely failing", () => {
    // The case that matters at the `timeoutMs` ceiling: "your suite was killed at
    // ten minutes" and "your suite has a failing test" must not read alike.
    const killed = renderResult(
      { exitCode: 137, stdout: "partial…", stderr: "", status: "cancelled" },
      16_000
    );
    expect(killed).toContain("--- exit 137 (cancelled) ---");

    const failed = renderResult(
      { exitCode: 1, stdout: "boom", stderr: "", status: "completed" },
      16_000
    );
    expect(failed).toContain("--- exit 1 ---");
    expect(failed).not.toContain("completed");
  });

  it("still reports a verdict when the command printed nothing", () => {
    const out = renderResult(
      { exitCode: 0, stdout: "", stderr: "", status: "completed" },
      16_000
    );
    expect(out).toContain("--- exit 0 ---");
  });

  /**
   * `truncateOutput` used to run once per stream, so `maxOutputBytes` really
   * meant "up to twice this" — a budget that does not bound the thing it names.
   */
  it("applies the output budget once, to the whole transcript", () => {
    const out = renderResult(
      {
        exitCode: 0,
        stdout: "A".repeat(5_000),
        stderr: "B".repeat(5_000),
        status: "completed"
      },
      2_000
    );
    // Body is bounded; only the short verdict line is added on top.
    expect(out.length).toBeLessThan(2_000 + 40);
    expect(out).toContain("--- exit 0 ---");
  });

  it("keeps a labelled stderr block for hosts that did not merge the streams", () => {
    const out = renderResult(
      { exitCode: 1, stdout: "out", stderr: "err", status: "completed" },
      16_000
    );
    expect(out).toContain("out");
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("err");
  });
});

/**
 * `renderResult` says this on its verdict line, so `sb_exec` has always had it.
 * `computerExec` has no verdict line and dropped `status` entirely — and a killed
 * process writes nothing, so `/repo` reported `clone failed:` with nothing after
 * the colon for a clone that hit the ceiling.
 */
describe("cancelledNote", () => {
  it("explains a command that was killed, naming both usual causes", () => {
    const note = cancelledNote("cancelled", 137, 600_000);

    expect(note).toContain("killed");
    // The ceiling as the model would have to state it to change it, and the
    // other cause of a 137 — the exit code cannot tell them apart.
    expect(note).toContain("10m00s");
    expect(note).toMatch(/out of memory/);
  });

  it("says nothing about an ordinary failure", () => {
    // A non-zero exit is the command's own business, and its stderr explains it
    // better than a note could. Anything here would be noise on every failure.
    expect(cancelledNote("failed", 1, 600_000)).toBeUndefined();
    expect(cancelledNote("completed", 0, 600_000)).toBeUndefined();
    expect(cancelledNote(undefined, 1, 600_000)).toBeUndefined();
  });
});

/**
 * How a match list reads.
 *
 * The budget rules here are deliberately not `truncateOutput`'s. Keeping both ends
 * and dropping the middle is right for a build log, where the first error and the
 * final summary are the whole value — and destructive for search results, where the
 * middle is an entire file's worth of hits that disappear without saying so.
 */
describe("renderGrepMatches", () => {
  const match = (path: string, line: number, text: string) => ({
    path,
    line,
    text
  });

  it("names each file once and lists its hits under it", () => {
    const { body } = renderGrepMatches(
      [
        match("/workspace/a.ts", 4, "const x = 1;"),
        match("/workspace/a.ts", 9, "const y = 2;"),
        match("/workspace/b.ts", 2, "const z = 3;")
      ],
      16_000
    );

    // An absolute path costs more than the line it labels; repeating it per hit
    // spends the budget on paths rather than code.
    expect(body.match(/\/workspace\/a\.ts/g)).toHaveLength(1);
    expect(body).toContain("  4: const x = 1;");
    expect(body).toContain("  9: const y = 2;");
    expect(body).toContain("/workspace/b.ts");
  });

  it("distinguishes the matching line from its context, as grep does", () => {
    const { body } = renderGrepMatches(
      [
        {
          path: "/workspace/a.ts",
          line: 5,
          text: "const x = 1;",
          context: [
            { line: 4, text: "// before", isMatch: false },
            { line: 5, text: "const x = 1;", isMatch: true },
            { line: 6, text: "// after", isMatch: false }
          ]
        }
      ],
      16_000
    );

    // `:` is the hit, `-` is context. Without the distinction the model cannot
    // tell which line it actually searched for.
    expect(body).toContain("  5: const x = 1;");
    expect(body).toContain("  4- // before");
    expect(body).toContain("  6- // after");
  });

  /**
   * The minified-bundle case. One match in `dist/` carries a line of megabytes,
   * and `text` is the whole line — so without a cap a single hit is the entire
   * result.
   */
  it("shortens a very long line instead of letting it eat the result", () => {
    const { body, capped } = renderGrepMatches(
      [
        match("/workspace/dist/bundle.js", 1, `x${"y".repeat(50_000)}`),
        match("/workspace/src/a.ts", 3, "readable")
      ],
      16_000
    );

    expect(body.length).toBeLessThan(1_000);
    expect(body).toContain("chars]");
    // The point of capping rather than dropping: the later match survives.
    expect(body).toContain("readable");
    // Reported once, so the caller can say how to reach the full text without
    // repeating the advice on every shortened line.
    expect(capped).toBe(true);
  });

  it("does not claim a line was shortened when none that shipped was", () => {
    const { capped } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "short")],
      16_000
    );
    expect(capped).toBe(false);
  });

  it("stops at the budget and reports exactly how many it showed", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      match("/workspace/a.ts", i + 1, `line ${i} ${"x".repeat(80)}`)
    );

    const { body, shown } = renderGrepMatches(many, 2_000);

    expect(body.length).toBeLessThan(2_400);
    // `shown` is what makes the next offset exact rather than a guess.
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
  });

  it("emits the first match however large, rather than nothing at all", () => {
    const { body, shown } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "x".repeat(5_000))],
      50
    );
    expect(body).toContain("/workspace/a.ts");
    expect(body).toContain("1:");
    expect(shown).toBe(1);
  });
});

/**
 * The budget rule both list tools share.
 *
 * Whole blocks only, because half a match's context reads like a corrupt result —
 * and an exact `shown`, because that number is what the next page's offset is
 * computed from. A `shown` that over-reported by one would silently skip an entry
 * on every subsequent page.
 */
describe("packBlocks", () => {
  it("emits whole blocks and counts them exactly", () => {
    const { body, shown } = packBlocks(
      [["a", "b"], ["c"], ["d", "e", "f"]],
      1_000
    );
    expect(body).toBe("a\nb\nc\nd\ne\nf");
    expect(shown).toBe(3);
  });

  it("drops a block whole rather than splitting it", () => {
    const { body, shown } = packBlocks(
      [["x".repeat(20)], ["y".repeat(20), "z".repeat(20)]],
      30
    );
    expect(shown).toBe(1);
    expect(body).not.toContain("y");
    // Not a partial second block: the line that would have fit is absent too.
    expect(body).not.toContain("z");
  });

  it("always emits the first block, however far over budget", () => {
    const { body, shown } = packBlocks([["x".repeat(5_000)], ["y"]], 10);
    expect(shown).toBe(1);
    expect(body.length).toBeGreaterThan(10);
  });

  it("reports nothing shown for no blocks", () => {
    expect(packBlocks([], 100)).toEqual({ body: "", shown: 0 });
  });
});
