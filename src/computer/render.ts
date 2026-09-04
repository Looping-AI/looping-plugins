import type {
  WorkspaceClient,
  WorkspaceRuntimeStatus
} from "@cloudflare/computer";

/**
 * Turning a result into the text a model reads.
 *
 * One theme runs through all of it: every function here spends a byte budget,
 * and each spends it in the shape its content wants. A command transcript is
 * cut from the middle, because the first error and the final summary are what
 * matter and the middle is noise. A listing or a match set is emitted whole item
 * by whole item until the budget runs out, because cutting *its* middle loses a
 * whole file's worth of hits with nothing to say it happened. Getting those two
 * the wrong way round is the mistake they are kept apart to prevent.
 */

/**
 * How much of one matching line the model is shown.
 *
 * A grep match carries the whole line, and a minified bundle is one line of
 * megabytes — a single match in `dist/` would otherwise be the entire result. The
 * head is kept because a match's file and line number are what the model acts on;
 * it reads the region with `sb_read` next.
 */
const MAX_MATCH_LINE_CHARS = 200;

/**
 * Middle-out truncation, so both the first error and the final summary survive.
 *
 * The guard is not defensive padding. Without it a `max` at or below the marker's
 * own length makes `half` zero or negative, and `slice(-0)` is `slice(0)` — the
 * *whole* string — so the function returns more than it was given: 500 characters
 * in, 543 out at `max: 80`. A silent inversion of the one thing it does,
 * reachable from a public config field.
 */
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const marker = (dropped: number) =>
    `\n\n… [${dropped} characters omitted from the middle] …\n\n`;

  // No budget for two halves plus the marker: keep the head, which is where the
  // first error is, and say nothing clever.
  const half = Math.floor((max - marker(text.length).length) / 2);
  if (half < 1) return text.slice(0, Math.max(0, max));

  return (
    text.slice(0, half) + marker(text.length - half * 2) + text.slice(-half)
  );
}

/**
 * A byte count in the form a model can act on.
 *
 * A listing that says a file is 4.2 MB tells the model the read it is about to do
 * comes back with a hole in the middle — the one thing it cannot infer from the
 * truncated result itself.
 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One `fs.grep` hit, derived from the client rather than imported.
 *
 * `@cloudflare/computer` declares `WorkspaceGrepMatch` but does not re-export it,
 * so there is no name to import. Reading it back off the method keeps this correct
 * by construction — the same structural approach {@link readBounded} takes to `fs`.
 */
type GrepMatch = Awaited<ReturnType<WorkspaceClient["fs"]["grep"]>>[number];

