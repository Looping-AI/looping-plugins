import { describe, it, expect } from "vitest";
import { needsDependencies } from "./gate.js";

/**
 * The half of the install gate that is a decision rather than a wait.
 *
 * `installGate` and `execLostNote` are asserted through `sb_exec` in
 * `index.spec.ts`, where the state they read actually comes from — this file is
 * the command classifier, which is pure and has the sharpest failure modes.
 */

/**
 * Which commands have to wait for a dependency install.
 *
 * The asymmetry is the point: waiting for a command that did not need it costs
 * time, while running one that did need it hands the model a "cannot find module"
 * unrelated to its change. So the reads below must not gate, the builds must, and
 * when in doubt the answer is to gate.
 */
describe("needsDependencies", () => {
  it("does not gate reads, listings or git — what a subagent can do while npm ci runs", () => {
    // Every one of these was observed queued behind an install it had no use
    // for, costing 57 seconds before the first useful command ran.
    for (const command of [
      "cd /workspace/repo && tail -c 200 README.md | xxd | tail -20",
      "cd /workspace/repo && tail -c 100 README.md | od -c | tail -20",
      "cd /workspace/repo && git status --short",
      "cd /workspace/repo && git diff -- README.md",
      "cd /workspace/repo && ls -la src && cat package.json",
      "grep -rn 'TODO' src"
    ]) {
      expect(needsDependencies(command)).toBe(false);
    }
  });

  it("gates anything that could reach a dependency", () => {
    for (const command of [
      "cd /workspace/repo && npm run check",
      "npx vitest run src/a.spec.ts",
      "pnpm install && pnpm build",
      "yarn test",
      "bun run build",
      "node scripts/thing.mjs",
      "./node_modules/.bin/eslint .",
      "tsc -p test/tsconfig.json"
    ]) {
      expect(needsDependencies(command)).toBe(true);
    }
  });

  /**
   * The case that made position matter. A word-boundary match anywhere in the
   * string passes every other test here and still fails this one: `\bvitest\b`
   * fires on `vitest.config.ts` because `.` is a word boundary, and config files
   * are exactly what a subagent reads while orienting itself.
   */
  it("reads a build tool's config file without gating on it", () => {
    for (const command of [
      "cat vitest.config.ts",
      "cat next.config.js",
      "cat eslint.config.js && cat prettier.config.js",
      "head -50 vite.config.ts",
      "cat docs/nodes.md",
      "cat src/bundle.ts"
    ]) {
      expect(needsDependencies(command)).toBe(false);
    }
  });

  it("finds a build one level down, where position cannot help", () => {
    // A package manager is never a filename, so it is matched anywhere — which
    // is what catches it inside a nested shell or behind a wrapper.
    expect(needsDependencies("bash -c 'npm run check'")).toBe(true);
    expect(needsDependencies("time npm test")).toBe(true);
    expect(needsDependencies("cd /workspace/repo && FOO=1 npx tsc")).toBe(true);
  });

  it("reads the program name through a path prefix or an env assignment", () => {
    expect(needsDependencies("/usr/local/bin/tsc --noEmit")).toBe(true);
    expect(needsDependencies("CI=1 vitest run")).toBe(true);
    expect(needsDependencies("cd /repo && ./bin/eslint .")).toBe(true);
  });
});
