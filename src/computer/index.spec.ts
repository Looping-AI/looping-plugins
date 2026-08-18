import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import type { WorkspaceClient } from "@cloudflare/computer";
import {
  buildComputerTools,
  cancelledNote,
  computer,
  isContainerOnly,
  isGitInternal,
  needsDependencies,
  packBlocks,
  renderGrepMatches,
  renderResult,
  truncateOutput,
  withShell,
  withShellTranscript,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY,
  type ComputerConfig,
  type InstallState
} from "./index.js";

/** What the stub records off an `fs.grep` call. `@cloudflare/computer` declares
 * these but does not re-export them, so the shape is restated here. */
interface GrepOptions extends Page {
  include?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
}

/** The paging pair every listing method on the workspace takes. */
interface Page {
  limit?: number;
  offset?: number;
}

interface FoundEntry {
  path: string;
  type: "dir" | "file";
}

/**
 * Page a canned array the way the real methods do.
 *
 * `offset` is honoured, not just `limit`, and that is deliberate: the whole point
 * of the raw-index bookkeeping under test is that a filtered page reports an offset
 * the *source* understands. A stub that ignored `offset` would return page one
 * forever and every paging assertion below would pass while paging was broken.
 */
const page = <T>(items: T[], options?: Page): T[] => {
  const from = options?.offset ?? 0;
  return items.slice(from, from + (options?.limit ?? items.length));
};

/**
 * The computer tools' behaviour under the conditions that actually bite: output
 * that would blow the context window, an edit whose target is ambiguous, and a
 * path the workspace structurally cannot see.
 *
 * A stub stands in for the workspace — these are mapping and policy decisions,
 * and running a real container to assert them would test Cloudflare's code
 * rather than this package's.
 */

function stub(
  seed: Record<string, string> = {},
  /** Make the container unreachable, for the paths that have to survive it. */
  execThrows?: string | Error,
  /** Stand in for a tree whose shape the default canned entries cannot express. */
  findEntries?: FoundEntry[],
  /**
   * Symlinks, as `path -> target`. A repository can commit one, which is what
   * makes them a guard's problem rather than a shell's.
   */
  links: Record<string, string> = {}
): {
  workspace: () => Promise<WorkspaceClient>;
  execs: Array<{ command: string; options?: unknown }>;
  readdirs: Page[];
  finds: Array<{ dir: string; pattern?: string } & Page>;
  greps: Array<{ query: string; path: string } & GrepOptions>;
  /** Mutable, so a test can assert `ls` was never reached. */
  calls: { ls: number };
  files: Map<string, string>;
} {
  const execs: Array<{ command: string; options?: unknown }> = [];
  const readdirs: Page[] = [];
  const finds: Array<{ dir: string; pattern?: string } & Page> = [];
  const greps: Array<{ query: string; path: string } & GrepOptions> = [];
  const calls = { ls: 0 };
  const files = new Map(Object.entries(seed));

  const client = {
    fs: {
      /**
       * Honours the byte range, because that is the half of the contract worth
       * asserting. A stub that ignored `byteOffset`/`byteLength` and returned the
       * whole file would pass every test below while `sb_read` shipped the entire
       * file across the boundary — the exact failure the bounded read exists to
       * prevent, invisible to its own tests.
       */
      readFile: async (
        path: string,
        options?: string | { byteOffset?: number; byteLength?: number }
      ) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        if (typeof options !== "object" || !options) return content;
        const start = options.byteOffset ?? 0;
        const end =
          options.byteLength === undefined
            ? undefined
            : start + options.byteLength;
        return content.slice(start, end);
      },
      stat: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return { size: content.length, isFile: true, isDirectory: false };
      },
      /**
       * `lstat` does not follow the link — that is the whole distinction, and a
       * stub that collapsed it would let the guard pass its own tests while
       * seeing straight through every symlink in production.
       */
      lstat: async (path: string) => {
        if (path in links)
          return {
            size: 0,
            isFile: false,
            isDirectory: false,
            isSymbolicLink: true
          };
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return {
          size: content.length,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false
        };
      },
      readlink: async (path: string) => {
        const target = links[path];
        if (target === undefined) throw new Error(`EINVAL: ${path}`);
        return target;
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, String(content));
      },
      mkdir: async () => undefined,
      exists: async (path: string) => files.has(path),
      readdir: async (_path: string, options?: Page) => (
        readdirs.push(options ?? {}),
        page(
          [
            { name: "src", isDirectory: true, isFile: false, size: 0 },
            {
              name: "package.json",
              isDirectory: false,
              isFile: true,
              size: 2048
            }
          ],
          options
        )
      ),
      ls: async () => ((calls.ls += 1), [...files.keys()]),
      /**
       * Entries from `findEntries`, paged by `offset`/`limit`. Both are honoured
       * exactly: the bound is the whole reason this arm moved off `ls`, and a stub
       * that ignored the offset would let broken paging pass its own test — which
       * is the failure mode the raw-index bookkeeping exists to prevent.
       *
       * The pattern is reduced to a suffix match, which is emphatically not the
       * real glob: that one is Cloudflare's, anchored against the relative path,
       * and reimplementing it here would test their code. This much only exists
       * so both branches are reachable, since a pattern that matches nothing has
       * its own message.
       */
      find: async (dir: string, pattern?: string, options?: Page) => {
        finds.push({ dir, pattern, ...options });
        const entries = findEntries ?? [
          { path: `${dir}/.git`, type: "dir" as const },
          { path: `${dir}/.gitignore`, type: "file" as const },
          { path: `${dir}/src`, type: "dir" as const },
          { path: `${dir}/src/a.ts`, type: "file" as const },
          { path: `${dir}/package.json`, type: "file" as const }
        ];
        const suffix = pattern?.replace(/^.*\*/, "");
        return page(
          suffix ? entries.filter((e) => e.path.endsWith(suffix)) : entries,
          options
        );
      },
      /**
       * A real line scan over the seeded files, because the rendering is what
       * these tests are about — grouping, line numbers, context markers and the
       * byte budget all need matches that look like matches. `limit` and `offset`
       * are honoured for the same reason `readFile` honours its byte range: a stub
       * that ignored them would let an unbounded or mis-paged search pass.
       */
      grep: async (query: string, _path: string, options?: GrepOptions) => {
        greps.push({ query, path: _path, ...options });
        const context = options?.context ?? 0;
        const out: Array<{
          path: string;
          line: number;
          text: string;
          context?: Array<{ line: number; text: string; isMatch: boolean }>;
        }> = [];
        for (const [file, content] of files) {
          const lines = content.split("\n");
          lines.forEach((text, i) => {
            if (!text.includes(query)) return;
            const match: (typeof out)[number] = {
              path: file,
              line: i + 1,
              text
            };
            if (context > 0) {
              const from = Math.max(0, i - context);
              match.context = lines
                .slice(from, i + context + 1)
                .map((line, k) => ({
                  line: from + k + 1,
                  text: line,
                  isMatch: from + k === i
                }));
            }
            out.push(match);
          });
        }
        return page(out, options);
      }
    },
    runtime: {
      exec: async (command: string, options?: unknown) => {
        if (execThrows)
          throw typeof execThrows === "string"
            ? new Error(execThrows)
            : execThrows;
        execs.push({ command, options });
        return {
          result: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          [Symbol.dispose]: () => {}
        };
      }
    },
    [Symbol.dispose]: () => {}
  } as unknown as WorkspaceClient;

  return {
    workspace: async () => client,
    execs,
    readdirs,
    finds,
    greps,
    calls,
    files
  };
}

