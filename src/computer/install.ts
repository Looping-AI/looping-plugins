/**
 * Working out how a repository installs its dependencies, mechanically.
 *
 * The *procedure* lives here because it is the same everywhere: look at what the
 * repository actually contains, in a fixed order, and never guess. The
 * **commands** live in the host, because they are a deployment's business — one
 * repository wants `--frozen-lockfile`, another needs a private registry
 * preamble, a third has to build after installing. See
 * {@link InstallPlan.overrides}.
 *
 * ## Why this exists at all
 *
 * The alternative is a sentence in the subagent's soul — "install dependencies
 * before you do anything else" — and a standard with no command attached is one a
 * model satisfies with whichever check is cheapest: edit a README, run
 * `prettier --check` on that one file, report the change verified, and never run
 * the project's gate at all.
 *
 * ## Why the order is fixed and written down
 *
 * A repository can carry two lockfiles — a `package-lock.json` someone forgot to
 * delete next to the `pnpm-lock.yaml` that is actually used. Resolving by
 * whichever the filesystem happens to return first makes the install
 * non-deterministic across hosts, and the failure is a confusing one: the wrong
 * package manager produces a `node_modules` that is subtly wrong rather than
 * absent. So: an explicit override wins, then the repository's own
 * `packageManager` pin, then lockfiles in the order the plan lists them.
 */

import type { JobState } from "@dynamicagents/core/job";

