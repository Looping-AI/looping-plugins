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
      lockfile: "package-lock.json"
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
      lockfile: "pnpm-lock.yaml"
    });

    // Same inputs, opposite insertion order: the answer must not move.
    const reversed = {
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9",
      [at("package-lock.json")]: "{}",
      [at("package.json")]: "{}"
    };
    expect(await resolve(reversed)).toMatchObject({
      lockfile: "pnpm-lock.yaml"
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
    expect(result).toMatchObject({ lockfile: "pnpm-lock.yaml" });
  });

  it("survives a package.json that does not parse", async () => {
    const result = await resolve({
      [at("package.json")]: "{ not json",
      [at("pnpm-lock.yaml")]: "lockfileVersion: 9"
    });
    expect(result).toMatchObject({ lockfile: "pnpm-lock.yaml" });
  });

  it("falls back when there is a package.json and no lockfile", async () => {
    expect(await resolve({ [at("package.json")]: "{}" })).toMatchObject({
      command: "npm install --no-audit --no-fund",
      lockfile: null
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

  it("has nothing to fingerprint when nothing will be installed", async () => {
    const skip = await resolve({ [at("README.md")]: "" });
    expect(await installFingerprint(probe({}), DIR, skip)).toBeNull();
  });
});
