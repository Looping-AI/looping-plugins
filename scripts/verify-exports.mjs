#!/usr/bin/env node
/**
 * Publish gate: the checks that only fail at a consumer.
 *
 * Every defect this catches was a real one in this package, and none of them
 * failed `tsc`, `eslint`, or `vitest` — they only surfaced when something
 * outside the repo imported the built output. So they run on `prepack` and
 * `prepublishOnly`, where a failure is still cheap.
 *
 *   1. Every `exports` subpath resolves to a file that actually emitted.
 *   2. No relative import in `dist/` omits its `.js` extension (Node ESM throws
 *      `ERR_MODULE_NOT_FOUND` on those; `moduleResolution: "Bundler"` does not).
 *   3. No spec files reached `dist/`.
 *   4. No source maps reached `dist/`. Their `sources` is `../src/*.ts`, which
 *      is not published, so every one is dangling — and a consumer's test runner
 *      prints "Sourcemap for … points to missing source files" once per module
 *      it loads, every run. `build` cleans `dist/` first, so this also catches
 *      the stale-artifact case that made the original defect survive a rebuild.
 *   5. Realm isolation: no *runtime* subpath can reach `node:*`, `undici`,
 *      `cloudflare:test` or `vitest` through any depth of relative import.
 *   6. **Plugin isolation**: no subpath's module graph reaches a file belonging
 *      to another subpath. This is the promise the package is built around — a
 *      bundle grows only with what it imports — and it is the one that rots
 *      silently, because a convenience re-export across two plugins typechecks,
 *      lints, and tests perfectly while quietly doubling every consumer's
 *      bundle. Only a check on the built graph catches it.
 *   7. No root barrel: `exports` must have no `"."` entry, for the same reason.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const failures = [];
const fail = (msg) => failures.push(msg);

/** Bare specifiers that must never be reachable from a runtime subpath. */
const TEST_ONLY = [/^node:/, /^undici$/, /^cloudflare:test$/, /^vitest$/];

const relativeImports = (source) =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);

/**
 * Everything reachable from `entry` through relative imports: the bare
 * specifiers it ends at, and every local file it walked through on the way.
 */
function reachableFrom(entry) {
  const files = new Set();
  const bare = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const spec of relativeImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec));
      } else {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

// --- 1. every exports target exists -----------------------------------------

const subpathEntries = [];
for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof value === "string" ? [value] : Object.values(value);
  for (const target of targets) {
    if (!existsSync(path.join(root, target))) {
      fail(`exports "${subpath}" points at ${target}, which does not exist`);
    }
  }
  const runtime = typeof value === "string" ? value : value.import;
  if (runtime?.endsWith(".js")) subpathEntries.push([subpath, runtime]);
}

// --- 2, 3 & 4. what reached dist/ -------------------------------------------

for (const file of walk(path.join(root, "dist"))) {
  if (/\.spec\.(js|d\.ts)$/.test(file)) {
    fail(`spec file shipped to dist: ${path.relative(root, file)}`);
  }
  if (file.endsWith(".map")) {
    fail(
      `source map shipped to dist: ${path.relative(root, file)} — its sources ` +
        `are under src/, which this package does not publish, so it dangles at ` +
        `every consumer`
    );
  }
  if (!file.endsWith(".js")) continue;
  for (const spec of relativeImports(readFileSync(file, "utf8"))) {
    if (spec.startsWith(".") && !spec.endsWith(".js")) {
      fail(
        `${path.relative(root, file)} imports "${spec}" without a .js extension ` +
          `— Node ESM will throw ERR_MODULE_NOT_FOUND`
      );
    }
  }
}

// --- 5 & 6. realm isolation, and plugin isolation ----------------------------

/** `./arc-agi` → `dist/arc-agi` — the directory a subpath's files must stay in. */
const ownDir = (subpath) =>
  path.join(root, "dist", subpath.replace(/^\.\//, ""));

for (const [subpath, target] of subpathEntries) {
  const { files, bare } = reachableFrom(path.join(root, target));

  const leaked = [...bare].filter((s) => TEST_ONLY.some((r) => r.test(s)));
  if (leaked.length > 0) {
    fail(
      `runtime subpath "${subpath}" can reach test-only modules: ${leaked.join(", ")}`
    );
  }

  // A plugin may reach only its own directory. `arc-agi` bundling its grid
  // analysis is fine — that code lives inside `arc-agi/` precisely because only
  // arc-agi consumes it. Reaching *out* into a sibling is what must not happen.
  const home = ownDir(subpath);
  const trespass = [...files]
    .filter((f) => !f.startsWith(home + path.sep))
    .map((f) => path.relative(root, f));
  if (trespass.length > 0) {
    fail(
      `subpath "${subpath}" reaches outside its own directory: ${trespass.join(", ")}. ` +
        `Installing one plugin would pull in another's code. Duplicate the helper, ` +
        `or move it inside the only plugin that uses it.`
    );
  }
}

// --- 7. no root barrel -------------------------------------------------------

if (pkg.exports?.["."]) {
  fail(
    `"." is exported. A root barrel re-exports every plugin, so importing one ` +
      `pulls in all of them — the exact promise this package makes. Keep subpaths only.`
  );
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ ${pkg.name} is not safe to publish:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error("");
  process.exit(1);
}

// stderr, not stdout: this runs from `prepack`, and `npm pack --json` expects
// stdout to be nothing but its own JSON.
console.error(
  `✓ ${pkg.name}: ${subpathEntries.length} runtime entries verified, ` +
    `${Object.keys(pkg.exports ?? {}).length} subpaths resolve, realms isolated`
);
