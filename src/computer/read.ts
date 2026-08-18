import type { WorkspaceClient } from "@cloudflare/computer";
import { isGitInternal } from "./paths.js";

/**
 * Reading the workspace without pulling more of it across the boundary than the
 * model will be shown.
 *
 * Every function here exists because the obvious version reads everything and
 * then throws most of it away — which is the wrong shape against a Durable
 * Object's 128 MB, the same ceiling a `node_modules` push once breached. So the
 * budget is applied at the source, and the offsets handed back are the
 * *source's* rather than the rendered subset's, which is what makes the next
 * page exact instead of a guess.
 */

/**
 * Read a file without pulling more of it across the boundary than the model will
 * be shown.
 *
 * `readFile(path, "utf8")` materialises the whole file in the isolate and then
 * `truncateOutput` throws most of it away. That is harmless on a source file and
 * the wrong shape for the ceiling this plugin already lives under: a Durable
 * Object gets 128 MB, which is the same limit a `node_modules` push breached at
 * 429 MB, and `sb_read` is one model decision away from a lockfile, a bundle or a
 * captured build log. `@cloudflare/computer` 0.2 made the read range-addressable,
 * so the budget is enforced at the source rather than after the damage.
 *
 * Two reads rather than one, because the budget is spent from both ends for the
 * reason {@link truncateOutput} documents — the first error is at the top of a
 * file and the summary is at the bottom.
 *
 * ## The one place the budget is spent in bytes
 *
 * `maxChars` is a character ceiling everywhere else — see
 * {@link ComputerConfig.maxOutputChars} — and here it is spent against
 * `byteOffset`/`byteLength`, which are the only units the transport has. That is
 * deliberate and it is safe in the direction that matters: a UTF-8 byte is never
 * more than one UTF-16 code unit, so *N* bytes decode to at most *N* characters.
 * Reading the character budget as bytes therefore always honours the ceiling,
 * and errs low on a file that is mostly non-ASCII — a CJK source file is cut at
 * about a third of the characters it could have shown. The alternative is a
 * second round trip to measure what the first one returned, on every read, to
 * recover a bound the marker already announces.
 *
 * The other reason it cannot be characters is the one this function exists for:
 * bounding the *transport*. A byte range is what stops a 4 MB lockfile being
 * materialised in a 128 MB isolate before anything is thrown away.
 *
 * ## Why `stat` first
 *
 * Sizing off the returned string instead would be wrong in a way that hides
 * itself. `byteLength` counts bytes and `String.length` counts UTF-16 code units,
 * so a file of two-byte characters comes back *under* a character budget while
 * still being over the byte budget — and the read would look complete with half
 * the file missing and no marker saying so. One extra round trip buys the
 * distinction.
 *
 * A slice boundary can land mid-codepoint, which the decoder resolves to a single
 * replacement character. That is one glyph of noise at a cut that already
 * announces itself as a cut.
 */
export async function readBounded(
  fs: WorkspaceClient["fs"],
  path: string,
  maxChars: number
): Promise<string> {
  const { size } = await fs.stat(path);
  if (size <= maxChars) return fs.readFile(path, "utf8");

  // Names the way out, rather than only the size of the hole. Before `offset`
  // existed the honest answer was "use sb_exec with sed", which needs a live
  // container — the dependency these tools exist to remove.
  const marker = (dropped: number, at: number) =>
    `\n\n… [${dropped} bytes omitted from the middle — read them with ` +
    `\`offset: ${at}\`] …\n\n`;

  const half = Math.floor((maxChars - marker(size, size).length) / 2);
  // No budget for two ends plus the marker: keep the head, where the first error
  // is. The same fallback `truncateOutput` makes at the same ceiling.
  if (half < 1)
    return fs.readFile(path, {
      encoding: "utf8",
      byteLength: Math.max(0, maxChars)
    });

  const [head, tail] = await Promise.all([
    fs.readFile(path, { encoding: "utf8", byteOffset: 0, byteLength: half }),
    fs.readFile(path, {
      encoding: "utf8",
      byteOffset: size - half,
      byteLength: half
    })
  ]);
  return head + marker(size - half * 2, half) + tail;
}

/**
 * A byte window the model asked for, with its coordinates stated.
 *
 * No middle-out here, deliberately: {@link readBounded} guesses at what matters when
 * nobody said, but an explicit `offset` *is* the model saying. Trimming the middle
 * of a region it chose would defeat the request and, worse, make the next offset
 * unknowable.
 *
 * The window line is what makes paging work at all — the model needs to know where
 * it landed and how much is left to compute the next `offset`.
 */
export async function readWindow(
  fs: WorkspaceClient["fs"],
  path: string,
  offset: number,
  length: number,
  maxChars: number
): Promise<string> {
  const { size } = await fs.stat(path);
  if (offset >= size)
    return `(offset ${offset} is past the end of ${path}, which is ${size} bytes)`;

  const byteLength = Math.min(length, maxChars, size - offset);
  const body = await fs.readFile(path, {
    encoding: "utf8",
    byteOffset: offset,
    byteLength
  });
  const end = offset + byteLength;
  const rest = end < size ? `; ${size - end} bytes after this` : "";
  return `${body}\n--- bytes ${offset}–${end} of ${size}${rest} ---`;
}

