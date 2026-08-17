import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import type { WorkspaceClient } from "@cloudflare/computer";
import {
  buildComputerTools,
  isContainerOnly,
  needsDependencies,
  renderResult,
  truncateOutput,
  withShell,
  workspaceNameFromRuntime,
  WORKSPACE_RUNTIME_KEY,
  type ComputerConfig,
  type InstallState
} from "./index.js";

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
  execThrows?: string | Error
): {
  workspace: () => Promise<WorkspaceClient>;
  execs: Array<{ command: string; options?: unknown }>;
  readdirs: Array<{ limit?: number }>;
  files: Map<string, string>;
} {
  const execs: Array<{ command: string; options?: unknown }> = [];
  const readdirs: Array<{ limit?: number }> = [];
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
      writeFile: async (path: string, content: string) => {
        files.set(path, String(content));
      },
      mkdir: async () => undefined,
      exists: async (path: string) => files.has(path),
      readdir: async (_path: string, options?: { limit?: number }) => (
        readdirs.push(options ?? {}),
        [
          { name: "src", isDirectory: true, isFile: false, size: 0 },
          {
            name: "package.json",
            isDirectory: false,
            isFile: true,
            size: 2048
          }
        ].slice(0, options?.limit)
      ),
      ls: async () => [...files.keys()]
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

  return { workspace: async () => client, execs, readdirs, files };
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
 * The shell wrapper. Two jobs: pick the shell the model actually writes for, and
 * merge the streams so a chained `a && b && c` reads in the order it ran.
 */
describe("withShell", () => {
  it("is a no-op when no shell is configured", () => {
    expect(withShell("npm test", undefined)).toBe("npm test");
  });

  it("merges stderr into stdout on the wrapper process", () => {
    const wrapped = withShell("npm run check", "bash");
    expect(wrapped.startsWith("bash -o pipefail -c ")).toBe(true);
    // Bound to the wrapper, not nested inside it — so it applies to everything
    // the command spawns, however deep, with no brace group to mis-parse.
    expect(wrapped.endsWith(" 2>&1")).toBe(true);
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
    const wrapped = withShell(`git commit -m "add a line"`, "bash");
    expect(wrapped).toContain("add a line");
    expect(wrapped.endsWith(" 2>&1")).toBe(true);
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

    for (const name of ["sb_read", "sb_ls", "sb_exists"]) {
      const out = await run(tools, name, { path });
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
   * Failing open, deliberately. The gate reads another Durable Object; an RPC
   * hiccup there must not take out a working shell, and running the command is
   * exactly what would have happened before the gate existed.
   */
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