/** One matching line, bounded — see {@link MAX_MATCH_LINE_CHARS}. */
function capLine(text: string): string {
  // A CRLF file leaves the carriage return on every line, since the reader splits
  // on `\n` alone. Invisible in the output and pure noise in the token count.
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  return line.length <= MAX_MATCH_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_MATCH_LINE_CHARS)}… [+${line.length - MAX_MATCH_LINE_CHARS} chars]`;
}

/**
 * Emit whole items until the byte budget is spent, and report exactly how many.
 *
 * {@link truncateOutput} is wrong for every list this module produces, and is
 * deliberately not used by them. It keeps both ends and drops the middle, which is
 * right for a build log — first error, final summary — and destructive for a match
 * list or a directory listing, where the middle is a whole file's worth of hits or a
 * whole subtree that silently vanishes. So the budget is spent item by item, in
 * order, and the caller learns where it stopped.
 *
 * `shown` is the load-bearing return value: it is what makes the next page's offset
 * exact rather than a guess. A block is committed whole or not at all, because half
 * a match's context reads like a corrupt result — and the first block always goes
 * out, so one enormous item cannot produce an empty answer.
 */
export function packBlocks(
  blocks: string[][],
  maxChars: number
): { body: string; shown: number } {
  const out: string[] = [];
  let used = 0;
  let shown = 0;

  for (const block of blocks) {
    const cost = block.reduce((n, line) => n + line.length + 1, 0);
    if (shown > 0 && used + cost > maxChars) break;
    out.push(...block);
    used += cost;
    shown += 1;
  }

  return { body: out.join("\n"), shown };
}

/**
 * Search results, in the shape `grep -n` has trained every model to read.
 *
 * ## Grouped by file
 *
 * Matches arrive contiguous per file — `fs.grep` walks a generator of files — so
 * grouping is free, and it is worth taking: an absolute path in this workspace is
 * ~40 characters, and repeating it on 200 lines spends more of the budget on paths
 * than on code.
 *
 * `:` marks a matching line and `-` a context line, which is `grep`'s own
 * convention. In the payload the distinction is only `isMatch`, and losing it would
 * leave the model unable to tell which line it actually searched for.
 *
 * Only a *suffix* is ever dropped, so grouping survives the cut: a header is emitted
 * whenever the path changes, and no earlier block can disappear from under a later
 * one.
 *
 * `capped` reports whether any line was shortened, so the caller can say once — not
 * once per line — how to reach the full text.
 */
export function renderGrepMatches(
  matches: GrepMatch[],
  maxChars: number
): { body: string; shown: number; capped: boolean } {
  let path: string | undefined;
  const blocks: string[][] = [];
  const hasLongLine: boolean[] = [];

  matches.forEach((match, i) => {
    const block: string[] = [];
    // A blank line before every file but the first, so the groups separate.
    if (match.path !== path)
      block.push(i === 0 ? match.path : `\n${match.path}`);
    path = match.path;

    // `context` already contains the matching line, flagged — so it replaces the
    // bare one rather than being added around it.
    const body = match.context?.length
      ? match.context
      : [{ line: match.line, text: match.text, isMatch: true }];

    hasLongLine.push(body.some((l) => l.text.length > MAX_MATCH_LINE_CHARS));
    for (const line of body)
      block.push(
        `  ${line.line}${line.isMatch ? ":" : "-"} ${capLine(line.text)}`
      );

    blocks.push(block);
  });

  const { body, shown } = packBlocks(blocks, maxChars);
  // Only a line that actually made it out is worth explaining.
  return { body, shown, capped: hasLongLine.slice(0, shown).includes(true) };
}

/** Elapsed time in the shape a sentence wants. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Render a completed command the way a terminal would, minus the noise.
 *
 * ## Every command ends with its verdict, including the successful ones
 *
 * Printing the exit code only when it is non-zero looks like saving noise and is
 * not: a model with no verdict appends `; echo "EXIT_CODE=$?"` itself, and
 * reaches for `${PIPESTATUS[0]}` to read a piped one — which dash does not
 * implement, so the whole line fails after the command it wrapped has run.
 *
 * ## `status` is not the exit code
 *
 * `WorkspaceRuntimeStatus` is `completed | failed | cancelled`. Dropping it
 * renders a command killed at the `timeoutMs` ceiling exactly like one that ran
 * to completion and failed — "your test suite was killed at ten minutes" and
 * "your test suite has a failing test", which want opposite responses. Anything
 * other than `completed` is stated.
 *
 * ## One budget, applied once
 *
 * Truncating per stream makes `maxOutputChars` mean "up to twice this". The bound
 * is on the rendered transcript, which is what reaches the context window.
 */
export function renderResult(
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    status?: WorkspaceRuntimeStatus;
  },
  maxChars: number
): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  // Empty whenever the host configured a `shell`, which merges the streams at the
  // source so the transcript keeps its causal order. Kept for hosts that did not:
  // two labelled blocks beat silently dropping half the output.
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);

  const body = truncateOutput(parts.join("\n"), maxChars);
  const state =
    result.status && result.status !== "completed" ? ` (${result.status})` : "";
  const verdict = `--- exit ${result.exitCode}${state} ---`;
  return body ? `${body}\n${verdict}` : `(no output)\n${verdict}`;
}

/**
 * Why a command has nothing to show for itself.
 *
 * {@link renderResult} states a non-`completed` status on its verdict line;
 * {@link computerExec} has no verdict line, only the four fields its caller
 * branches on. A *killed* process writes nothing, so without this a `git clone`
 * that hit the ten-minute ceiling reaches the model through
 * `@dynamicagents/plugins/repo` as `clone failed:` with an empty reason — which reads
 * like a bug in the plugin rather than a limit it can work within.
 *
 * Only `cancelled`. A `failed` status is an ordinary non-zero exit, where the
 * command's own stderr is the better explanation and this would be noise on top
 * of it.
 *
 * Both plausible causes are named because the exit code cannot separate them:
 * 137 is SIGKILL, which is what the timeout sends *and* what the kernel sends a
 * container that ran out of memory.
 */
export function cancelledNote(
  status: WorkspaceRuntimeStatus | undefined,
  exitCode: number,
  timeoutMs: number
): string | undefined {
  if (status !== "cancelled") return undefined;
  return (
    `the command was killed rather than exiting on its own (exit ${exitCode}), so ` +
    `anything it had not yet written is gone. The two usual causes are the ` +
    `per-command time limit — ${humanMs(timeoutMs)} here — and the container ` +
    `running out of memory.`
  );
}
