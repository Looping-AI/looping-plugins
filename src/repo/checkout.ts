/**
 * The state of a checkout that is already on disk.
 *
 * Kept out of `index.ts` so it can be tested without building a `ToolSet` — the
 * two runners it needs arrive as parameters, which is the whole reason the seam
 * exists. `refreshCheckout` in particular has more refusal paths than any tool in
 * the plugin, and one of them (a dirty tree) guards work nobody can recover.
 */

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

/**
 * What this module needs back from a git command.
 *
 * A structural subset of `index.ts`'s `RunResult` rather than an import of it,
 * so the dependency runs one way: `index.ts` knows about this file, and this file
 * knows only about the shape of an answer. `unreachable` is the field that earns
 * the type — a command that *ran and failed* has answered the question it was
 * asked, and one that never ran has answered nothing, which two refusals below
 * depend on telling apart.
 */
export interface GitAnswer {
  success: boolean;
  stdout: string;
  stderr: string;
  unreachable?: true;
}

/** The two runners `refreshCheckout` borrows from `buildRepoTools`. */
export interface GitRunners {
  plain: (
    args: string,
    cwd: string,
    vars?: Record<string, string>
  ) => Promise<GitAnswer>;
  /**
   * The whole credential-bearing half, as one call rather than a runner.
   *
   * `refreshCheckout` used to be handed a credentialed runner and pointed it at
   * the checkout. It cannot be, and the reason is the point of this whole file:
   * a credential never goes anywhere near the container. What it borrows now is
   * the finished operation, which happens somewhere else entirely.
   */
  fetchOrigin: (dir: string, url: string) => Promise<GitAnswer>;
}

/**
 * The repository's own default branch, as the checkout records it.
 *
 * Two callers wrote out the same `symbolic-ref` and the same `origin/` strip:
 * {@link refreshCheckout} picks the branch to land on, `repo_push` finds the
 * branch it must refuse to push to.
 *
 * It returns a pair rather than a `string | undefined`, and that is the half a
 * plain extraction would have lost. A *failed* read means "this repository has no
 * `origin/HEAD`, so there is no default branch to protect", which is a fair
 * reading of an answer and a terrible reading of silence — and `repo_push` stands
 * its guards down on the strength of it. A command that never ran has answered
 * nothing, so it says so separately.
 */
export async function resolveDefaultBranch(
  plain: GitRunners["plain"],
  dir: string
): Promise<{ branch?: string; unreachable?: string }> {
  const head = await plain(
    "symbolic-ref --short refs/remotes/origin/HEAD",
    dir
  );
  if (head.unreachable) return { unreachable: head.stderr };
  return head.success
    ? { branch: head.stdout.trim().replace(/^origin\//, "") }
    : {};
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
export async function refreshCheckout({
  dir,
  url,
  branch,
  plain,
  fetchOrigin
}: GitRunners & {
  dir: string;
  url: string;
  branch: string | undefined;
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

  const fetched = await fetchOrigin(dir, url);
  if (!fetched.success)
    return { message: `fetch failed: ${fetched.stderr || fetched.stdout}` };

  // The branch to land on: the one asked for, else the remote's own default.
  let target = branch;
  if (!target) {
    const head = await resolveDefaultBranch(plain, dir);
    // Distinguished here for the first time: a container that never answered is
    // not a repository without a default branch, and "could not determine" sent
    // the model looking at the repository either way.
    if (head.unreachable)
      return {
        message: `could not read the default branch for ${url}: ${head.unreachable}`
      };
    target = head.branch;
  }
  if (!target)
    return { message: `could not determine a default branch for ${url}` };

  // The one place in this plugin where a model-authored value lands in git's
  // *operand* position — everywhere else it is prefixed (`origin/…`,
  // `refs/heads/…`) or is the value of a flag. Quoting is not enough here: it
  // stops word-splitting, not option parsing, so `--detach` would be read as an
  // option. `repo_clone` rejects such a name with `UNSAFE_BRANCH` before this
  // runs, and that is a precondition of calling this function rather than an
  // accident of the caller.
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
