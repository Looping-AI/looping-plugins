/**
 * Which paths these tools act on, and the sentence a refused one gets.
 *
 * Two lists that look alike and mean opposite things. `node_modules` is
 * *absent* — physics, decided by `computerd` — so its note explains a file that
 * is really there and names the tool that can reach it. `.git` is present,
 * readable, and refused anyway — policy, decided here — so its note names where
 * repository work belongs instead. Two reasons want two sentences, which is why
 * they are not one list.
 *
 * Everything here is a string comparison: no filesystem, no `await`. That is
 * what lets {@link guardPath} run before a tool opens the workspace at all.
 */

/**
 * Whether a path sits under a directory the workspace never receives.
 *
 * Only `node_modules` today, and it is not configurable here because it is not
 * our choice: `computerd` applies its own `DEFAULT_IGNORE` container-side, and
 * this list exists to *predict* that so a read can explain itself rather than
 * reporting a missing file. A dependency the model can plainly see in a `ls` but
 * cannot read is the kind of thing that sends it hunting for the wrong bug.
 */
const CONTAINER_ONLY_SEGMENTS = ["node_modules"];

export function isContainerOnly(path: string): boolean {
  return path
    .split("/")
    .some((segment) => CONTAINER_ONLY_SEGMENTS.includes(segment));
}

/** The sentence a container-only path gets instead of "not found". */
function containerOnlyNote(path: string, verb: string): string {
  return (
    `${path} is inside node_modules, which lives only in the container and is ` +
    `not part of the durable workspace — ${verb} cannot see it. Use \`sb_exec\` ` +
    `(for example \`cat ${path}\`) to read it through the shell instead.`
  );
}

/**
 * Is this path inside git's internal state?
 *
 * The mirror image of {@link isContainerOnly}, and the distinction is worth keeping
 * rather than merging the two lists. `node_modules` is *absent* — physics, decided
 * by `computerd`, and the note explains a missing file. `.git` is present and
 * readable and is refused anyway — policy, decided here, because a model that edits
 * `.git/HEAD` or `.git/config` corrupts a checkout in a way that surfaces much later
 * as an inexplicable git failure. Two reasons want two sentences.
 *
 * Exact segment rather than substring, so `.gitignore`, `.gitattributes` and
 * `.github/` are untouched — the same trap `node_modules_old` sets one function up.
 */
export function isGitInternal(path: string): boolean {
  return path.split("/").includes(".git");
}

/**
 * The sentence a `.git` path gets.
 *
 * Names the route deliberately. A refusal with no destination is a worse tool than
 * no refusal at all: the model retries, then works around it. So it points at the
 * repo tools, which is where repository work actually belongs.
 *
 * What it must never do is point at `sb_exec`. That would hand back the exact
 * capability this refusal withholds, in the one place the model is already looking
 * for a way around it — and it would do so with the tool's own authority behind it.
 * `sb_exec` is unguarded because a shell takes an opaque command string and
 * pattern-matching git out of one is neither reliable nor this guard's job; that is
 * a fact about the implementation, not a route to advertise.
 */
function gitInternalNote(path: string, verb: string): string {
  return (
    `${path} is inside .git — git's internal state, which ${verb} does not touch. ` +
    `Reading it tells you less than the repository tools do, and writing it ` +
    `corrupts the checkout. Repository work goes through the repo tools ` +
    `(\`repo_status\`, \`repo_diff\`, \`repo_commit\`, \`repo_push\`), which the ` +
    `main agent holds. If this task needs git state you cannot get that way, say ` +
    `so in your result rather than reaching into .git yourself.`
  );
}

/**
 * The path check every file tool makes, before it opens anything.
 *
 * Returns the sentence to hand back, or `undefined` to proceed. Two string
 * comparisons — no `stat`, no round trip — which is why every one of the six can
 * afford to call it, and why it is called before the workspace is opened rather
 * than after.
 *
 * ## What this is, and what it is not
 *
 * It is a **redirect**. `node_modules` is a fact about the substrate and the note
 * names the tool that can see it; `.git` is a rule about where repository work
 * belongs and the note names the tools it belongs to. Both catch the case that
 * actually happens — a model reaching into `.git/HEAD` or `.git/config` to fix a
 * merge, or reading a dependency's source and finding nothing there.
 *
 * It is not a boundary, and this comment is the only place that is worth saying.
 * `sb_exec` is in the same tool family, granted per family rather than per tool,
 * so every agent holding these six holds a shell that reads and writes `.git`
 * directly; pattern-matching git out of an opaque command string is neither
 * reliable nor this guard's job.
 *
 * This once resolved a final symlink as well, against a cloned repository
 * shipping `docs/notes.md -> ../.git/config`. That only ever mattered for a host
 * granting the file tools *without* the shell, which the family granularity makes
 * unbuildable — so it was deleted rather than extended to the other three tools.
 *
 * ## What would bring it back
 *
 * An agent given these tools *without* `sb_exec` — a reviewing parent, a
 * shell-less reviewer. Then a hostile repository's tracked symlink is live
 * again, and the **write** path is the half worth restoring rather than this
 * one: `.git/config` is an input to the credentialed push, since
 * `@loopingai/plugins/repo` reads the destination out of it with
 * `git remote get-url origin`, and a planted hook still runs under a
 * container-side `repo_commit`. Reading `.git` discloses nothing that is not
 * already readable, which is why the read half is not worth an `lstat` per call.
 *
 * The shape, if it is ever needed: resolve every ancestor rather than only the
 * final component, `lstat`ing the path's prefixes in parallel so it costs one
 * round trip rather than one per segment.
 */
export function guardPath(path: string, verb: string): string | undefined {
  if (isContainerOnly(path)) return containerOnlyNote(path, verb);
  if (isGitInternal(path)) return gitInternalNote(path, verb);
  return undefined;
}