const config: ComputerConfig = {
  binding: undefined as unknown as ComputerConfig["binding"],
  workspaceName: () => "caller|owner/repo"
};

const run = (tools: ToolSet, name: string, input: unknown) =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<string>)(
    input,
    {}
  );

describe("truncateOutput", () => {
  it("keeps the head and the tail, which is where the error and the summary are", () => {
    const text = "A".repeat(200) + "B".repeat(200);
    const out = truncateOutput(text, 120);

    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("omitted from the middle");
  });

  /**
   * The regression this guard exists for. Without it, `half` goes negative,
   * `slice(-0)` returns the whole string, and the function hands back *more*
   * than it was given — a silent inversion of its only job, reachable from a
   * public config field.
   */
  it("never returns more than it was given, however small the budget", () => {
    for (const max of [0, 1, 40, 60, 80]) {
      expect(truncateOutput("x".repeat(500), max).length).toBeLessThanOrEqual(
        Math.max(max, 0)
      );
    }
  });
});

/**
 * What a command's result tells the model.
 *
 * The regression these guard is not a crash — it is a silence. When a successful
 * command reported no exit code, models compensated by writing
 * `npm run check; echo "EXIT_CODE=$?"` themselves, and one of those hand-rolled
 * workarounds reached for a bash builtin the container's `sh` does not have and
 * cost a 58-second re-run of the whole gate.
 */
describe("renderResult", () => {
  it("reports the exit code even when the command succeeded", () => {
    const out = renderResult(
      { exitCode: 0, stdout: "all good", stderr: "", status: "completed" },
      16_000
    );
    expect(out).toContain("all good");
    expect(out).toContain("--- exit 0 ---");
  });

  it("says when a command was killed rather than merely failing", () => {
    // The case that matters at the `timeoutMs` ceiling: "your suite was killed at
    // ten minutes" and "your suite has a failing test" must not read alike.
    const killed = renderResult(
      { exitCode: 137, stdout: "partial…", stderr: "", status: "cancelled" },
      16_000
    );
    expect(killed).toContain("--- exit 137 (cancelled) ---");

    const failed = renderResult(
      { exitCode: 1, stdout: "boom", stderr: "", status: "completed" },
      16_000
    );
    expect(failed).toContain("--- exit 1 ---");
    expect(failed).not.toContain("completed");
  });

  it("still reports a verdict when the command printed nothing", () => {
    const out = renderResult(
      { exitCode: 0, stdout: "", stderr: "", status: "completed" },
      16_000
    );
    expect(out).toContain("--- exit 0 ---");
  });

  /**
   * `truncateOutput` used to run once per stream, so `maxOutputBytes` really
   * meant "up to twice this" — a budget that does not bound the thing it names.
   */
  it("applies the output budget once, to the whole transcript", () => {
    const out = renderResult(
      {
        exitCode: 0,
        stdout: "A".repeat(5_000),
        stderr: "B".repeat(5_000),
        status: "completed"
      },
      2_000
    );
    // Body is bounded; only the short verdict line is added on top.
    expect(out.length).toBeLessThan(2_000 + 40);
    expect(out).toContain("--- exit 0 ---");
  });

  it("keeps a labelled stderr block for hosts that did not merge the streams", () => {
    const out = renderResult(
      { exitCode: 1, stdout: "out", stderr: "err", status: "completed" },
      16_000
    );
    expect(out).toContain("out");
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("err");
  });
});

/**
 * The two shell wrappers, and the difference between them.
 *
 * Both pick the shell the model actually writes for and both ask for `pipefail`.
 * They differ on one thing — whether the result is a *transcript* or two separate
 * streams — and that difference is the output contract, which is why it is two
 * named functions rather than one with a flag. A flag put the choice at the call
 * site as a `true` nobody reads, and `computerExec` silently inherited the wrong
 * one for as long as it existed.
 */
/**
 * `renderResult` says this on its verdict line, so `sb_exec` has always had it.
 * `computerExec` has no verdict line and dropped `status` entirely — and a killed
 * process writes nothing, so `/repo` reported `clone failed:` with nothing after
 * the colon for a clone that hit the ceiling.
 */
describe("cancelledNote", () => {
  it("explains a command that was killed, naming both usual causes", () => {
    const note = cancelledNote("cancelled", 137, 600_000);

    expect(note).toContain("killed");
    // The ceiling as the model would have to state it to change it, and the
    // other cause of a 137 — the exit code cannot tell them apart.
    expect(note).toContain("10m00s");
    expect(note).toMatch(/out of memory/);
  });

  it("says nothing about an ordinary failure", () => {
    // A non-zero exit is the command's own business, and its stderr explains it
    // better than a note could. Anything here would be noise on every failure.
    expect(cancelledNote("failed", 1, 600_000)).toBeUndefined();
    expect(cancelledNote("completed", 0, 600_000)).toBeUndefined();
    expect(cancelledNote(undefined, 1, 600_000)).toBeUndefined();
  });
});

describe("withShell", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShell("npm test", undefined)).toBe("npm test");
  });

  /**
   * The property `/repo` depends on. It asks git questions whose answer is the
   * whole of stdout — a URL to compare, a sha to push, a count to test against
   * "0" — so a diagnostic merged into that channel is a wrong answer, not noise.
   */
  it("leaves the two streams alone, so stdout carries the answer only", () => {
    const command = withShell("git rev-list --count origin/main..HEAD", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    expect(command).not.toContain("2>&1");
  });

  /**
   * The regression this guards is a *silent* one, and it is the worst kind this
   * tool can produce. Without `pipefail`, a pipeline reports its last stage's
   * status — so `npm run check | tail -100` came back `exit 0` from a gate that
   * had failed in 1.3 seconds on a missing `node_modules`. A build that failed
   * and said it passed is worse than no answer at all.
   */
  it("asks the shell to report the first failing stage of a pipeline", () => {
    expect(withShell("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  /**
   * The command is model-authored and routinely carries its own quoting. If the
   * wrapper re-parsed it, `git commit -m "a message"` would arrive as two
   * arguments and the commit would be made with the wrong message — a silent
   * corruption, not an error.
   */
  it("survives a command that contains its own quotes", () => {
    expect(withShell(`git commit -m "add a line"`, "bash")).toContain(
      "add a line"
    );
  });
});

describe("withShellTranscript", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShellTranscript("npm test", undefined)).toBe("npm test");
  });

  it("merges stderr into stdout on the wrapper process", () => {
    const command = withShellTranscript("npm run check", "bash");
    expect(command.startsWith("bash -o pipefail -c ")).toBe(true);
    // Bound to the wrapper, not nested inside it — so it applies to everything
    // the command spawns, however deep, with no brace group to mis-parse.
    expect(command.endsWith(" 2>&1")).toBe(true);
  });

  it("keeps pipefail, which is not the half that differs", () => {
    expect(withShellTranscript("npm run check | tail -100", "bash")).toContain(
      "-o pipefail"
    );
  });

  it("survives a command that contains its own quotes", () => {
    const command = withShellTranscript(`git commit -m "add a line"`, "bash");
    expect(command).toContain("add a line");
    expect(command.endsWith(" 2>&1")).toBe(true);
  });
});

