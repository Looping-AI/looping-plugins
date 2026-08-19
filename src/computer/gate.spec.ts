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
   * `timeout` takes a duration, and a duration usually carries a unit.
   *
   * A bare-integer wrapper argument reads `60s` as the program being run, so the
   * `vitest` behind it is never checked — while the `timeout 60 …` spelling
   * works. That asymmetry is the expensive direction: a test suite running
   * against a half-built `node_modules`.
   */
  it.each([
    "timeout 60s vitest run",
    "timeout 5m tsc",
    "timeout 2h jest",
    "timeout --preserve-status 30s vitest"
  ])("looks past a wrapper's duration argument in %s", (command) => {
    expect(needsDependencies(command)).toBe(true);
  });

  /**
   * A package manager's own lockfile is a file, not a build.
   *
   * The sibling of the config-file case below, and the one a position check
   * cannot catch: `PACKAGE_MANAGERS` matches anywhere by design, so it needs a
   * lookahead instead. `\b` breaks on both a hyphen and a dot, which is what
   * makes `pnpm-lock.yaml` and `yarn.lock` read as their managers.
   */
  it("reads a lockfile without gating on it", () => {
    for (const command of [
      "cat pnpm-lock.yaml",
      "cat yarn.lock",
      "git diff pnpm-lock.yaml",
      "cat pnpm-workspace.yaml",
      "wc -l package-lock.json"
    ]) {
      expect(needsDependencies(command)).toBe(false);
    }
  });

  /**
   * And the lookahead does not buy that by giving up the loose match, which is
   * the whole reason the manager list is not position-checked: a build one level
   * down inside `bash -c` has no recognisable command position at all.
   */
  it("still gates a manager named next to a lockfile it reads", () => {
    for (const command of [
      "npm ci && cat package-lock.json",
      "cat yarn.lock && yarn install",
      "bash -c 'pnpm install --frozen-lockfile'"
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

  /**
   * A wrapper hid the program that needed the tree.
   *
   * `time vitest run` read as a command called `time`, which is in no list, so
   * it skipped the gate and ran against a half-built `node_modules` — the
   * expensive half of the asymmetry, and invisible, because the failure surfaces
   * later as a module that cannot be found. Package managers were never affected:
   * `PACKAGE_MANAGERS` matches anywhere in the string, so `time npm test` always
   * gated.
   */
  it.each([
    "env CI=1 vitest run",
    "time vitest run",
    "nice -n 10 tsc --noEmit",
    "xargs -n1 tsc",
    "sudo eslint .",
    "timeout 60 vitest run",
    "env CI=1 nice -n 10 vitest run",
    "/usr/bin/time tsc"
  ])("looks past a wrapper to the program behind it: %s", (command) => {
    expect(needsDependencies(command)).toBe(true);
  });

  /**
   * The wrapper list must not become a way to gate on nothing. A wrapper with no
   * program behind it, and a wrapper's own name as an ordinary argument, are
   * both reads rather than builds.
   */
  it.each(["time", "env", "cat env", "ls -la /usr/bin/time"])(
    "does not gate on a wrapper with nothing behind it: %s",
    (command) => {
      expect(needsDependencies(command)).toBe(false);
    }
  );
});
