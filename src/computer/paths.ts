/**
 * Which paths these tools act on, and the sentence a refused one gets.
 *
 * Two lists that look alike and mean opposite things. `node_modules` is *absent*
 * — physics, decided by `computerd` — so its note explains a file that is really
 * there and names the tool that can reach it. `.git` is present, readable, and
 * refused anyway — policy, decided here — so its note names where repository work
 * belongs. Two reasons want two sentences, which is why they are not one list.
 *
 * Everything here is a string comparison: no filesystem, no `await`, which is
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
 * Refused because a model that edits `.git/HEAD` or `.git/config` corrupts a
 * checkout in a way that surfaces much later as an inexplicable git failure.
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
 * Names a route deliberately: a refusal with no destination is worse than no
 * refusal, because the model retries and then works around it.
 *
 * What it must never name is `sb_exec`. That hands back the exact capability
 * being withheld, in the one place the model is already looking for a way around
 * it, with the tool's own authority behind it. `sb_exec` is unguarded because a
 * shell takes an opaque command string and pattern-matching git out of one is
 * neither reliable nor this guard's job — a fact about the implementation, not a
 * route to advertise.
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
 * comparisons — no `stat`, no round trip — which is why all six tools can afford
 * to call it before the workspace is opened.
 *
 * ## A redirect, not a boundary
 *
 * `node_modules` is a fact about the substrate and the note names the tool that
 * can see it; `.git` is a rule about where repository work belongs and the note
 * names the tools it belongs to. Both catch the case that actually happens — a
 * model reaching into `.git/HEAD` to fix a merge, or reading a dependency's
 * source and finding nothing there.
 *
 * It is not containment, and this is the only place worth saying so. `sb_exec`
 * is in the same tool family, granted per family rather than per tool, so every
 * agent holding these six also holds a shell that reads and writes `.git`
 * directly.
 *
 * Symlinks are not resolved, for the same reason: a tracked
 * `docs/notes.md -> ../.git/config` only matters to an agent given these tools
 * *without* the shell, which the family granularity makes unbuildable. If that
 * ever becomes buildable, the **write** path is the half to restore —
 * `.git/config` is an input to the credentialed push, and a planted hook runs
 * under a container-side `repo_commit`. Reading `.git` discloses nothing that is
 * not already readable, so the read half is not worth an `lstat` per call. The
 * shape would be to resolve every ancestor rather than the final component,
 * `lstat`ing the prefixes in parallel for one round trip rather than one per
 * segment.
 */
export function guardPath(path: string, verb: string): string | undefined {
  if (isContainerOnly(path)) return containerOnlyNote(path, verb);
  if (isGitInternal(path)) return gitInternalNote(path, verb);
  return undefined;
}
