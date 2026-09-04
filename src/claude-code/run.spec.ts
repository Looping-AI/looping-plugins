import { describe, expect, it } from "vitest";
import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle
} from "@cloudflare/computer";
import {
  buildLaunch,
  drainRun,
  execIdFor,
  freshCursor,
  startRun,
  CREDENTIAL_PLACEHOLDER,
  type DrainCursor,
  type SessionRuntime
} from "./run.js";
import { DEFAULT_PERMISSION_MODE } from "./config.js";

const EXEC = execIdFor(7);
const FRESH = freshCursor(EXEC);

/**
 * Launching and draining, and the two failures that are invisible until
 * production.
 *
 * A drain that returns as soon as it has nothing to read burns
 * `MAX_CHUNKS_PER_BRANCH` in seconds and the subtask dies having done nothing
 * wrong. A cursor that does not carry loses whichever line the window happened
 * to cut in half — which for a stream of one-JSON-object-per-line is a whole
 * event, silently.
 */

type Event = WorkspaceRuntimeEvent<"utf8">;

const stdout = (seq: number, value: string): Event => ({
  id: EXEC,
  seq,
  name: "stdout",
  value
});

const exit = (seq: number, code: number): Event => ({
  id: EXEC,
  seq,
  name: "exit",
  code
});

const stderrOut = (seq: number, value: string): Event => ({
  id: EXEC,
  seq,
  name: "stderr",
  value
});

/**
 * A handle over a fixed script of events. `open: true` leaves the stream running
 * after the script, which is what a session still thinking looks like.
 */
function fakeHandle(
  script: readonly Event[],
  open = false
): WorkspaceRuntimeExecHandle<"utf8"> {
  const stream = new ReadableStream<Event>({
    start(controller) {
      for (const event of script) controller.enqueue(event);
      if (!open) controller.close();
    }
  });
  return Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) =>
  line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const RESULT_LINE = line({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  total_cost_usd: 1.25,
  usage: { output_tokens: 900 }
});

/**
 * Walk a POSIX-ish command and yield the characters the shell would see
 * *outside* any quoting, so a test can assert what the shell actually gets
 * rather than what the string happens to contain.
 */
function* unquotedPositions(command: string): Generator<[number, string]> {
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    // A backslash escapes the next character everywhere except inside single
    // quotes. Missing this reads POSIX's `'\''` idiom — which is how
    // `shellQuote` embeds a quote — as *closing* the quoting, and then the rest
    // of a perfectly safe argument looks unquoted.
    if (ch === "\\" && !single) {
      i++;
      continue;
    }
    if (ch === "'" && !double) {
      single = !single;
      continue;
    }
    if (ch === '"' && !single) {
      double = !double;
      continue;
    }
    if (!single && !double) yield [i, ch];
  }
}

