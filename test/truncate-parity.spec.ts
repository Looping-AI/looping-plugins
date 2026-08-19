import { describe, it, expect } from "vitest";
import { truncateOutput as computerTruncate } from "../src/computer/index.js";
import { truncateOutput as repoTruncate } from "../src/repo/index.js";

/**
 * The one duplication in this package that is deliberate, held in step.
 *
 * `/computer` and `/repo` each carry their own `truncateOutput`, and that is not
 * an oversight: `verify-exports.mjs` fails any subpath whose module graph reaches
 * a sibling's directory, because installing `/repo` must not drag `/computer` —
 * and therefore `@cloudflare/computer` — into a consumer's bundle. Its own error
 * message says, in as many words, to duplicate the helper.
 *
 * What that rule cannot do is keep the two copies honest. So this file does: it
 * imports both and asserts they answer identically, including on the edge that
 * was a real bug in one of them. Drift now fails the build instead of waiting to
 * be noticed.
 *
 * It lives under `test/` rather than in either plugin because it belongs to
 * neither, and because `test/` is excluded from `tsconfig.build.json` — a spec
 * reaching across two plugins is fine precisely because it can never ship.
 */

const both = [
  ["computer", computerTruncate],
  ["repo", repoTruncate]
] as const;

describe("truncateOutput, in both copies", () => {
  it.each(both)("%s: returns short text untouched", (_name, truncate) => {
    expect(truncate("short", 100)).toBe("short");
  });

  it.each(both)("%s: keeps both ends and marks the hole", (_name, truncate) => {
    const text = "A".repeat(200) + "B".repeat(200);
    const out = truncate(text, 120);

    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("omitted from the middle");
  });

  /**
   * The edge that was a live defect. Without the `half < 1` guard a small `max`
   * makes `half` zero or negative, and `slice(-0)` is `slice(0)` — the whole
   * string — so the function returns *more* than it was given: 500 characters in,
   * 543 out at `max: 80`. A copy that lost this guard would look fine until a
   * host set a small `maxOutputChars`.
   */
  it.each(both)(
    "%s: never returns more than it was given",
    (_name, truncate) => {
      const text = "x".repeat(500);
      for (const max of [0, 1, 40, 60, 80]) {
        expect(truncate(text, max).length).toBeLessThanOrEqual(
          Math.max(max, 0)
        );
      }
    }
  );

  /**
   * Asserted as equality rather than as two separate expectations: the point is
   * not that each copy is reasonable, it is that they are the *same*. A reworded
   * marker in one is exactly the drift this file exists to catch.
   */
  it("answers identically across every case above", () => {
    const cases: Array<[string, number]> = [
      ["", 10],
      ["short", 100],
      ["A".repeat(200) + "B".repeat(200), 120],
      ["x".repeat(500), 80],
      ["x".repeat(500), 60],
      ["x".repeat(500), 0],
      ["unicode ✓ ".repeat(50), 90]
    ];
    for (const [text, max] of cases) {
      expect(repoTruncate(text, max)).toBe(computerTruncate(text, max));
    }
  });
});
