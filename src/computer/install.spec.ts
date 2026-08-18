import { describe, it, expect } from "vitest";
import {
  DEFAULT_INSTALL_PLAN,
  installFingerprint,
  resolveInstallCommand,
  type InstallProbe,
  type InstallPlan
} from "./install.js";

/**
 * Install resolution, which fails silently in every direction that matters:
 * pick the wrong package manager and you get a `node_modules` that is subtly
 * wrong rather than absent; skip when you should have run and the subagent
 * tests a tree that was never built.
 */

const DIR = "/workspace/repo";

function probe(files: Record<string, string>): InstallProbe {
  return {
    exists: async (path) => path in files,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }
  };
}

const at = (name: string) => `${DIR}/${name}`;
const resolve = (files: Record<string, string>, repo?: string) =>
  resolveInstallCommand(probe(files), DIR, DEFAULT_INSTALL_PLAN, repo);

describe("resolveInstallCommand", () => {
  it("installs nothing when there is no package.json", async () => {
    const result = await resolve({ [at("README.md")]: "# hi" });
    expect(result).toEqual({
      kind: "skip",
      reason: `no package.json in ${DIR}`
    });
  });

  it("uses the lockfile that is present", async () => {
    const result = await resolve({
      [at("package.json")]: "{}",
      [at("package-lock.json")]: "{}"
    });
    expect(result).toMatchObject({
      kind: "run",
      command: "npm ci --no-audit --no-fund",
      lockfiles: ["package-lock.json"]
    });
  });

  /**
   * The one that decides determinism. A stale `package-lock.json` left beside
   * the `pnpm-lock.yaml` a repository actually uses is common, and resolving by
   * whichever the filesystem yields first would install differently on different
   * hosts.
   */
  it("resolves two lockfiles by the plan's order, not the filesystem's", async () => {
    const both = {
      [at("package.json")]: "{}",
      [at("package-lock.json")]: "{}",
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9"
    };
    expect(await resolve(both)).toMatchObject({
      command: "corepack pnpm install --frozen-lockfile",
      lockfiles: ["pnpm-lock.yaml"]
    });

    // Same inputs, opposite insertion order: the answer must not move.
    const reversed = {
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9",
      [at("package-lock.json")]: "{}",
      [at("package.json")]: "{}"
    };
    expect(await resolve(reversed)).toMatchObject({
      lockfiles: ["pnpm-lock.yaml"]
    });
  });

  it("lets the repository's packageManager pin beat its lockfiles", async () => {
    const result = await resolve({
      [at("package.json")]: JSON.stringify({
        packageManager: "yarn@4.1.0+sha512.abc"
      }),
      [at("package-lock.json")]: "{}"
    });
    expect(result).toMatchObject({
      command: "corepack yarn install --immutable",
      reason: "package.json pins packageManager to yarn"
    });
  });

  it("falls through to the lockfiles when the pin names something unknown", async () => {
    const result = await resolve({
      [at("package.json")]: JSON.stringify({ packageManager: "turbo@2" }),
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9"
    });
    expect(result).toMatchObject({ lockfiles: ["pnpm-lock.yaml"] });
  });

  it("survives a package.json that does not parse", async () => {
    const result = await resolve({
      [at("package.json")]: "{ not json",
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9"
    });
    expect(result).toMatchObject({ lockfiles: ["pnpm-lock.yaml"] });
  });

  it("falls back when there is a package.json and no lockfile", async () => {
    expect(await resolve({ [at("package.json")]: "{}" })).toMatchObject({
      command: "npm install --no-audit --no-fund",
      lockfiles: []
    });
  });

  it("skips, with a reason, when the plan refuses to guess", async () => {
    const strict: InstallPlan = { ...DEFAULT_INSTALL_PLAN, noLockfile: null };
    const result = await resolveInstallCommand(
      probe({ [at("package.json")]: "{}" }),
      DIR,
      strict
    );
    expect(result.kind).toBe("skip");
    expect(result.reason).toContain("no lockfile matched");
  });

  it("lets a per-repository override beat everything", async () => {
    const plan: InstallPlan = {
      ...DEFAULT_INSTALL_PLAN,
      overrides: { "acme/site": "npm ci && npm run build" }
    };
    const files = {
      [at("package.json")]: "{}",
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9"
    };

    expect(
      await resolveInstallCommand(probe(files), DIR, plan, "acme/site")
    ).toMatchObject({ command: "npm ci && npm run build" });

    // A different repository is unaffected.
    expect(
      await resolveInstallCommand(probe(files), DIR, plan, "acme/other")
    ).toMatchObject({ command: "corepack pnpm install --frozen-lockfile" });
  });

  /**
   * An override replaces the whole command, so nothing here knows which manager
   * it drives — but it still has to be fingerprinted against the lockfiles that
   * are there, or a dependency bump that touches only the lock reuses a stale
   * tree. See {@link installFingerprint}.
   */
  it("fingerprints an override against every lockfile the plan knows", async () => {
    const plan: InstallPlan = {
      ...DEFAULT_INSTALL_PLAN,
      overrides: { "acme/site": "npm ci && npm run build" }
    };
    const result = await resolveInstallCommand(
      probe({
        [at("package.json")]: "{}",
        [at("pnpm-lock.yaml")]: "lockfileVersion: 9",
        [at("package-lock.json")]: "{}"
      }),
      DIR,
      plan,
      "acme/site"
    );

    expect(result).toMatchObject({ kind: "run" });
    expect((result as { lockfiles: readonly string[] }).lockfiles).toEqual(
      expect.arrayContaining(["pnpm-lock.yaml", "package-lock.json"])
    );
  });
});