describe("buildLaunch", () => {
  const launch = (over = {}) =>
    buildLaunch({ prompt: "fix the bug", dir: "/workspace/repo", ...over });

  it("streams, and asks for the verbose form that actually streams", () => {
    // Without `--verbose`, stream-json emits only the final result — which would
    // make every progress note in this package arrive at once, at the end.
    expect(launch().command).toContain("--output-format stream-json --verbose");
  });

  /**
   * The prompt is model-authored, so the only thing worth asserting is the
   * property a substring check cannot see: that every shell metacharacter ends
   * up *inside* a quoted token. `; rm -rf /` appearing in the command string is
   * fine and expected — what would not be fine is the shell reaching it.
   */
  it("leaves no shell metacharacter unquoted in the prompt", () => {
    const { command } = launch({ prompt: `it's "broken"; rm -rf / && id` });

    for (const [index, at] of unquotedPositions(command)) {
      expect(
        ";&|`$(){}<>".includes(at),
        `unquoted ${at} at ${index} in: ${command}`
      ).toBe(false);
    }
    // And the flags after it are still their own tokens.
    expect(command).toContain(" --output-format stream-json --verbose");
  });

  it("passes the placeholder credential and never a real one", () => {
    expect(launch().env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
  });

  /**
   * The transparent intercept is what makes this absent, and its absence is the
   * point: nothing in the container is *told* to use a proxy, so nothing in the
   * container can be told not to.
   */
  it("sets no ANTHROPIC_BASE_URL — egress is intercepted, not configured", () => {
    expect(Object.keys(launch().env)).not.toContain("ANTHROPIC_BASE_URL");
  });

  /**
   * §4 of the design plan, cancelled 2026-08-21. A repository's `CLAUDE.md`,
   * skills and hooks are what make the agent good at that repository, and the
   * container already runs the repo's `postinstall` and its test suite — so
   * stripping one door while the others stand open costs context and buys
   * nothing.
   */
  it("runs the repository's own configuration rather than suppressing it", () => {
    const { command, env } = launch();
    expect(command).not.toContain("--bare");
    expect(command).not.toContain("--settings");
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("pins the version by refusing to autoupdate mid-run", () => {
    expect(launch().env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it("caps the inner subagent tree when asked", () => {
    const { env } = launch({ maxSubagentDepth: 1, maxConcurrentSubagents: 4 });
    expect(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("4");
  });

  it("omits the caps entirely rather than inventing a default", () => {
    expect(launch().env).not.toHaveProperty(
      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"
    );
  });

  it("adds the model and turn ceiling only when given", () => {
    expect(launch().command).not.toContain("--model");
    expect(launch({ model: "claude-opus-5", maxTurns: 30 }).command).toContain(
      "--model claude-opus-5 --max-turns 30"
    );
  });

  it("lets a host add environment, merged last", () => {
    const { env } = launch({ env: { CI: "1", DISABLE_AUTOUPDATER: "0" } });
    expect(env.CI).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("0");
  });

  /**
   * The whole point of the option. `-p` is headless, so a mode that would prompt
   * auto-denies instead — a session left on the default reads the repository
   * perfectly and cannot write to it.
   */
  describe("the permission mode", () => {
    it("is always passed, so headless never falls back to auto-deny", () => {
      expect(launch().command).toContain(
        `--permission-mode ${DEFAULT_PERMISSION_MODE}`
      );
    });

    it("defaults to the only mode that can edit a checkout", () => {
      expect(DEFAULT_PERMISSION_MODE).toBe("bypassPermissions");
    });

    it("carries a host's choice through instead", () => {
      expect(launch({ permissionMode: "acceptEdits" }).command).toContain(
        "--permission-mode acceptEdits"
      );
    });

    /**
     * The root guard, and the reason these two live in one branch.
     *
     * The container runs as uid 0, and the CLI exits 1 — before its first JSON
     * line, explaining itself only on stderr — if asked to bypass permissions
     * under root without this. The flag alone is a worse failure than no flag.
     */
    it("clears the root guard whenever it bypasses", () => {
      expect(launch().env.IS_SANDBOX).toBe("1");
      expect(
        launch({ permissionMode: "bypassPermissions" }).env.IS_SANDBOX
      ).toBe("1");
    });

    it("sets nothing for a mode that does not need it", () => {
      for (const mode of ["default", "acceptEdits", "plan", "auto"] as const) {
        expect(launch({ permissionMode: mode }).env).not.toHaveProperty(
          "IS_SANDBOX"
        );
      }
    });

    /**
     * `env` is merged last so a deployment can add what a repository needs, and
     * that merge is exactly how this could be switched off from a config file —
     * silently, leaving a session that exits 1 for a reason nothing reports.
     */
    it("is not something a host's own environment can unset", () => {
      const { env } = launch({ env: { IS_SANDBOX: "0" } });
      expect(env.IS_SANDBOX).toBe("1");
    });
  });
});

describe("drainRun", () => {
  const window = { windowMs: 5_000 };

  it("reports the run done on the exit event, with its result", async () => {
    const handle = fakeHandle([
      stdout(1, assistant("working")),
      stdout(2, RESULT_LINE),
      exit(3, 0)
    ]);

    const outcome = await drainRun(handle, FRESH, window);

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.costUsd).toBe(1.25);
    expect(outcome.cursor.seq).toBe(3);
    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:0"]);
  });

  /**
   * The pacing rule. A session legitimately runs longer than one chunk, and a
   * drain that returned the moment it had nothing to read would exhaust the
   * branch's forty chunks in seconds without the run ever failing.
   */
  it("blocks until the window expires while the session is still going", async () => {
    const handle = fakeHandle([stdout(1, assistant("thinking"))], true);
    const started = Date.now();

    const outcome = await drainRun(handle, FRESH, { windowMs: 60 });

    expect(outcome.done).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(outcome.progress).toHaveLength(1);
    expect(outcome.cursor.seq).toBe(1);
  });

  /**
   * The window routinely cuts a line in half, and for a stream of one JSON
   * object per line that is a whole event. The carry is what makes the next
   * chunk able to finish it.
   */
  it("carries a half-read line into the next window", async () => {
    const whole = assistant("a complete thought");
    const cut = Math.floor(whole.length / 2);

    const first = await drainRun(
      fakeHandle([stdout(1, whole.slice(0, cut))], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.progress).toHaveLength(0);
    expect(first.cursor.carry).toBe(whole.slice(0, cut));

    const second = await drainRun(
      fakeHandle([stdout(2, whole.slice(cut))], true),
      first.cursor,
      { windowMs: 40 }
    );
    expect(second.progress.map((p) => p.text)).toEqual(["a complete thought"]);
  });

  /**
   * Progress keys are positional, so the count has to survive the chunk boundary
   * or the second chunk restarts at `claude:0` and the gatekeeper drops every note
   * as a duplicate of one it already showed.
   */
  it("continues the progress numbering across chunks", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, assistant("one") + assistant("two"))], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.cursor.emitted).toBe(2);

    const second = await drainRun(
      fakeHandle([stdout(2, assistant("three")), exit(3, 0)]),
      first.cursor,
      window
    );
    expect(second.progress.map((p) => p.key)).toEqual(["claude:2"]);
  });

  /**
   * The stream ending with no `exit` means the container went away under the
   * run. Reporting it as still-running would make the caller wait out its entire
   * chunk budget on a dead process.
   */
  it("treats a stream that ends without an exit event as a failure", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, assistant("half a job"))]),
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(-1);
    expect(outcome.result).toBeUndefined();
  });

  it("resumes from a cursor without re-emitting what the last chunk showed", async () => {
    const cursor: DrainCursor = {
      execId: EXEC,
      seq: 9,
      carry: "",
      emitted: 3
    };
    const outcome = await drainRun(
      fakeHandle([stdout(10, assistant("next")), exit(11, 0)]),
      cursor,
      window
    );

    expect(outcome.progress.map((p) => p.key)).toEqual(["claude:3"]);
    expect(outcome.cursor.seq).toBe(11);
  });

  it("reports a non-zero exit without a result line", async () => {
    const outcome = await drainRun(
      fakeHandle([stdout(1, "some stderr-ish noise\n"), exit(2, 143)]),
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.exitCode).toBe(143);
    expect(outcome.result).toBeUndefined();
  });

  /**
   * The failure this exists for: a CLI that rejects its own arguments prints one
   * line on stderr and exits before writing any JSON. Reported as an exit code
   * alone — which is what happened before this — the cause is unrecoverable from
   * the logs, and the operator sees only "exited with code 1".
   */
  it("keeps stderr when the process dies before reporting anything", async () => {
    const outcome = await drainRun(
      fakeHandle([stderrOut(1, "cannot be used with root/sudo\n"), exit(2, 1)]),
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.result).toBeUndefined();
    expect(outcome.stderr).toContain("root/sudo");
  });

  /**
   * A session that reported for itself has said everything worth saying. Its
   * stderr is the CLI's own chatter, and surfacing it beside a good report only
   * buries the report.
   */
  it("says nothing about stderr when the session reported a result", async () => {
    const outcome = await drainRun(
      fakeHandle([
        stderrOut(1, "a deprecation warning nobody needs\n"),
        stdout(2, RESULT_LINE),
        exit(3, 0)
      ]),
      FRESH,
      window
    );

    expect(outcome.done).toBe(true);
    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.result).toBeDefined();
    expect(outcome.stderr).toBeUndefined();
  });

  /**
   * The death and the exit can land in different windows, so the tail rides on
   * the cursor rather than living in one drain's locals.
   */
  it("carries stderr across a window boundary", async () => {
    const first = await drainRun(
      fakeHandle([stderrOut(1, "first half ")], true),
      FRESH,
      { windowMs: 40 }
    );
    expect(first.done).toBe(false);
    expect(first.cursor.stderr).toBe("first half ");

    const outcome = await drainRun(
      fakeHandle([stderrOut(2, "second half"), exit(3, 1)]),
      first.cursor,
      window
    );

    if (!outcome.done) throw new Error("unreachable");
    expect(outcome.stderr).toBe("first half second half");
  });

  /**
   * Bounded on every append, not once at the end: an unbounded tail is a
   * Durable Object holding whatever a runaway build decided to print.
   */
  it("bounds a runaway stderr while keeping both ends of it", async () => {
    const outcome = await drainRun(
      fakeHandle(
        [stderrOut(1, `HEAD${"x".repeat(50_000)}TAIL`), exit(2, 1)],
        false
      ),
      FRESH,
      window
    );

    if (!outcome.done) throw new Error("unreachable");
    const kept = outcome.stderr ?? "";
    expect(kept.length).toBeLessThanOrEqual(2_000);
    expect(kept.startsWith("HEAD")).toBe(true);
    expect(kept.endsWith("TAIL")).toBe(true);
  });
});

