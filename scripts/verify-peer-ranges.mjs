#!/usr/bin/env node
/**
 * The one field in `package.json` that nothing else reads.
 *
 * npm does not validate a package against its own `peerDependencies`. Measured,
 * not assumed: a manifest declaring `agents` as a peer at `^0.21.0` alongside a
 * devDependency of `^0.22.0` installs 0.22.0 with no error, no warning, and
 * `npm ls` reports the tree as valid. Arborist resolves the root's peers for
 * *consumers*; it never turns them back on the root.
 *
 * So a peer range is prose until something asserts it. `tsc` reads the installed
 * copy, the specs run against the installed copy, and the range — the only part
 * a consumer actually installs against — can say anything at all. A `0.x` caret
 * is where that bites first: it locks to the *minor*, so it shuts every consumer
 * out of the next one while the build here stays green.
 *
 * Offline and deterministic, which is why it belongs in `check`:
 *
 *   1. Every installed peer satisfies its declared range. What the specs ran
 *      against is what a consumer is told to bring.
 *   2. Every required peer is installed at all. If it is not, nothing here has
 *      ever exercised it, and check 1 has nothing to stand on.
 *   3. Every `peerDependenciesMeta` key names a real peer. npm ignores a stale
 *      one in silence, so a renamed peer that leaves its `optional: true` behind
 *      becomes required without anyone deciding that.
 *
 * Peers are read from the installed tree rather than from `devDependencies`,
 * because the two are not the same set. A peer can arrive transitively and still
 * be the copy this package resolves, and that copy is what every check here ran
 * against — so it is the one the range has to describe.
 *
 * `--latest` is the other half, and is deliberately **not** in `check`, which has
 * no network. It asks the registry what each peer's newest release is, and
 * reports the two ways a range and reality drift apart:
 *
 *   - **The newest release falls outside the range.** A ceiling is meant to be
 *     crossed eventually; this is what turns widening one into a deliberate act
 *     after a green test run, rather than a guess made in advance.
 *   - **The range admits a release newer than the installed one.** An open range
 *     claims support for every version yet to be published, and check 1 only ever
 *     sees the one in the tree. This is the only place that claim is visible.
 *
 * It reports and exits 0. Both states are normal, and a gate that fires on the
 * normal state is a gate people learn to skip.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const failures = [];
const fail = (msg) => failures.push(msg);

const peers = Object.entries(pkg.peerDependencies ?? {});
const meta = pkg.peerDependenciesMeta ?? {};
const optional = (name) => meta[name]?.optional === true;

/**
 * The installed version of `name`, or `undefined`.
 *
 * Read off disk rather than through `require.resolve(name + "/package.json")`,
 * which is the obvious way and does not work here: a package whose `exports` map
 * omits `./package.json` is unreachable that way, and peers in this repo are.
 *
 * Only the top level of `node_modules` is consulted, because that is the copy
 * this package resolves. A nested one belongs to whoever nested it.
 */
function installedVersion(name) {
  try {
    const manifest = path.join(root, "node_modules", name, "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return undefined;
  }
}

// --- 1 & 2. the installed copy is the one the range describes ----------------

/** What check 3 compares against, and what `--latest` walks. */
const checked = [];

for (const [name, range] of peers) {
  if (semver.validRange(range) === null) {
    fail(
      `peer "${name}" declares "${range}", which is not a valid semver range`
    );
    continue;
  }
  const version = installedVersion(name);
  if (version === undefined) {
    if (!optional(name)) {
      fail(
        `peer "${name}" is required at "${range}" but is not installed — ` +
          `nothing here has ever run against it, so the range is unverified`
      );
    }
    continue;
  }
  if (!semver.satisfies(version, range)) {
    fail(
      `peer "${name}" declares "${range}", but ${version} is installed — ` +
        `every check in this repo ran against ${version}, and a consumer ` +
        `following "${range}" gets something else`
    );
    continue;
  }
  checked.push([name, range, version]);
}

// --- 3. no meta entry without a peer -----------------------------------------

for (const name of Object.keys(meta)) {
  if (!(name in (pkg.peerDependencies ?? {}))) {
    fail(
      `peerDependenciesMeta has "${name}", which is not a peer — npm ignores ` +
        `it silently, so if the peer was renamed its replacement is now required`
    );
  }
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✘ ${pkg.name} declares peer ranges it does not meet:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error("");
  process.exit(1);
}

console.log(
  `✓ ${pkg.name}: every installed peer satisfies its declared range` +
    (peers.length > checked.length ? " (optional peers absent: skipped)" : "")
);

// --- --latest. by hand, never in `check` -------------------------------------

if (!process.argv.includes("--latest")) process.exit(0);

/**
 * `npm view` rather than a `fetch` of the registry, because it is the only way
 * to inherit the registry, proxy and auth this repo is actually configured with.
 * A hardcoded `registry.npmjs.org` reports the wrong answer for a scoped peer
 * published somewhere else, and reports it confidently.
 */
const view = promisify(execFile);
const latestOf = async (name) => {
  try {
    const { stdout } = await view("npm", ["view", name, "version"], {
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

const rows = await Promise.all(
  checked.map(async ([name, range, version]) => [
    name,
    range,
    version,
    await latestOf(name)
  ])
);

console.log(
  `\n  ${"peer".padEnd(28)} ${"range".padEnd(22)} installed → latest`
);

/** The range excludes what is published now — widening it is the open question. */
const outsideRange = [];
/** The range includes what is published now, and nothing here has run it. */
const untested = [];

for (const [name, range, version, latest] of rows) {
  let verdict = "up to date";
  if (latest === undefined) {
    verdict = "unknown — registry did not answer";
  } else if (!semver.satisfies(latest, range)) {
    verdict = "outside the range";
    outsideRange.push([name, range, latest]);
  } else if (semver.gt(latest, version)) {
    verdict = "in range, not installed";
    untested.push([name, range, version, latest]);
  }
  console.log(
    `  ${name.padEnd(28)} ${range.padEnd(22)} ` +
      `${version} → ${latest ?? "?"}`.padEnd(20) +
      ` ${verdict}`
  );
}

if (outsideRange.length > 0) {
  console.log(
    `\n  Excluded by the declared range. Widen one only after installing that ` +
      `version\n  and running the suite green — the ceiling is the claim, and ` +
      `this is the evidence:\n`
  );
  for (const [name, range, latest] of outsideRange) {
    console.log(`    ${name}: "${range}" excludes ${latest}`);
  }
}

if (untested.length > 0) {
  console.log(
    `\n  Admitted by the declared range and never run here. Either install it ` +
      `and\n  keep the range, or lower the ceiling to what has actually been ` +
      `tested:\n`
  );
  for (const [name, range, version, latest] of untested) {
    console.log(
      `    ${name}: "${range}" admits ${latest}; ${version} installed`
    );
  }
}

console.log("");