/**
 * Which commands have to wait for a dependency install.
 *
 * The asymmetry is the point: waiting for a command that did not need it costs
 * time, while running one that did need it hands the model a "cannot find module"
 * unrelated to its change. So the reads below must not gate, the builds must, and
 * when in doubt the answer is to gate.
 */
describe("needsDependencies", () => {
  it("does not gate reads, listings or git — what a subagent can do while npm ci runs", () => {
    // Every one of these was observed queued behind an install it had no use
    // for, costing 57 seconds before the first useful command ran.
    for (const command of [
      "cd /workspace/repo && tail -c 200 README.md | xxd | tail -20",
      "cd /workspace/repo && tail -c 100 README.md | od -c | tail -20",
      "cd /workspace/repo && git status --short",
      "cd /workspace/repo && git diff -- README.md",
      "cd /workspace/repo && ls -la src && cat package.json",
      "grep -rn 'TODO' src"
    ]) {
      expect(needsDependencies(command)).toBe(false);
    }
  });

  it("gates anything that could reach a dependency", () => {
    for (const command of [
      "cd /workspace/repo && npm run check",
      "npx vitest run src/a.spec.ts",
      "pnpm install && pnpm build",
      "yarn test",
      "bun run build",
      "node scripts/thing.mjs",
      "./node_modules/.bin/eslint .",
      "tsc -p test/tsconfig.json"
    ]) {
      expect(needsDependencies(command)).toBe(true);
    }
  });

  /**
   * The case that made position matter. A word-boundary match anywhere in the
   * string passes every other test here and still fails this one: `\bvitest\b`
   * fires on `vitest.config.ts` because `.` is a word boundary, and config files
   * are exactly what a subagent reads while orienting itself.
   */
  it("reads a build tool's config file without gating on it", () => {
    for (const command of [
      "cat vitest.config.ts",
      "cat next.config.js",
      "cat eslint.config.js && cat prettier.config.js",
      "head -50 vite.config.ts",
      "cat docs/nodes.md",
      "cat src/bundle.ts"
    ]) {
      expect(needsDependencies(command)).toBe(false);
    }
  });

  it("finds a build one level down, where position cannot help", () => {
    // A package manager is never a filename, so it is matched anywhere — which
    // is what catches it inside a nested shell or behind a wrapper.
    expect(needsDependencies("bash -c 'npm run check'")).toBe(true);
    expect(needsDependencies("time npm test")).toBe(true);
    expect(needsDependencies("cd /workspace/repo && FOO=1 npx tsc")).toBe(true);
  });

  it("reads the program name through a path prefix or an env assignment", () => {
    expect(needsDependencies("/usr/local/bin/tsc --noEmit")).toBe(true);
    expect(needsDependencies("CI=1 vitest run")).toBe(true);
    expect(needsDependencies("cd /repo && ./bin/eslint .")).toBe(true);
  });
});

describe("paths the workspace cannot see", () => {
  it("matches node_modules as a whole segment, not as a substring", () => {
    expect(isContainerOnly("/workspace/repo/node_modules/zod/index.js")).toBe(
      true
    );
    expect(isContainerOnly("/workspace/repo/node_modules")).toBe(true);
    expect(isContainerOnly("/workspace/repo/src/node_modules_old/a.ts")).toBe(
      false
    );
    expect(isContainerOnly("/workspace/repo/src/my_node_modules.ts")).toBe(
      false
    );
  });

  /**
   * The load-bearing one. `node_modules` is excluded from the sync by
   * `computerd`, so a read of a dependency finds nothing in the workspace — and
   * "no such file" about a package that is plainly installed sends the model
   * hunting for the wrong bug. It has to be told *why*, and what to use instead.
   */
  it("explains itself instead of reporting a missing file", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);
    const path = "/workspace/repo/node_modules/zod/package.json";

    for (const name of ["sb_read", "sb_ls", "sb_exists", "sb_grep"]) {
      const out = await run(tools, name, { path, query: "x" });
      expect(out).toContain("only in the container");
      expect(out).toContain("sb_exec");
      expect(out).not.toContain("does not exist");
    }
  });

  it("refuses to write there rather than pretending it worked", async () => {
    const { workspace, files } = stub();
    const tools = buildComputerTools(workspace, config);
    const path = "/workspace/repo/node_modules/zod/index.js";

    const out = await run(tools, "sb_write", { path, content: "x" });
    expect(out).toContain("sb_exec");
    // The important half: nothing was written where a later read would find it
    // and conclude the edit had landed.
    expect(files.has(path)).toBe(false);
  });
});

describe("sb_edit", () => {
  const path = "/workspace/repo/a.ts";

  it("replaces a unique string", async () => {
    const { workspace, files } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(await run(tools, "sb_edit", { path, find: "1", replace: "2" })).toBe(
      `edited ${path}`
    );
    expect(files.get(path)).toBe("const a = 2;\n");
  });

  /**
   * Refusing an ambiguous edit is the whole value of this tool over `sb_write`:
   * a silent first-match replace corrupts the file in a way that surfaces much
   * later, usually as a confusing test failure.
   */
  it("refuses an ambiguous edit and leaves the file alone", async () => {
    const original = "let x = 1;\nlet y = 1;\n";
    const { workspace, files } = stub({ [path]: original });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_edit", { path, find: "1", replace: "2" });
    expect(out).toContain("appears 2 times");
    expect(files.get(path)).toBe(original);
  });

  it("says so when there is no match", async () => {
    const { workspace } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(
      await run(tools, "sb_edit", { path, find: "nope", replace: "x" })
    ).toContain("no match");
  });
});

/**
 * The budget is enforced where the bytes are read, not after they have all
 * arrived in the isolate — which is the whole point of the range-addressable
 * read `@cloudflare/computer` 0.2 added. The stub honours the range, so a
 * regression to `readFile(path, "utf8")` fails these rather than passing them
 * with the old memory profile intact.
 */