/**
 * A handle shaped like the one `@cloudflare/computer` actually returns.
 *
 * `withPostPull` wraps the runtime's event stream in a `ReadableStream` whose
 * `pull` runs the **container-to-workspace filesystem sync** when the source
 * reaches its end, and only then closes. That ordering is the whole reason the
 * drain must read past `exit`: a consumer that stops early never triggers the
 * pull, and the session's edits never reach the durable checkout.
 *
 * `cancel` deliberately does *not* run it — the real wrapper resolves its
 * outcome as `pending` on that path — which is what makes the two tests below
 * able to tell the behaviours apart.
 */
function handleWithPostPull(script: readonly Event[], open = false) {
  const state = { synced: false, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Event>({
    async pull(controller) {
      if (i < script.length) {
        controller.enqueue(script[i++]!);
        return;
      }
      // `open` models a session still thinking: the source has nothing more yet,
      // so `pull` never settles and the consumer's read stays pending until the
      // window expires. Closing here instead would end the run.
      if (open) return await new Promise<void>(() => {});
      state.synced = true;
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    }
  });
  const handle = Object.assign(stream, {
    id: EXEC,
    backend: "container",
    result: async () => {
      throw new Error("not used by the drain");
    },
    kill: async () => {},
    [Symbol.dispose]: () => {}
  }) as unknown as WorkspaceRuntimeExecHandle<"utf8">;
  return { handle, state };
}

describe("the filesystem sync", () => {
  /**
   * The most consequential test in this file. Returning on the `exit` event
   * leaves the wrapped stream unread, so the post-exec pull never runs — the run
   * reports success and the edits are simply not in the workspace.
   */
  it("reads past exit to the end of the stream, so the workspace pull runs", async () => {
    const { handle, state } = handleWithPostPull([
      stdout(1, assistant("edited a file")),
      stdout(2, RESULT_LINE),
      exit(3, 0)
    ]);

    const outcome = await drainRun(handle, FRESH, { windowMs: 5_000 });

    expect(outcome.done).toBe(true);
    expect(state.synced).toBe(true);
  });

  /**
   * A window that ends mid-session must *not* trigger the pull — there is
   * nothing to sync yet — but it must cancel, because merely releasing the
   * reader lock leaves the attachment and its pending read alive on the far
   * side, one per chunk.
   */
  it("cancels the attachment when the window expires, without syncing", async () => {
    const { handle, state } = handleWithPostPull(
      [stdout(1, assistant("still working"))],
      true
    );

    const outcome = await drainRun(handle, FRESH, { windowMs: 50 });

    expect(outcome.done).toBe(false);
    // Cancelled, because merely releasing the reader lock leaves the attachment
    // and its pending read alive on the far side — one stranded per chunk.
    expect(state.cancelled).toBe(true);
    // And not synced: there is nothing to pull back until the session ends.
    expect(state.synced).toBe(false);
  });
});

describe("one exec id per subtask", () => {
  /**
   * Subtasks are a flat concurrent fan-out, and a workspace is one container. A
   * shared exec id would let two sessions spawn over each other, each drain
   * attach to whichever won, and `stop` kill somebody else's run.
   */
  it("namespaces the id so two subtasks cannot collide", () => {
    expect(execIdFor(7)).not.toBe(execIdFor(8));
    expect(execIdFor(7)).toContain("7");
  });

  it("carries the id in the cursor rather than re-deriving it", () => {
    expect(freshCursor(execIdFor(7)).execId).toBe(execIdFor(7));
  });
});

describe("startRun", () => {
  const handleFor = () => fakeHandle([exit(1, 0)]);

  function runtimeThatIsBusy(): SessionRuntime & { attached: string[] } {
    const attached: string[] = [];
    return {
      attached,
      exec: async () => {
        throw Object.assign(new Error("execution is running"), {
          code: "EEXEC_BUSY"
        });
      },
      getExec: async (id: string) => {
        attached.push(id);
        return handleFor();
      },
      killExec: async () => {}
    };
  }

  /**
   * `start` spawns and then drains for minutes, so a chunk that fails anywhere
   * after the spawn is retried with no cursor to resume from — and the runtime
   * refuses to reuse a live id. Without the fallback the retry throws, every
   * later retry throws identically, and a healthy session becomes unreachable.
   */
  it("attaches instead of failing when the id is already live", async () => {
    const runtime = runtimeThatIsBusy();
    const handle = await startRun(runtime, {
      prompt: "p",
      dir: "/workspace/repo",
      execId: EXEC,
      timeoutMs: 1000
    });

    expect(runtime.attached).toEqual([EXEC]);
    expect(handle.id).toBe(EXEC);
  });

  it("rethrows anything that is not a busy id", async () => {
    const runtime: SessionRuntime = {
      exec: async () => {
        throw Object.assign(new Error("no container"), {
          code: "ECONNREFUSED"
        });
      },
      getExec: async () => handleFor(),
      killExec: async () => {}
    };

    await expect(
      startRun(runtime, {
        prompt: "p",
        dir: "/workspace/repo",
        execId: EXEC,
        timeoutMs: 1000
      })
    ).rejects.toThrow(/no container/);
  });
});

describe("the reserved credential key", () => {
  /**
   * `env` is merged last so a deployment can add what a repository needs, and
   * that merge is exactly how the placeholder could be replaced by a real
   * credential — silently, and in every container from then on.
   */
  it("refuses a host trying to set the OAuth token", () => {
    expect(() =>
      buildLaunch({
        prompt: "p",
        dir: "/workspace/repo",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-REAL" }
      })
    ).toThrow(/cannot be set through/);
  });

  it("keeps the placeholder even when other host env is merged", () => {
    const { env } = buildLaunch({
      prompt: "p",
      dir: "/workspace/repo",
      env: { CI: "1" }
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
    expect(env.CI).toBe("1");
  });
});

describe("the result across a chunk boundary", () => {
  /**
   * The `result` line and the `exit` event are two events, and a window can end
   * between them. Losing the result means a successful session reports a
   * terminal outcome with nothing in it — and `persistResult` turns an empty
   * report into a failure.
   */
  it("carries a result seen in one window into the next", async () => {
    const first = await drainRun(
      fakeHandle([stdout(1, RESULT_LINE)], true),
      FRESH,
      { windowMs: 40 }
    );

    expect(first.done).toBe(false);
    expect(first.cursor.result?.costUsd).toBe(1.25);

    const second = await drainRun(fakeHandle([exit(2, 0)]), first.cursor, {
      windowMs: 5_000
    });

    expect(second.done).toBe(true);
    if (!second.done) throw new Error("unreachable");
    expect(second.result?.costUsd).toBe(1.25);
  });
});