/**
 * Yarn, whose two generations disagree about their own flags.
 *
 * Measured rather than assumed, because the failure is silent: yarn 1.22.22 does
 * not reject `--immutable`, it ignores it — exit 0, "success Saved lockfile", and
 * a rewritten lockfile. An install that quietly stops being reproducible says
 * nothing in the tool output, so nothing downstream can notice.
 */
describe("the yarn generations", () => {
  const yarnFiles = (packageJson: string) => ({
    [at("package.json")]: packageJson,
    [at("yarn.lock")]: "# yarn lockfile v1\n"
  });

  it("uses the Berry flag when the pin is Berry", async () => {
    expect(
      await resolve(yarnFiles(JSON.stringify({ packageManager: "yarn@4.1.0" })))
    ).toMatchObject({ command: "corepack yarn install --immutable" });
  });

  it("uses the Classic flag when the pin is Classic", async () => {
    expect(
      await resolve(
        yarnFiles(JSON.stringify({ packageManager: "yarn@1.22.22" }))
      )
    ).toMatchObject({ command: "corepack yarn install --frozen-lockfile" });
  });

  /**
   * The case that was actually broken, and the reason the default leans Classic:
   * corepack's own default `yarn` is 1.22.22, so an unpinned `yarn.lock` — a
   * legacy repository, which is most of them — ran Yarn 1 with a flag it ignored.
   */
  it("uses the Classic flag when nothing is pinned", async () => {
    expect(await resolve(yarnFiles("{}"))).toMatchObject({
      command: "corepack yarn install --frozen-lockfile",
      reason: "found yarn.lock"
    });
  });

  it("uses the Classic flag when the pin carries no readable version", async () => {
    expect(
      await resolve(
        yarnFiles(JSON.stringify({ packageManager: "yarn@stable" }))
      )
    ).toMatchObject({ command: "corepack yarn install --frozen-lockfile" });
  });

  /**
   * The narrowing in `commandFor`, reached the only way it can be: a pin naming
   * a manager no rule claims falls through to the lockfiles, and `yarn.lock`
   * then selects yarn. That other manager's major must not answer yarn's
   * question — without the narrowing, `9 >= 2` picks Berry's flag for a tree
   * whose lockfile is Classic. (A pin naming a manager that *does* have a rule
   * never gets here: the pin beats the lockfiles outright.)
   */
  it("does not hand one manager's version to another's rule", async () => {
    expect(
      await resolve(
        yarnFiles(JSON.stringify({ packageManager: "turbo@9.0.0" }))
      )
    ).toMatchObject({ command: "corepack yarn install --frozen-lockfile" });
  });
});