describe("sb_read", () => {
  const path = "/workspace/repo/big.log";

  it("returns a small file whole", async () => {
    const { workspace } = stub({ [path]: "const a = 1;\n" });
    const tools = buildComputerTools(workspace, config);

    expect(await run(tools, "sb_read", { path })).toBe("const a = 1;\n");
  });

  it("keeps both ends of a large one and says what it dropped", async () => {
    const body = "HEAD" + "x".repeat(4_000) + "TAIL";
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, {
      ...config,
      maxOutputBytes: 400
    });

    const out = await run(tools, "sb_read", { path });
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("bytes omitted from the middle");
    // The ceiling is real, not advisory: the whole file never lands here.
    expect(out.length).toBeLessThanOrEqual(400);
  });

  it("still reports a missing file rather than throwing", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    expect(await run(tools, "sb_read", { path })).toContain("error reading");
  });
});

describe("sb_ls", () => {
  const path = "/workspace/repo";

  it("bounds the listing at the source instead of trimming the rendered text", async () => {
    const { workspace, readdirs } = stub();
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_ls", { path });
    // One over the ceiling, which is how the tool detects a cut listing without
    // asking twice.
    expect(readdirs[0]?.limit).toBe(1001);
  });

  it("shows a size for files, so the model can tell a read will be truncated", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path });
    expect(out).toContain("src/");
    expect(out).toContain("package.json\t2.0 KB");
  });

  /**
   * The regression this retires. `ls` is a prefix scan with no bound: it returned
   * every path in the subtree, the isolate held all of them, and the byte ceiling
   * then discarded most — the same read-everything-then-discard shape the
   * `readdir` limit was introduced to fix one arm above. `find` takes a limit, so
   * asserting one arrived is asserting the walk stops early.
   */
  it("bounds a recursive listing at the source, and no longer scans the whole subtree", async () => {
    const { workspace, finds, calls } = stub();
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_ls", { path, recursive: true });

    expect(finds[0]?.limit).toBe(1001);
    // Whole-subtree, so no pattern — but bounded, which `ls` never was.
    expect(finds[0]?.pattern).toBeUndefined();
    expect(calls.ls).toBe(0);
  });

  it("finds files by glob without spending a second tool on it", async () => {
    const { workspace, finds, readdirs } = stub();
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_ls", { path, pattern: "**/*.ts" });

    expect(finds[0]).toMatchObject({ dir: path, pattern: "**/*.ts" });
    // A pattern searches the subtree on its own; `recursive` is not needed and
    // the one-level read must not run.
    expect(readdirs).toHaveLength(0);
  });

  it("marks directories in a recursive listing the way the one-level listing does", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path, recursive: true });
    expect(out).toContain(`${path}/src/`);
    expect(out).toContain(`${path}/src/a.ts`);
  });

  /**
   * "Empty directory" and "your glob matched nothing" send the model to different
   * next moves — one to a different path, the other to a different pattern.
   */
  it("says a pattern matched nothing rather than reporting an empty directory", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path, pattern: "**/*.rs" });
    expect(out).toContain("**/*.rs");
    expect(out).not.toContain("is empty");
  });
});

/**
 * How a match list reads.
 *
 * The budget rules here are deliberately not `truncateOutput`'s. Keeping both ends
 * and dropping the middle is right for a build log, where the first error and the
 * final summary are the whole value — and destructive for search results, where the
 * middle is an entire file's worth of hits that disappear without saying so.
 */
describe("renderGrepMatches", () => {
  const match = (path: string, line: number, text: string) => ({
    path,
    line,
    text
  });

  it("names each file once and lists its hits under it", () => {
    const { body } = renderGrepMatches(
      [
        match("/workspace/a.ts", 4, "const x = 1;"),
        match("/workspace/a.ts", 9, "const y = 2;"),
        match("/workspace/b.ts", 2, "const z = 3;")
      ],
      16_000
    );

    // An absolute path costs more than the line it labels; repeating it per hit
    // spends the budget on paths rather than code.
    expect(body.match(/\/workspace\/a\.ts/g)).toHaveLength(1);
    expect(body).toContain("  4: const x = 1;");
    expect(body).toContain("  9: const y = 2;");
    expect(body).toContain("/workspace/b.ts");
  });

  it("distinguishes the matching line from its context, as grep does", () => {
    const { body } = renderGrepMatches(
      [
        {
          path: "/workspace/a.ts",
          line: 5,
          text: "const x = 1;",
          context: [
            { line: 4, text: "// before", isMatch: false },
            { line: 5, text: "const x = 1;", isMatch: true },
            { line: 6, text: "// after", isMatch: false }
          ]
        }
      ],
      16_000
    );

    // `:` is the hit, `-` is context. Without the distinction the model cannot
    // tell which line it actually searched for.
    expect(body).toContain("  5: const x = 1;");
    expect(body).toContain("  4- // before");
    expect(body).toContain("  6- // after");
  });

  /**
   * The minified-bundle case. One match in `dist/` carries a line of megabytes,
   * and `text` is the whole line — so without a cap a single hit is the entire
   * result.
   */
  it("shortens a very long line instead of letting it eat the result", () => {
    const { body, capped } = renderGrepMatches(
      [
        match("/workspace/dist/bundle.js", 1, `x${"y".repeat(50_000)}`),
        match("/workspace/src/a.ts", 3, "readable")
      ],
      16_000
    );

    expect(body.length).toBeLessThan(1_000);
    expect(body).toContain("chars]");
    // The point of capping rather than dropping: the later match survives.
    expect(body).toContain("readable");
    // Reported once, so the caller can say how to reach the full text without
    // repeating the advice on every shortened line.
    expect(capped).toBe(true);
  });

  it("does not claim a line was shortened when none that shipped was", () => {
    const { capped } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "short")],
      16_000
    );
    expect(capped).toBe(false);
  });

  it("stops at the budget and reports exactly how many it showed", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      match("/workspace/a.ts", i + 1, `line ${i} ${"x".repeat(80)}`)
    );

    const { body, shown } = renderGrepMatches(many, 2_000);

    expect(body.length).toBeLessThan(2_400);
    // `shown` is what makes the next offset exact rather than a guess.
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);
  });

  it("emits the first match however large, rather than nothing at all", () => {
    const { body, shown } = renderGrepMatches(
      [match("/workspace/a.ts", 1, "x".repeat(5_000))],
      50
    );
    expect(body).toContain("/workspace/a.ts");
    expect(body).toContain("1:");
    expect(shown).toBe(1);
  });
});

/**
 * The budget rule both list tools share.
 *
 * Whole blocks only, because half a match's context reads like a corrupt result —
 * and an exact `shown`, because that number is what the next page's offset is
 * computed from. A `shown` that over-reported by one would silently skip an entry
 * on every subsequent page.
 */
