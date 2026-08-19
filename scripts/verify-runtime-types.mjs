#!/usr/bin/env node
/**
 * The half of the types gate that `wrangler types --check` does not cover.
 *
 * `worker-configuration.d.ts` is committed and is generated with
 * `--include-env=false`, and that flag is load-bearing: the default output
 * declares a **global** `Env` built from this repo's dev-only `wrangler.jsonc`
 * bindings. A plugin that names `Env` must fail here rather than resolve against
 * a consumer's bindings at their build, where the mistake is invisible — the rule
 * the README states and the reason the file is generated the way it is.
 *
 * `--check` compares the runtime types and is indifferent to that flag: a file
 * regenerated with a bare `wrangler types` carries the global `Env` and is still
 * reported "up to date". Measured, not assumed — and wrangler's own staleness
 * error says "Run `wrangler types` to regenerate", which is precisely the command
 * that reintroduces it. So the one guard rail points at the hole.
 *
 * Hence this: the flag is verified by its effect on the committed file, not by
 * trusting that whoever last regenerated it used the right script.
 *
 * `declare namespace Cloudflare { interface Env {} }` is expected and left alone.
 * It ships inside the runtime types as an empty extension point; it is nested, so
 * it is not the global this rejects, and nothing can reach it as a bare `Env`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = "worker-configuration.d.ts";

let source;
try {
  source = readFileSync(path.join(root, file), "utf8");
} catch {
  console.error(
    `✘ ${file} is missing. It is committed, not generated on demand — ` +
      `run \`npm run types\` and commit the result.`
  );
  process.exit(1);
}

// Column zero is the whole test: a global declaration is unindented, and the
// legitimate `Cloudflare.Env` is nested inside a namespace and therefore is not.
const globals = source
  .split("\n")
  .filter((line) => /^(?:declare\s+)?interface\s+Env\b/.test(line));

if (globals.length > 0) {
  console.error(
    `✘ ${file} declares a global \`Env\`:\n` +
      globals.map((line) => `    ${line.trim()}`).join("\n") +
      `\n\n  It was regenerated without \`--include-env=false\` — likely by ` +
      `running \`wrangler types\` directly, which is what wrangler's own ` +
      `staleness error suggests.\n  That global is this repo's dev-only ` +
      `bindings, and a plugin must never name a consumer's \`Env\`.\n` +
      `  Fix: \`npm run types\`, then commit the result.`
  );
  process.exit(1);
}

console.log(`✓ ${file}: runtime types only, no ambient Env`);