/**
 * Fetch a page, drop what is off-limits, and keep the source offsets that make the
 * *next* page exact.
 *
 * The subtle part is why `rawIndex` exists at all. `offset` counts items at the
 * source; the caller renders a filtered, budget-trimmed subset of them. So the
 * obvious `nextOffset = offset + shown` is wrong — it silently skips or repeats
 * whenever anything was dropped, which is precisely when `.git` is involved. Keeping
 * each survivor's source index means the next page starts exactly after the last one
 * the model actually saw.
 *
 * Retries because `.git` can outnumber a whole page on its own: at a repo root it is
 * walked *first* (`.` sorts before alphanumerics) and holds thousands of objects, so
 * one fetch can come back entirely excluded. `maxRounds` is the caller's, and the
 * asymmetry is deliberate — a `find` retry re-walks dirents, which is cheap SQLite
 * reads, while a `grep` retry re-reads and re-scans every file it already looked at.
 *
 * Deliberately no slicing to `want`: the caller needs the extra item to know a next
 * page exists, and its index to say where.
 */
export async function collectVisible<T>(
  fetch: (offset: number, limit: number) => Promise<T[]>,
  pathOf: (item: T) => string,
  want: number,
  offset: number,
  maxRounds: number
): Promise<{
  items: T[];
  /** Source offset of `items[i]`. */
  rawIndex: number[];
  /** Source offset just past everything examined. */
  rawEnd: number;
  /** The source ran out; there is no next page. */
  exhausted: boolean;
  /** Rounds ran out while excluded paths still dominated. */
  crowded: boolean;
}> {
  const items: T[] = [];
  const rawIndex: number[] = [];
  let cursor = offset;
  let exhausted = false;
  let rounds = 0;

  // One past `want`, so a next page is detected without a further round trip.
  while (items.length <= want && rounds < maxRounds) {
    rounds += 1;
    const batch = await fetch(cursor, want + 1);
    batch.forEach((item, i) => {
      if (isGitInternal(pathOf(item))) return;
      items.push(item);
      rawIndex.push(cursor + i);
    });
    cursor += batch.length;
    if (batch.length <= want) {
      exhausted = true;
      break;
    }
  }

  return {
    items,
    rawIndex,
    rawEnd: cursor,
    exhausted,
    crowded: !exhausted && items.length <= want
  };
}

/** What a page of a collected listing owes the caller once it knows how much fit. */
interface VisiblePage {
  rawIndex: number[];
  rawEnd: number;
  exhausted: boolean;
  crowded: boolean;
}

/**
 * The "there is more, here is where" line, with an offset that is actually correct.
 *
 * `rawIndex[shown]` rather than `offset + shown`: the first item the model did *not*
 * see, at its source coordinate. Anything else drifts by however many entries the
 * `.git` filter removed, and drifts silently — the next page would repeat or skip
 * with nothing to indicate it had.
 *
 * Narrowing is still offered, and still first-class, because it is cheaper than
 * paging: `offset` does not skip the walk, it only discards its early results. It is
 * offered as the better option rather than the only one, which is the thing the
 * previous wording got wrong — "narrow it" is no answer at all when the model wants
 * the next page of a list it is working through.
 */
export function listingNote(
  page: VisiblePage,
  shown: number,
  noun: string,
  narrower: string
): string {
  const next =
    shown < page.rawIndex.length
      ? page.rawIndex[shown]
      : page.exhausted
        ? undefined
        : page.rawEnd;
  if (next === undefined) return "";
  return (
    `\n\n… showed ${shown} ${noun}; there are more. Continue with ` +
    `\`offset: ${next}\`, or narrow with ${narrower} — narrowing is cheaper, ` +
    `since an offset still walks everything it skips.`
  );
}

/**
 * Does this path exist?
 *
 * `getWorkspace()` types `fs` as the in-process `WorkspaceFilesystem`, but the
 * value on the far side of a Durable Object boundary is a
 * `WorkspaceFilesystemStub`, which carries a few methods the local class does
 * not — `exists` among them. So the fast path is asked for rather than cast to,
 * and `stat` is the fallback for a host that hands back a local workspace.
 *
 * The fallback treats *any* `stat` failure as absence, which is the honest
 * reading for a tool whose entire answer is a boolean: there is no error channel
 * to distinguish "missing" from "unreadable", and the caller's next move — look
 * somewhere else — is the same either way.
 */
export async function pathExists(
  fs: WorkspaceClient["fs"],
  path: string
): Promise<boolean> {
  const probe = (fs as { exists?: (p: string) => Promise<boolean> }).exists;
  if (typeof probe === "function") return probe.call(fs, path);
  return fs.stat(path).then(
    () => true,
    () => false
  );
}