describe("installFingerprint", () => {
  const files = {
    [at("package.json")]: "{}",
    [at("pnpm-lock.yaml")]: "lockfileVersion: 9\n"
  };

  it("is stable for identical content", async () => {
    const resolution = await resolve(files);
    const a = await installFingerprint(probe(files), DIR, resolution);
    const b = await installFingerprint(probe(files), DIR, resolution);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The half the fingerprint used to be blind to.
   *
   * `package.json` was only consulted when there was *no* lockfile, so a commit
   * that adds a `postinstall`, or moves the `packageManager` pin from `pnpm@9`
   * to `pnpm@10`, matched the stored fingerprint exactly and skipped the
   * install. The tree that produced was quietly wrong rather than absent, and it
   * surfaced as a missing module in some later build with nothing pointing back
   * at the install that never ran.
   */
  it.each([
    ['{"scripts":{"postinstall":"prisma generate"}}', "a postinstall"],
    ['{"packageManager":"pnpm@10.0.0"}', "a packageManager bump"],
    [
      '{"dependencies":{"zod":"^4"}}',
      "a dependency the lockfile has not caught up with"
    ]
  ])("reinstalls when package.json gains %s", async (packageJson) => {
    const resolution = await resolve(files);
    const before = await installFingerprint(probe(files), DIR, resolution);

    const edited = { ...files, [at("package.json")]: packageJson };
    expect(await installFingerprint(probe(edited), DIR, resolution)).not.toBe(
      before
    );
  });

  /**
   * Content, not mtime. A `fetch && reset --hard` onto a new commit rewrites the
   * lockfile whether or not the dependencies moved, and reinstalling on every
   * commit throws away the whole point of a warm container.
   */
  it("changes only when the lockfile's content does", async () => {
    const resolution = await resolve(files);
    const before = await installFingerprint(probe(files), DIR, resolution);

    const rewritten = {
      ...files,
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9\n"
    };
    expect(await installFingerprint(probe(rewritten), DIR, resolution)).toBe(
      before
    );

    const changed = {
      ...files,
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9\n  zod: 4.0.0\n"
    };
    expect(await installFingerprint(probe(changed), DIR, resolution)).not.toBe(
      before
    );
  });

  it("covers the command too, so changing an override reinstalls", async () => {
    const base = await resolve(files);
    const overridden = await resolveInstallCommand(
      probe(files),
      DIR,
      {
        ...DEFAULT_INSTALL_PLAN,
        overrides: { "a/b": "npm ci && npm run build" }
      },
      "a/b"
    );

    expect(await installFingerprint(probe(files), DIR, base)).not.toBe(
      await installFingerprint(probe(files), DIR, overridden)
    );
  });

  /**
   * The silent one. An override used to record no lockfile, so its digest was
   * the command plus `package.json` — and a dependency bump, which is a commit
   * that touches only the lock, matched the stored fingerprint. The install was
   * skipped, `node_modules` stayed a version behind, and the first sign of it
   * was a build failing somewhere unrelated.
   */
  it("re-installs under an override when only the lockfile changed", async () => {
    const plan: InstallPlan = {
      ...DEFAULT_INSTALL_PLAN,
      overrides: { "a/b": "npm ci && npm run build" }
    };
    const resolveOverride = (f: Record<string, string>) =>
      resolveInstallCommand(probe(f), DIR, plan, "a/b");

    const before = await installFingerprint(
      probe(files),
      DIR,
      await resolveOverride(files)
    );

    const bumped = {
      ...files,
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9\n  zod: 4.1.0\n"
    };
    expect(
      await installFingerprint(
        probe(bumped),
        DIR,
        await resolveOverride(bumped)
      )
    ).not.toBe(before);

    // And an untouched tree still skips, or the fix would just be "always run".
    expect(
      await installFingerprint(probe(files), DIR, await resolveOverride(files))
    ).toBe(before);
  });

  it("has nothing to fingerprint when nothing will be installed", async () => {
    const skip = await resolve({ [at("README.md")]: "" });
    expect(await installFingerprint(probe({}), DIR, skip)).toBeNull();
  });
});