describe("packBlocks", () => {
  it("emits whole blocks and counts them exactly", () => {
    const { body, shown } = packBlocks(
      [["a", "b"], ["c"], ["d", "e", "f"]],
      1_000
    );
    expect(body).toBe("a\nb\nc\nd\ne\nf");
    expect(shown).toBe(3);
  });

  it("drops a block whole rather than splitting it", () => {
    const { body, shown } = packBlocks(
      [["x".repeat(20)], ["y".repeat(20), "z".repeat(20)]],
      30
    );
    expect(shown).toBe(1);
    expect(body).not.toContain("y");
    // Not a partial second block: the line that would have fit is absent too.
    expect(body).not.toContain("z");
  });

  it("always emits the first block, however far over budget", () => {
    const { body, shown } = packBlocks([["x".repeat(5_000)], ["y"]], 10);
    expect(shown).toBe(1);
    expect(body.length).toBeGreaterThan(10);
  });

  it("reports nothing shown for no blocks", () => {
    expect(packBlocks([], 100)).toEqual({ body: "", shown: 0 });
  });
});

/**
 * Search that does not need the container.
 *
 * That is the reason this tool exists rather than leaving the model on
 * `sb_exec("grep -rn …")`: it reads the durable workspace, so it answers during
 * exactly the window — container being replaced, install still running — when the
 * shell cannot. The bound at the source is the other half, since `.git` is in the
 * workspace and an unbounded search reads every loose object before answering.
 */
describe("sb_grep", () => {
  const path = "/workspace/repo/a.ts";
  const seed = {
    [path]: "import { z } from 'zod';\nconst a = 1;\nconst b = 2;\n"
  };

  it("bounds the search at the source", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_grep", { query: "const" });
    // One over the ceiling, so a cut result is detected without searching twice.
    expect(greps[0]?.limit).toBe(201);
  });

  it("searches the configured cwd unless told otherwise", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, {
      ...config,
      cwd: "/workspace"
    });

    await run(tools, "sb_grep", { query: "const" });
    expect(greps[0]?.path).toBe("/workspace");

    await run(tools, "sb_grep", { query: "const", path: "/workspace/repo" });
    expect(greps[1]?.path).toBe("/workspace/repo");
  });

  it("returns the hits with their line numbers", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_grep", { query: "const" });
    expect(out).toContain(path);
    expect(out).toContain("  2: const a = 1;");
    expect(out).toContain("  3: const b = 2;");
  });

  /**
   * The query is a value here, not a fragment of a shell command — which is the
   * quieter reason to prefer this over `sb_exec`. Through a shell it would pass
   * `shellQuote` and be re-parsed on the way to `grep`.
   */
  it("forwards the search options rather than reinterpreting them", async () => {
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_grep", {
      query: "^const",
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2
    });

    expect(greps[0]).toMatchObject({
      query: "^const",
      include: "**/*.ts",
      regex: true,
      ignoreCase: true,
      context: 2
    });
  });

  it("says it found nothing, and what it looked for", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_grep", {
      query: "nowhere",
      include: "**/*.ts"
    });
    expect(out).toContain("no matches");
    expect(out).toContain("nowhere");
    expect(out).toContain("**/*.ts");
  });

  /**
   * The gate holds `sb_exec` while dependencies install. Holding this too would
   * defeat the point — searching is precisely what a subagent can usefully do in
   * that window, and it needs no container to do it.
   */
  it("still searches while a dependency install is in flight", async () => {
    const { workspace } = stub(seed);
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => ({
        state: "running" as const,
        command: "npm ci",
        startedAt: Date.now()
      })
    );

    const out = await run(tools, "sb_grep", { query: "const" });
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("still running");
  });
});

/**
 * `.git` is off limits, and the reason differs from `node_modules`.
 *
 * `node_modules` is *absent* — physics, decided by `computerd`. `.git` is present,
 * readable, and refused anyway — policy, because a model that edits `.git/HEAD` or
 * `.git/config` corrupts a checkout in a way that surfaces much later as an
 * inexplicable git failure. Repository work belongs to the repo tools.
 */
