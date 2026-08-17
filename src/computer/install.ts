/**
 * Working out how a repository installs its dependencies, mechanically.
 *
 * This lives here — in the plugin — because the *procedure* is the same
 * everywhere: look at what the repository actually contains, in a fixed order,
 * and never guess. The **commands** live in the host, because they are a
 * deployment's business: one repository wants `--frozen-lockfile`, another needs
 * a private registry preamble, a third has to build after installing. See
 * {@link InstallPlan.overrides}.
 *
 * ## Why this exists at all
 *
 * The rule used to be a sentence in the subagent's soul — "install dependencies
 * before you do anything else". A production run edited a README, ran
 * `prettier --check` on that one file, and reported the change verified; nothing
 * was installed and the project's gate never ran. A standard with no command
 * attached is one a model satisfies with whichever check is cheapest.
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
 */
export type InstallState =
  | { state: "idle" }
  | { state: "skipped"; reason: string }
  | { state: "running"; command: string; startedAt: number; tail?: string }
  | {
      state: "done";
      command: string;
      exitCode: number;
      finishedAt: number;
      ms: number;
      tail?: string;
    }
  | {
      state: "failed";
      command: string;
      finishedAt: number;
      error: string;
      exitCode?: number;
      tail?: string;
    };

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
  | { kind: "run"; command: string; reason: string; lockfile: string | null }
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
      command: "corepack yarn install --immutable"
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
      lockfile: null
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
        lockfile
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
        lockfile
      };
    }
  }

  if (plan.noLockfile) {
    return {
      kind: "run",
      command: plan.noLockfile,
      reason: "package.json with no lockfile",
      lockfile: null
    };
  }

  return {
    kind: "skip",
    reason: "no lockfile matched, and the plan installs nothing without one"
  };
}

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

  // An override can name a command with no lockfile behind it, and a bare
  // `package.json` is a repository too — so either file being absent is
  // ordinary, and only the pair being absent means there is nothing to
  // fingerprint at all.
  const names = [
    "package.json",
    ...(resolution.lockfile ? [resolution.lockfile] : [])
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