/** Just enough of a workspace filesystem to inspect a checkout. */
export interface InstallProbe {
  exists(path: string): Promise<boolean>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

/**
 * Where the install has got to, as the host reports it and the tools read it.
 *
 * Declared here rather than in the host because both sides depend on it and
 * neither owns the other: the Durable Object runs the job, and `sb_exec` refuses
 * to run against a tree that is still being built. A shape they agreed on
 * informally would drift, and the drift would show up as a shell command running
 * halfway through an `npm ci`.
 *
 * ## Why it is core's `JobState` with one field intersected in
 *
 * Core owns the *choreography* around a job a Durable Object drives through its
 * alarm — arming, the single-flight guard, the staleness bound, the generation
 * marker a drain checks before it writes. This package owns what an install
 * specifically **is**: which package manager, which lockfile, what counts as
 * skippable. Splitting them along that line is what lets a second job on the
 * same object — a coding-agent run, say — reuse every rule without inheriting
 * `npm ci`.
 *
 * `JobState` intersects `TExtra` into its `running`/`done`/`failed` variants
 * instead of nesting it under `meta`, so this alias is byte-identical to the
 * hand-written union it replaced. Every reader still spells `status.command` at
 * the top level and no call site moved.
 *
 * The `/job` subpath landed in core **0.8.1** — before the rename, so under the
 * predecessor scope rather than this one — and once justified a peer floor of
 * `^0.8.1` rather than the `^0.8.0` the rest of this package would otherwise
 * have been content with: a consumer resolving 0.8.0 does not get a subtly
 * wrong type here, it gets an unresolvable import. That floor is no longer
 * this file's to argue for. `^0.9.0` is the range now, every core it admits
 * carries `/job`, and the constraint is the release train's.
 */
export type InstallState = JobState<{ command: string }>;

export interface InstallRule {
  /** How `package.json#packageManager` spells this one, e.g. `pnpm`. */
  manager: string;
  /** Lockfiles that select it, checked in this order. */
  lockfiles: readonly string[];
  /** What to run, from the checkout directory. */
  command: string;
}

export interface InstallPlan {
  /**
   * Rules in priority order. The first whose lockfile is present wins, so put
   * the manager you expect most often first.
   */
  rules: readonly InstallRule[];
  /**
   * What to run when there is a `package.json` but no lockfile at all. `null`
   * to install nothing rather than invent a command.
   */
  noLockfile: string | null;
  /**
   * Per-repository escape hatch, keyed `owner/repo`, beating everything below
   * it. For the repository that needs a build after its install, or a registry
   * token exported first.
   */
  overrides?: Readonly<Record<string, string>>;
  /** Ceiling for the install command. */
  timeoutMs?: number;
}

/**
 * What to do, and — always — why.
 *
 * The `reason` is not decoration. It goes into the tool result the model reads
 * when it asks why nothing was installed, and into the log an operator reads
 * when the wrong package manager ran. "no lockfile matched, and the plan
 * installs nothing without one" is a diagnosis; a bare `skip` is a mystery.
 */
export type InstallResolution =
  | {
      kind: "run";
      command: string;
      reason: string;
      /**
       * The lockfiles this install depends on, for {@link installFingerprint}.
       *
       * Plural, and empty rather than absent, because the three cases differ. A
       * rule match names the one lockfile that selected it. A `noLockfile`
       * install names none. An **override** names every lockfile the plan knows
       * of that is present, because an override replaces the whole command and
       * this layer cannot know which manager it drives — and hashing only
       * `package.json` there meant a lockfile-only commit reused a stale
       * `node_modules` in silence.
       */
      lockfiles: readonly string[];
    }
  | { kind: "skip"; reason: string };

/**
 * A sensible starting table, meant to be copied into a host and edited.
 *
 * npm last among the JavaScript managers on purpose: `package-lock.json` is the
 * one most likely to be present *and* stale in a repository that has since moved
 * to pnpm or yarn, so it is the weakest signal even though it is the commonest
 * file.
 */
export const DEFAULT_INSTALL_PLAN: InstallPlan = {
  rules: [
    {
      manager: "pnpm",
      lockfiles: ["pnpm-lock.yaml"],
      command: "corepack pnpm install --frozen-lockfile"
    },
    {
      manager: "yarn",
      lockfiles: ["yarn.lock"],
      /**
       * `--frozen-lockfile`, not `--immutable`, because the two failure modes are
       * not symmetric.
       *
       * The generations disagree: Berry takes `--immutable` and deprecates
       * `--frozen-lockfile`; Yarn 1 has only the latter. Given `--immutable`,
       * Yarn 1.22.22 does not reject it — on a lockfile disagreeing with
       * `package.json` it exits 0, prints "success Saved lockfile" and rewrites
       * the lockfile, the exact opposite of the flag's purpose, silently. Berry
       * 4.1.0 given `--frozen-lockfile` warns `YN0050: deprecated` and then
       * enforces immutability correctly.
       *
       * So one spelling is silently wrong on one generation and loudly deprecated
       * on the other, and this is the safe half. It matters most where it is least
       * visible: corepack's default `yarn` is 1.22.22, so an unpinned `yarn.lock`
       * — a legacy repository, which is most of them — runs Yarn 1.
       *
       * Revisit if Yarn removes the alias, which would make this the loud kind of
       * wrong on Berry.
       */
      command: "corepack yarn install --frozen-lockfile"
    },
    {
      manager: "bun",
      lockfiles: ["bun.lock", "bun.lockb"],
      command: "bun install --frozen-lockfile"
    },
    {
      manager: "npm",
      lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
      command: "npm ci --no-audit --no-fund"
    }
  ],
  noLockfile: "npm install --no-audit --no-fund",
  timeoutMs: 20 * 60_000
};

/** `pnpm@9.1.0+sha512.…` → `pnpm`. Undefined for anything unparseable. */
function pinnedManager(packageJson: string): string | undefined {
  try {
    const pin = (JSON.parse(packageJson) as { packageManager?: unknown })
      .packageManager;
    if (typeof pin !== "string") return undefined;
    const name = pin.split("@")[0]?.trim();
    return name || undefined;
  } catch {
    // A `package.json` that does not parse is the repository's problem, not
    // ours, and the install will surface it far more legibly than we can.
    return undefined;
  }
}

/**
 * Every lockfile the plan knows of that is present in `dir`.
 *
 * For an override, which replaces the whole command and tells this layer nothing
 * about which manager it drives.
 */
async function knownLockfiles(
  fs: InstallProbe,
  dir: string,
  plan: InstallPlan
): Promise<string[]> {
  const names = [...new Set(plan.rules.flatMap((r) => [...r.lockfiles]))];
  const present: string[] = [];
  for (const name of names) {
    if (await fs.exists(`${dir}/${name}`)) present.push(name);
  }
  return present;
}

/**
 * Decide how to install `dir`, reading only what the checkout says.
 *
 * `repo` is `owner/repo` when known, purely to look up an override; resolution
 * is otherwise identical without it.
 */
export async function resolveInstallCommand(
  fs: InstallProbe,
  dir: string,
  plan: InstallPlan,
  repo?: string
): Promise<InstallResolution> {
  const at = (name: string) => `${dir}/${name}`;

  const override = repo ? plan.overrides?.[repo] : undefined;
  if (override) {
    return {
      kind: "run",
      command: override,
      reason: `${repo} has an install override configured`,
      lockfiles: await knownLockfiles(fs, dir, plan)
    };
  }

  if (!(await fs.exists(at("package.json")))) {
    return { kind: "skip", reason: `no package.json in ${dir}` };
  }

  // The repository's own declaration beats any inference from files, because it
  // is the thing corepack will enforce anyway.
  const pinned = pinnedManager(await fs.readFile(at("package.json"), "utf8"));
  if (pinned) {
    const rule = plan.rules.find((r) => r.manager === pinned);
    if (rule) {
      const lockfile = await firstPresent(fs, dir, rule.lockfiles);
      return {
        kind: "run",
        command: rule.command,
        reason: `package.json pins packageManager to ${pinned}`,
        lockfiles: lockfile ? [lockfile] : []
      };
    }
    // Named a manager nothing here knows. Fall through rather than fail: the
    // lockfiles below may still identify it, and a wrong-but-working install
    // beats refusing to install at all.
  }

  for (const rule of plan.rules) {
    const lockfile = await firstPresent(fs, dir, rule.lockfiles);
    if (lockfile) {
      return {
        kind: "run",
        command: rule.command,
        reason: `found ${lockfile}`,
        lockfiles: [lockfile]
      };
    }
  }

  if (plan.noLockfile) {
    return {
      kind: "run",
      command: plan.noLockfile,
      reason: "package.json with no lockfile",
      lockfiles: []
    };
  }

  return {
    kind: "skip",
    reason: "no lockfile matched, and the plan installs nothing without one"
  };
}

/**
 * Files that change what an install produces without changing what it installs.
 *
 * A lockfile says which versions; these say how they are laid out, where they
 * come from, and what is patched on the way in. pnpm's `node-linker=hoisted` in
 * `.npmrc` produces a completely different `node_modules` from the same
 * lockfile, a registry line points the whole install somewhere else, and a
 * workspace manifest changes which packages are part of it at all.
 *
 * Fixed rather than declared per rule, deliberately. These are small, there are
 * few of them, and hashing one a repository does not use costs nothing — where a
 * per-rule `inputs` field would be public API for a list that is the same
 * everywhere, in a file that just gave up API for the same reason.
 */
const INSTALL_CONFIG_FILES = [
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pnpm-workspace.yaml",
  // Not configuration in the same sense as the rest: its `readPackage` hook
  // rewrites dependency manifests as the install reads them, so it changes what
  // `node_modules` becomes from a byte-identical lockfile.
  ".pnpmfile.cjs",
  "bunfig.toml"
] as const;

async function firstPresent(
  fs: InstallProbe,
  dir: string,
  names: readonly string[]
): Promise<string | null> {
  for (const name of names) {
    if (await fs.exists(`${dir}/${name}`)) return name;
  }
  return null;
}

/**
 * A content fingerprint of what the install depends on, for deciding whether an
 * existing `node_modules` is still the right one.
 *
 * Content, not mtime: a `git fetch && reset --hard` onto a new commit rewrites
 * these files whether or not their dependencies changed, and re-installing on
 * every commit would throw away the thing that makes a warm container worth
 * having.
 *
 * ## Both files, not just the lockfile
 *
 * `package.json` is hashed alongside the lockfile rather than only standing in
 * when there is no lockfile. The two disagree more often than they look like
 * they should: a commit can add a `postinstall`, bump the `packageManager` pin
 * from `pnpm@9` to `pnpm@10`, or add a dependency without regenerating the lock,
 * and every one of those changes what an install produces while leaving the
 * lockfile byte-identical. Hashing the lockfile alone calls that a match, skips
 * the install, and hands the subagent a `node_modules` that is quietly wrong —
 * which surfaces as a missing module in a build, three tool calls later, with
 * nothing pointing back at the install that never ran.
 *
 * The cost is the whole of the downside: a commit touching `package.json` for a
 * reason that does not affect installs — a version bump — buys one redundant
 * install. That is a far cheaper failure than the one above.
 *
 * ## An override is hashed against every lockfile the plan knows
 *
 * An override replaces the whole command, so this layer cannot know which manager
 * it drives or which lockfile it reads. Recording none would make the digest the
 * command plus `package.json` alone — so a commit changing only
 * `package-lock.json`, which is what a dependency bump is, matches the stored
 * fingerprint, skips the install, and leaves a `node_modules` a version behind.
 * {@link resolveInstallCommand} reports every lockfile the plan names that is
 * present, and all of them are hashed.
 *
 * ## And the manager's own configuration
 *
 * {@link INSTALL_CONFIG_FILES} is hashed too, for the same reason `package.json`
 * is: a lockfile says which versions, and `.npmrc` says how they are laid out.
 * Flipping pnpm's `node-linker` to `hoisted` produces a different
 * `node_modules` from a byte-identical lockfile, and a warm container would
 * otherwise skip the reinstall that change requires.
 *
 * The residual is worth stating because it cannot be closed here: an override
 * that *builds* — `npm ci && npm run build`, the documented example — is not
 * fingerprinted on the sources it builds from, because hashing `package.json`
 * cannot know what an arbitrary command reads. A host that needs a rebuild on
 * every source change should make its override cheap enough to run every time
 * rather than expect this to detect one.
 *
 * ## This is only half of the skip condition
 *
 * A matching fingerprint means "the same install would produce the same tree".
 * It does **not** mean the tree is there. `node_modules` lives in the container
 * and dies with it, while this fingerprint is stored in the Durable Object and
 * does not — so on a cold container the two disagree, and a caller that skips on
 * the fingerprint alone skips the install that the empty tree needs most. The
 * caller must also confirm `node_modules` is actually present.
 */
export async function installFingerprint(
  fs: InstallProbe,
  dir: string,
  resolution: InstallResolution
): Promise<string | null> {
  if (resolution.kind !== "run") return null;

  // Any of these being absent is ordinary — a bare `package.json` is a
  // repository, a `noLockfile` install has no lock by definition, and most
  // repositories configure none of the rest — so only the whole set being absent
  // means there is nothing to fingerprint at all.
  const names = [
    "package.json",
    ...resolution.lockfiles,
    ...INSTALL_CONFIG_FILES
  ];

  // Names as well as contents. Two lockfiles will not collide on content in
  // practice, but a digest that cannot say *which* file it read is one that
  // silently depends on the caller resolving them in the same order forever.
  let input = resolution.command;
  let found = false;
  for (const name of names) {
    if (!(await fs.exists(`${dir}/${name}`))) continue;
    found = true;
    input += `\n${name}\n${await fs.readFile(`${dir}/${name}`, "utf8")}`;
  }
  if (!found) return null;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