describe("paths inside .git", () => {
  it("matches .git as a whole segment, sparing the dotfiles that merely start with it", () => {
    expect(isGitInternal("/workspace/repo/.git/config")).toBe(true);
    expect(isGitInternal("/workspace/repo/.git")).toBe(true);
    // The trap: these are ordinary tracked files and must stay readable.
    expect(isGitInternal("/workspace/repo/.gitignore")).toBe(false);
    expect(isGitInternal("/workspace/repo/.gitattributes")).toBe(false);
    expect(isGitInternal("/workspace/repo/.github/workflows/ci.yml")).toBe(
      false
    );
    expect(isGitInternal("/workspace/repo/src/git/index.ts")).toBe(false);
  });

  it("refuses every file tool, and points at the repo tools", async () => {
    const { workspace, files } = stub();
    const tools = buildComputerTools(workspace, config);
    const path = "/workspace/repo/.git/config";

    for (const name of [
      "sb_read",
      "sb_ls",
      "sb_exists",
      "sb_grep",
      "sb_edit"
    ]) {
      const out = await run(tools, name, {
        path,
        query: "x",
        find: "a",
        replace: "b"
      });
      expect(out).toContain(".git");
      // A refusal with no destination gets worked around; this one has one.
      expect(out).toContain("repo_diff");
    }

    const wrote = await run(tools, "sb_write", { path, content: "x" });
    expect(wrote).toContain("repo_status");
    // The half that matters: nothing landed where a later read would find it.
    expect(files.has(path)).toBe(false);
  });

  /**
   * A string check reads the path it was given, so `docs/notes.md -> ../.git/config`
   * walks straight past it.
   *
   * The attacker worth defending against here is **not** a model holding
   * `sb_exec` — that one reads `.git` outright and has no use for a link. It is a
   * cloned repository: git tracks symlinks, so a hostile repo ships one and the
   * guard is defeated on any host that grants the file tools without a shell,
   * which is exactly the shape a reviewing parent agent has.
   */
  describe("through a symlink", () => {
    const link = "/workspace/repo/docs/notes.md";
    const links = { [link]: "../.git/config" };

    it("refuses a write, which is the half that cannot be undone", async () => {
      const { workspace, files } = stub({}, undefined, undefined, links);
      const tools = buildComputerTools(workspace, config);

      const out = await run(tools, "sb_write", { path: link, content: "x" });
      expect(out).toContain("repo_status");
      // Named as a link, and named with where it lands — a refusal that reported
      // only the path the model typed reads like a bug in the tool.
      expect(out).toContain("symlink to /workspace/repo/.git/config");
      expect(files.has(link)).toBe(false);
    });

    it("refuses a read and an edit through the same link", async () => {
      const { workspace } = stub(
        { [link]: "whatever" },
        undefined,
        undefined,
        links
      );
      const tools = buildComputerTools(workspace, config);

      for (const name of ["sb_read", "sb_edit"]) {
        const out = await run(tools, name, {
          path: link,
          find: "a",
          replace: "b"
        });
        expect(out).toContain("repo_diff");
        expect(out).not.toContain("sb_exec");
      }
    });

    it("resolves an absolute target as well as a relative one", async () => {
      const { workspace } = stub({}, undefined, undefined, {
        [link]: "/workspace/repo/.git/HEAD"
      });
      const tools = buildComputerTools(workspace, config);

      expect(
        await run(tools, "sb_write", { path: link, content: "x" })
      ).toEqual(
        expect.stringContaining("symlink to /workspace/repo/.git/HEAD")
      );
    });

    it("catches a link into node_modules with the note that fits it", async () => {
      const { workspace } = stub({}, undefined, undefined, {
        [link]: "../node_modules/zod/package.json"
      });
      const tools = buildComputerTools(workspace, config);

      const out = await run(tools, "sb_read", { path: link });
      // The other list, and its own explanation: absent rather than forbidden,
      // so this one *does* point at sb_exec.
      expect(out).toContain("node_modules");
      expect(out).toContain("sb_exec");
    });

    /**
     * The guard must not invent work. A link that merely *passes through* a
     * `.git` segment on its way somewhere ordinary is an ordinary file, and
     * normalising is what tells the two apart.
     */
    it("allows a link whose target only traverses .git", async () => {
      const { workspace, files } = stub({}, undefined, undefined, {
        [link]: "/workspace/repo/.git/../src/a.ts"
      });
      const tools = buildComputerTools(workspace, config);

      expect(await run(tools, "sb_write", { path: link, content: "x" })).toBe(
        `wrote ${link} (1 character)`
      );
      expect(files.get(link)).toBe("x");
    });

    /**
     * The bound, stated as a test so it is a decision rather than a gap. A
     * symlinked *ancestor* is not resolved: that costs an `lstat` per segment on
     * every call, against a Durable Object, for a case git's own checkout
     * protections already refuse much of.
     */
    it("does not resolve a symlinked ancestor — the documented residual", async () => {
      const { workspace } = stub({}, undefined, undefined, {
        "/workspace/repo/link": ".git"
      });
      const tools = buildComputerTools(workspace, config);

      const out = await run(tools, "sb_read", {
        path: "/workspace/repo/link/config"
      });
      expect(out).not.toContain("repo_diff");
    });
  });

  /**
   * The one prohibition this plugin must never soften. Naming `sb_exec` beside git
   * would hand back the exact capability the refusal withholds, in the one place
   * the model is already looking for a way around it — and with the tool's own
   * authority behind it. Asserted against the rendered strings so a later
   * well-meaning rewording fails here rather than shipping.
   */
  it("never offers sb_exec as a way to reach git", async () => {
    const { workspace } = stub();
    const tools = buildComputerTools(workspace, config);

    const refusal = await run(tools, "sb_read", {
      path: "/workspace/repo/.git/HEAD"
    });
    expect(refusal).not.toContain("sb_exec");

    const capability = computer({
      ...config,
      binding: undefined as unknown as ComputerConfig["binding"]
    }).capability!;
    const gitLine = capability
      .split("\n")
      .find((line) => line.includes("`.git`"))!;
    expect(gitLine).toBeDefined();
    expect(gitLine).not.toContain("sb_exec");
    // And it still says where to go instead.
    expect(gitLine).toContain("repo_commit");
  });

  it("keeps .git out of a search", async () => {
    const { workspace } = stub({
      "/workspace/repo/.git/COMMIT_EDITMSG": "fix the parser\n",
      "/workspace/repo/src/a.ts": "// fix the parser later\n"
    });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_grep", { query: "fix the parser" });
    expect(out).toContain("/workspace/repo/src/a.ts");
    expect(out).not.toContain("COMMIT_EDITMSG");
  });

  /**
   * The round-1 bug this closes. At a repo root `.git` is walked *first* — `.`
   * sorts before alphanumerics — and holds thousands of objects, so an unfiltered
   * page is a page of `.git` and nothing else: a recursive listing of a real
   * checkout returned 1000 object hashes and not one source file.
   */
  it("does not let .git consume a whole recursive listing", async () => {
    const root = "/workspace/repo";
    const crowded = [
      ...Array.from({ length: 1500 }, (_, i) => ({
        path: `${root}/.git/objects/${i}`,
        type: "file" as const
      })),
      { path: `${root}/src/a.ts`, type: "file" as const }
    ];
    const { workspace } = stub({}, undefined, crowded);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path: root, recursive: true });

    expect(out).toContain(`${root}/src/a.ts`);
    expect(out).not.toContain("/.git/");
  });

  it("says so when a page is nothing but .git, rather than reporting an empty tree", async () => {
    const root = "/workspace/repo";
    const { workspace } = stub(
      {},
      undefined,
      Array.from({ length: 9_000 }, (_, i) => ({
        path: `${root}/.git/objects/${i}`,
        type: "file" as const
      }))
    );
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path: root, recursive: true });
    // Bounded retries, so this terminates — and explains itself instead of
    // looking like an empty directory.
    expect(out).toContain(".git");
    expect(out).not.toContain("is empty");
  });

  /**
   * `/repo` runs its git CLI through `computerExec`, not through the tools. A
   * guard there would break clone and commit outright.
   */
  it("does not guard computerExec, which is how /repo runs git", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, config);
    // The tool refuses…
    expect(
      await run(tools, "sb_read", { path: "/workspace/repo/.git/HEAD" })
    ).toContain("repo_diff");
    // …while the shell path stays open, which is what /repo depends on.
    await run(tools, "sb_exec", { command: "git rev-parse --git-dir" });
    expect(execs).toHaveLength(1);
  });
});

/**
 * Paging, and the bookkeeping that keeps it honest.
 *
 * `offset` counts items at the *source*, while what the model sees is filtered and
 * then trimmed to a byte budget. So the obvious `offset + shown` is wrong exactly
 * when `.git` was dropped — and wrong silently, repeating or skipping with nothing
 * to indicate it.
 */
