#!/usr/bin/env node
/**
 * Install the sibling `looping-core` checkout into this repo, for developing
 * across the two at once.
 *
 * `npm pack` + tarball install, deliberately — **not `npm link`**, and not a
 * `file:` dependency either:
 *
 * - `npm link` symlinks the checkout, which gives it its own `node_modules` and
 *   so its own copy of every peer. Two copies of `agents` in one Worker bundle
 *   breaks the `Session` / `SessionMessage` types and every `instanceof`, and it
 *   breaks at runtime rather than at the type level, which is the worst place to
 *   find out.
 * - A `file:` dependency has the same duplication hazard and additionally hides
 *   packing mistakes: a file missing from `package.json#files` still resolves
 *   locally and 404s for everyone else.
 *
 * A tarball is what npm actually publishes, so if it works here it works from the
 * registry. Nothing is written to `package.json` — this leaves the manifest's
 * published semver ranges alone, so a plain `npm install` (and CI, which never
 * runs this) always builds against the real packages.
 *
 * ## Why this repo needs it
 *
 * `@loopingai/core` is a **peer** dependency here, so a plain `npm install`
 * resolves it from the registry — and will happily overwrite a local build of it
 * that you are in the middle of testing against. The failure is quiet and
 * misleading: the next `tsc` reports type errors in *this* repo's source, for a
 * contract change that is sitting uninstalled one directory away. That happened
 * twice while adapting to core 0.4.1.
 *
 * Re-run it after changing core, and after any `npm install` here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Checkouts this repo builds against. A missing one is an error. */
const SIBLINGS = ["looping-core"];

/**
 * Packed too when present, skipped when not.
 *
 * `looping-a2a-protocol` is core's own dependency rather than this repo's —
 * nothing here imports it — so it normally arrives transitively from the
 * registry. But a local core built against an unpublished protocol change needs
 * that change installed too, or the tarball resolves the published copy and the
 * two disagree.
 */
const OPTIONAL_SIBLINGS = ["looping-a2a-protocol"];

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "looping-pack-"));
const tarballs = [];

for (const name of [...SIBLINGS, ...OPTIONAL_SIBLINGS]) {
  const dir = path.resolve(root, "..", name);
  if (!existsSync(dir)) {
    if (OPTIONAL_SIBLINGS.includes(name)) {
      console.log(`${name} not checked out — using the published package.`);
      continue;
    }
    console.error(
      `${name} not found at ${dir}.\n` +
        "Check out the repos as siblings, or skip this script and use the " +
        "published packages."
    );
    process.exit(1);
  }
  console.log(`packing ${name}…`);
  // `npm pack` runs the package's own `prepack`, so this builds `dist/` and runs
  // its export verification — the same gate a real publish passes.
  execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: dir,
    stdio: "inherit"
  });
}

for (const file of readdirSync(out)) {
  if (file.endsWith(".tgz")) tarballs.push(path.join(out, file));
}

console.log(`installing ${tarballs.length} tarball(s)…`);
// `--no-save` keeps the published ranges in package.json intact.
execFileSync("npm", ["install", "--no-save", ...tarballs], {
  cwd: root,
  stdio: "inherit"
});

/**
 * Restore the lockfile if npm rewrote it to point at the temp tarballs.
 *
 * `--no-save` protects the *manifest*, not the lockfile: npm can still pin
 * `@loopingai/*` to `file:/var/folders/…/looping-pack-*.tgz`. Those paths do not
 * exist on a CI runner — or on this machine once the temp dir is cleaned — so the
 * damage surfaces as a failed install belonging to whoever pulls next, with no
 * connection to the command that caused it.
 *
 * Restoring is safe precisely because the linked install is meant to be
 * throwaway: `node_modules` keeps the local tarballs, the lockfile keeps
 * describing the registry, and a plain `npm install` puts the two back in step.
 */
const lockfile = path.join(root, "package-lock.json");
if (existsSync(lockfile)) {
  const lock = readFileSync(lockfile, "utf8");
  if (/"resolved":\s*"file:[^"]*looping-pack-/.test(lock)) {
    execFileSync("git", ["checkout", "--", "package-lock.json"], {
      cwd: root,
      stdio: "inherit"
    });
    console.log(
      "restored package-lock.json — npm had pinned a @loopingai/* entry to a " +
        "temp tarball path that only exists on this machine, until it doesn't."
    );
  }
}

console.log("done. Re-run after changing core, or after any `npm install`.");