describe("offsets that survive filtering", () => {
  const root = "/workspace/repo";

  it("reports the source offset of the first entry it did not show", async () => {
    // Two .git entries first, so a naive `offset + shown` would drift by two.
    const entries = [
      { path: `${root}/.git/HEAD`, type: "file" as const },
      { path: `${root}/.git/config`, type: "file" as const },
      ...Array.from({ length: 2_000 }, (_, i) => ({
        path: `${root}/src/f${i}.ts`,
        type: "file" as const
      }))
    ];
    const { workspace } = stub({}, undefined, entries);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_ls", { path: root, recursive: true });
    const next = /offset: (\d+)/.exec(out)?.[1];
    expect(next).toBeDefined();

    // The reported offset must land on the first unseen entry at the source.
    const shown = out.split("\n").filter((l) => l.includes("/src/f")).length;
    expect(Number(next)).toBe(shown + 2);
  });

  it("continues exactly where the previous page stopped", async () => {
    const entries = [
      { path: `${root}/.git/HEAD`, type: "file" as const },
      ...Array.from({ length: 2_000 }, (_, i) => ({
        path: `${root}/src/f${i}.ts`,
        type: "file" as const
      }))
    ];
    const { workspace } = stub({}, undefined, entries);
    const tools = buildComputerTools(workspace, config);

    const first = await run(tools, "sb_ls", { path: root, recursive: true });
    const next = Number(/offset: (\d+)/.exec(first)![1]);
    const second = await run(tools, "sb_ls", {
      path: root,
      recursive: true,
      offset: next
    });

    const lastOfFirst = first
      .split("\n")
      .filter((l) => l.includes("/src/f"))
      .at(-1)!;
    const firstOfSecond = second
      .split("\n")
      .filter((l) => l.includes("/src/f"))[0]!;

    // No repeat and no gap: consecutive indices across the page boundary.
    const index = (line: string) => Number(/f(\d+)\.ts/.exec(line)![1]);
    expect(index(firstOfSecond)).toBe(index(lastOfFirst) + 1);
  });

  it("forwards an offset to the search and reports the next one", async () => {
    const seed = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `${root}/f${i}.ts`,
        "const hit = 1;\n"
      ])
    );
    const { workspace, greps } = stub(seed);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_grep", { query: "hit", offset: 50 });
    expect(greps[0]?.offset).toBe(50);
    expect(out).toContain("offset:");
  });

  it("pages a one-level listing too", async () => {
    const { workspace, readdirs } = stub();
    const tools = buildComputerTools(workspace, config);

    await run(tools, "sb_ls", { path: root, offset: 25 });
    expect(readdirs[0]).toMatchObject({ limit: 1001, offset: 25 });
  });
});

/**
 * Reaching a region the default read will not show.
 *
 * Before this, a file whose middle was dropped had no route back to it except
 * `sb_exec` with `sed` — which needs a live container, the exact dependency these
 * tools exist to remove. The same hole made "narrow it" the advice for a capped
 * 40,000-character minified line, where narrowing cannot possibly help.
 */
describe("sb_read windows", () => {
  const path = "/workspace/repo/bundle.js";
  const body = "HEAD" + "x".repeat(4_000) + "TAIL";

  it("returns the requested window and says where it landed", async () => {
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_read", { path, offset: 100, length: 50 });

    expect(out).toContain("--- bytes 100–150 of 4008");
    // Enough to compute the next offset without a second call.
    expect(out).toContain("3858 bytes after this");
  });

  it("does not middle-truncate a window the model chose", async () => {
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, {
      ...config,
      maxOutputBytes: 400
    });

    const out = await run(tools, "sb_read", { path, offset: 0, length: 300 });
    expect(out).not.toContain("omitted from the middle");
  });

  it("keeps the ceiling even when a larger length is asked for", async () => {
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, {
      ...config,
      maxOutputBytes: 200
    });

    const out = await run(tools, "sb_read", {
      path,
      offset: 0,
      length: 99_999
    });
    expect(out).toContain("--- bytes 0–200 of 4008");
  });

  it("says an offset ran off the end rather than returning nothing", async () => {
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_read", { path, offset: 99_999 });
    expect(out).toContain("past the end");
  });

  /** An unqualified read is unchanged — the middle-out guess is still the default. */
  it("leaves the default read alone", async () => {
    const { workspace } = stub({ [path]: body });
    const tools = buildComputerTools(workspace, {
      ...config,
      maxOutputBytes: 400
    });

    const out = await run(tools, "sb_read", { path });
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    // …but the marker now names the way back to what it dropped.
    expect(out).toContain("offset:");
  });
});

describe("sb_exec", () => {
  it("passes the configured cwd and timeout, and lets the model override cwd", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, {
      ...config,
      cwd: "/workspace",
      timeoutMs: 1234
    });

    await run(tools, "sb_exec", { command: "npm test" });
    await run(tools, "sb_exec", { command: "ls", cwd: "/workspace/repo" });

    expect(execs[0]).toMatchObject({
      command: "npm test",
      options: { cwd: "/workspace", timeoutMs: 1234, encoding: "utf8" }
    });
    expect(execs[1]!.options).toMatchObject({ cwd: "/workspace/repo" });
  });

  /**
   * The seam, asserted where it actually is.
   *
   * `withShell` and `withShellTranscript` are tested above in isolation, which
   * proves they differ but not that each caller picked the right one — and
   * picking the wrong one is the whole defect. `sb_exec` writes for a model, so
   * it wants the transcript; `computerExec` hands its result to `/repo`, which
   * compares `stdout` against a URL, tests it for emptiness to call a tree clean,
   * and reads a sha out of it to push. Merging there turns every one of those
   * into a question git's diagnostics can answer wrongly.
   */
  it("sends a transcript, while computerExec sends two streams", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, { ...config, shell: "bash" });

    await run(tools, "sb_exec", { command: "npm run check" });

    expect(execs[0]!.command).toContain("bash -o pipefail -c ");
    expect(execs[0]!.command.endsWith(" 2>&1")).toBe(true);
    // The other half of the seam. `computerExec` builds its command with the
    // same `config.shell` and must not come back with the redirect on it.
    expect(withShell("git rev-list --count main..HEAD", "bash")).not.toContain(
      "2>&1"
    );
  });

  /**
   * A config thunk that reads straight off `env` hands back `undefined` for
   * anything unset, and `RuntimeExecOptions.env` is `Record<string, string>` —
   * so an unfiltered pass-through arrives in the container as the literal
   * string "undefined", which is worse than absent.
   */
  it("drops undefined environment entries rather than stringifying them", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, {
      ...config,
      env: () => ({ SET: "yes", UNSET: undefined })
    });

    await run(tools, "sb_exec", { command: "printenv" });

    expect((execs[0]!.options as { env: Record<string, string> }).env).toEqual({
      SET: "yes"
    });
  });

  /**
   * The thunk is the host's, and it is a thunk precisely so a rotated value is
   * picked up per command. Calling it twice while building *one* command's
   * options is two reads that can disagree — the one that decides whether `env`
   * is set, and the one that becomes its value.
   */
  it("reads the host's env thunk once per command", async () => {
    const { workspace } = stub();
    let reads = 0;
    const tools = buildComputerTools(workspace, {
      ...config,
      env: () => {
        reads += 1;
        return { SET: "yes" };
      }
    });

    await run(tools, "sb_exec", { command: "printenv" });

    expect(reads).toBe(1);
  });

  /**
   * `@cloudflare/computer` 0.2.1 separated "the container was swapped underneath
   * you" from "your command failed". The raw error reads like the latter, and a
   * model that believes it goes debugging a command that never ran — so the three
   * facts it needs are stated instead: nothing completed, the checkout survived,
   * `node_modules` did not.
   */
  it("tells the model a lost execution was the container, not the command", async () => {
    const lost = Object.assign(
      new Error(
        'Execution "e1" was lost when its container runtime was replaced.'
      ),
      { name: "WorkspaceExecutionLostError", code: "EEXEC_LOST" }
    );
    const { workspace } = stub({}, lost);
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_exec", { command: "npm test" });
    expect(out).toContain("container was replaced");
    expect(out).toContain("re-run it");
    expect(out).toContain("node_modules");
    // Not dressed up as a command failure, which is what it used to look like.
    expect(out).not.toContain("error running command");
  });

  it("still reports an ordinary exec failure as one", async () => {
    const { workspace } = stub({}, "container unreachable");
    const tools = buildComputerTools(workspace, config);

    const out = await run(tools, "sb_exec", { command: "npm test" });
    expect(out).toContain("error running command");
    expect(out).toContain("container unreachable");
  });
});

describe("the install gate on sb_exec", () => {
  const gated = (
    status: InstallState | undefined,
    extra: Partial<ComputerConfig> = {}
  ) => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0, ...extra },
      async () => status
    );
    return { tools, execs };
  };

  it("runs the command when nothing is installing", async () => {
    const { tools, execs } = gated({ state: "idle" });
    // The verdict line rides along on every result now, including this one.
    expect(await run(tools, "sb_exec", { command: "npm test" })).toBe(
      "ok\n--- exit 0 ---"
    );
    expect(execs).toHaveLength(1);
  });

  /**
   * The point of the whole mechanism. A shell command against a half-built
   * `node_modules` fails in ways that look like the code's fault, so the tool
   * runs nothing and tells the model to come back — which costs one cheap turn
   * instead of a misdiagnosis.
   */
  it("runs nothing while an install is in flight, and says why", async () => {
    const { tools, execs } = gated({
      state: "running",
      command: "npm ci",
      startedAt: Date.now() - 65_000,
      tail: "added 200 packages"
    });

    const out = await run(tools, "sb_exec", { command: "npm test" });
    expect(out).toContain("still running");
    expect(out).toContain("npm ci");
    expect(out).toContain("1m05s");
    expect(out).toContain("call again");
    expect(execs).toHaveLength(0);
  });

  /**
   * A failed install **warns and runs**, and this is the regression test for a
   * production deadlock.
   *
   * It used to refuse, like the `running` case above. But `running` resolves on
   * its own and `failed` does not — nothing clears that record except another
   * checkout — so one failed install disabled the shell for the rest of the
   * session. `echo hello` was refused. Worse, the refusal told the model to
   * "re-run the install yourself with sb_exec", which was the tool doing the
   * refusing: the advice and the behaviour were in direct contradiction and the
   * task had no way out.
   *
   * A failed install says something about `node_modules`, not about the shell.
   */
  it("warns about a failed install but still runs the command", async () => {
    const { tools, execs } = gated({
      state: "failed",
      command: "npm ci",
      finishedAt: Date.now(),
      exitCode: 1,
      error: "ERESOLVE could not resolve"
    });

    const out = await run(tools, "sb_exec", { command: "npm test" });
    expect(execs).toHaveLength(1);
    // The real output is there...
    expect(out).toContain("ok");
    // ...and so is the reason it might not mean what it looks like.
    expect(out).toContain("dependency install `npm ci` failed");
    expect(out).toContain("npm ci");
    expect(out).toContain("exit 1");
    expect(out).toContain("ERESOLVE");
  });

  /** The escape hatch has to actually work — it is what the warning advises. */
  it("lets the model re-run the install itself after a failure", async () => {
    const { tools, execs } = gated({
      state: "failed",
      command: "npm ci",
      finishedAt: Date.now(),
      exitCode: 1,
      error: "ERESOLVE could not resolve"
    });

    await run(tools, "sb_exec", { command: "npm ci --force" });
    expect(execs).toHaveLength(1);
    expect(execs[0]!.command).toBe("npm ci --force");
  });

  /** A command that throws still carries the warning — it explains the throw. */
  it("keeps the warning when the command itself fails", async () => {
    const { workspace, execs } = stub({}, "container unreachable");
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => ({
        state: "failed" as const,
        command: "npm ci",
        finishedAt: Date.now(),
        error: "boom"
      })
    );

    const out = await run(tools, "sb_exec", { command: "npm test" });
    expect(out).toContain("dependency install `npm ci` failed");
    expect(out).toContain("container unreachable");
    expect(execs).toHaveLength(0);
  });

  /**
   * `installGateMs` is a ceiling, and it used to be a floor.
   *
   * The poll slept a flat three seconds before re-reading, without asking how
   * much of the gate was left — so a 100 ms gate blocked for about three
   * seconds, and the one knob a host has for bounding this wait overshot it by
   * 30×. The sleep is now clamped to whatever remains.
   */
  it("gives the turn back within the gate, not within a poll interval", async () => {
    const { tools, execs } = gated(
      { state: "running", command: "npm ci", startedAt: Date.now() },
      { installGateMs: 100 }
    );

    const started = Date.now();
    const out = await run(tools, "sb_exec", { command: "npm test" });
    const elapsed = Date.now() - started;

    expect(out).toContain("still running");
    expect(execs).toHaveLength(0);
    // The poll interval is three seconds and the gate is a tenth of one. Before
    // the clamp this waited for the former.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("runs the command when the status cannot be read", async () => {
    const { workspace, execs } = stub();
    const tools = buildComputerTools(workspace, config, async () => {
      throw new Error("stub broken");
    });
    await expect(run(tools, "sb_exec", { command: "npm test" })).resolves.toBe(
      "ok\n--- exit 0 ---"
    );
    expect(execs).toHaveLength(1);
  });

  it("does not gate the file tools, which read source rather than deps", async () => {
    const path = "/workspace/repo/a.ts";
    const { workspace } = stub({ [path]: "x" });
    const tools = buildComputerTools(
      workspace,
      { ...config, installGateMs: 0 },
      async () => ({
        state: "running" as const,
        command: "npm ci",
        startedAt: Date.now()
      })
    );
    expect(await run(tools, "sb_read", { path })).toBe("x");
  });
});

describe("the workspace a subtask reaches", () => {
  /**
   * A subagent cannot compute the name: it is derived from the verified caller,
   * and core gives a subagent execution a `callerKey` thunk that throws. The
   * parent's `resolveRuntime` puts it here, and reading it back is what makes a
   * delegated subtask land in the checkout its parent cloned.
   */
  it("comes from the runtime when a parent supplied one", () => {
    expect(
      workspaceNameFromRuntime({ [WORKSPACE_RUNTIME_KEY]: "caller|o/r" })
    ).toBe("caller|o/r");
  });

  it("falls back rather than throwing on anything else", () => {
    for (const runtime of [undefined, null, {}, { workspaceName: "" }, 7]) {
      expect(workspaceNameFromRuntime(runtime)).toBeUndefined();
    }
  });
});
