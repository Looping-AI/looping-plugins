import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import {
  scratch,
  DEFAULT_SCRATCH_DIR,
  SCRATCH_OPEN_TOOL,
  type ScratchConfig,
  type ScratchReadiness
} from "./index.js";

/**
 * The scratchpad's mechanics, with no container.
 *
 * `exec` is injected precisely so this is testable without one, which lets the
 * assertions be made on the exact command strings, working directory and
 * environment — which is where the properties worth protecting live. A
 * scratchpad has to be a repository that can be **reset**, a reset has to empty
 * it, and a container that did not answer must never look like a repository that
 * is not there.
 *
 * What is deliberately *not* here is anything about how a host addresses a
 * scratchpad — which workspace it selects, how it is recorded, when it is
 * reclaimed. That is the host's, exercised in the host's own suite through the
 * two hooks.
 */

interface Ran {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** A shell that records what it was asked and answers from a script. */
function fakeExec(
  answer: (
    command: string
  ) => { success: boolean; stdout?: string } | Error = () => ({
    success: true
  })
) {
  const commands: Ran[] = [];
  const exec: ScratchConfig["exec"] = async (command, options) => {
    commands.push({
      command,
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env })
    });
    const result = answer(command);
    if (result instanceof Error) throw result;
    return {
      success: result.success,
      stdout: result.stdout ?? "",
      stderr: result.success ? "" : "git said no",
      exitCode: result.success ? 0 : 1
    };
  };
  return { exec, commands };
}

/** The probe is the only command that starts with `test`. */
const isProbe = (command: string) => command.startsWith("test -e");
const isInit = (command: string) => command.includes("git init");
const isReset = (command: string) => command.includes("git clean");
const isStatus = (command: string) => command.startsWith("git status");

/** "There is no usable scratchpad here" — what the probe says on a bare path. */
const nothingThere = (command: string) =>
  isProbe(command) ? { success: false } : { success: true };

const open = async (
  config: ScratchConfig,
  input: { reset?: boolean } = {}
): Promise<string> => {
  const tools = (await scratch(config).mainAgentTools?.(
    {} as never
  )) as ToolSet;
  const execute = tools[SCRATCH_OPEN_TOOL]!.execute as (
    input: unknown,
    options: unknown
  ) => Promise<string>;
  return await execute(input, {});
};

describe("finding out whether there is one", () => {
  /**
   * A command's working directory has to exist before the command starts. Asking
   * this from inside the scratchpad makes the very **first** open — the one where
   * the directory is not there yet — fail before git runs, which this plugin
   * cannot tell apart from a container that did not answer. The result is a
   * scratchpad that can never be created, reported as infrastructure.
   */
  it("asks from a directory that exists", async () => {
    const { exec, commands } = fakeExec(nothingThere);

    await open({ exec });

    expect(commands[0]!.command).toSatisfy(isProbe);
    expect(commands[0]!.cwd).toBe("/");
  });

  /**
   * `git rev-parse` from inside the scratchpad walks *upwards*, so a scratchpad
   * sitting anywhere within another repository answers yes — and a later
   * `reset: true` would then discard that repository's tree instead. The question
   * is whether the scratchpad is itself a repository root.
   */
  it("does not accept a repository above the scratchpad", async () => {
    const { exec, commands } = fakeExec(nothingThere);

    await open({ exec });

    expect(commands[0]!.command).toContain('test -e "$SCRATCH_DIR/.git"');
  });

  /**
   * `git init` and the commit after it are two commands, and only the pair is
   * meaningful — an open interrupted between them leaves a repository with no
   * `HEAD`, which is exactly the state a host's cancellation cleanup cannot
   * recover from. So the probe asks for the commit, not just the repository, and
   * an incomplete scratchpad is repaired rather than accepted.
   */
  it("repairs a repository that has no commit", async () => {
    const { exec, commands } = fakeExec((command) =>
      // `.git` is there; `rev-parse HEAD` is what fails.
      isProbe(command) ? { success: false } : { success: true }
    );

    await open({ exec });

    expect(commands[0]!.command).toContain("rev-parse --verify -q HEAD");
    expect(commands.some((c) => isInit(c.command))).toBe(true);
  });
});

describe("opening a scratchpad", () => {
  /**
   * **The empty commit is the assertion.** Without a `HEAD`, `git reset --hard`
   * fails outright — and that is what a host runs to discard a cancelled task's
   * edits. Since such cleanup is best-effort in every host that has one, the
   * failure would be a logged warning plus a cancelled run's files surviving into
   * the next task as its starting point.
   */
  it("creates a repository that can be reset", async () => {
    const { exec, commands } = fakeExec(nothingThere);

    const said = await open({ exec });

    const init = commands.find((c) => isInit(c.command));
    expect(init).toBeDefined();
    expect(init!.command).toContain("git commit -q --allow-empty");
    // From outside the scratchpad, since the command's first act is to create it.
    expect(init!.cwd).toBe("/");
    expect(said).toContain(`Opened a scratchpad at ${DEFAULT_SCRATCH_DIR}`);
    expect(said).toContain("nothing in it is pushed anywhere");
  });

  /**
   * Every value reaches the shell as data. Double quotes still expand `$(…)`,
   * backticks and variables, so a host directory or a committer name containing
   * one would otherwise be shell rather than a value — a different path, or a
   * command nobody asked for.
   */
  it("never spells a configured value in shell text", async () => {
    const { exec, commands } = fakeExec(nothingThere);

    await open({
      exec,
      dir: "/srv/pad",
      author: { name: 'A "quoted" name', email: "a@b.test" }
    });

    for (const ran of commands) {
      expect(ran.command).not.toContain("/srv/pad");
      expect(ran.command).not.toContain("quoted");
      expect(ran.env?.SCRATCH_DIR).toBe("/srv/pad");
    }
    const init = commands.find((c) => isInit(c.command))!;
    expect(init.env?.GIT_NAME).toBe('A "quoted" name');
  });

  /**
   * A probe that never ran has answered nothing. Read as "there is no repository
   * here", a lost container would re-init over a healthy scratchpad and discard
   * whatever an earlier task left in it — which is the one loss here that cannot
   * be undone.
   */
  it("does not re-init over a scratchpad it could not reach", async () => {
    const { exec, commands } = fakeExec(() => new Error("EEXEC_LOST"));

    const said = await open({ exec });

    expect(said).toContain("could not reach the container");
    expect(said).toContain("Nothing was created or changed");
    expect(commands.some((c) => isInit(c.command))).toBe(false);
  });

  /**
   * Durable across tasks is the point — a scratchpad that emptied itself would
   * lose the script the user is about to ask about again. So emptying it is
   * something the model asks for, and reopening says what is there rather than
   * letting a brief be written for a tree that is not empty.
   */
  it("reuses what an earlier task left, unless asked to reset", async () => {
    const { exec, commands } = fakeExec((command) =>
      isStatus(command)
        ? { success: true, stdout: "?? primes.mjs\n" }
        : { success: true }
    );

    const said = await open({ exec });

    expect(commands.some((c) => isReset(c.command))).toBe(false);
    expect(said).toContain("Reopened the scratchpad");
    expect(said).toContain("primes.mjs");
  });

  /**
   * **`-ff`, not `-f`.** One force leaves untracked nested repositories in place,
   * and a scratchpad is where those turn up — cloning something to look at it is
   * one of the things it is for. Anything short of the second force reports an
   * emptiness it did not deliver.
   */
  it("empties it when asked", async () => {
    const { exec, commands } = fakeExec();

    const said = await open({ exec }, { reset: true });

    const cleaned = commands.find((c) => isReset(c.command));
    expect(cleaned!.command).toContain("git clean -ffdxq");
    expect(said).toContain("emptied it");
    // Nothing is asked about the tree — this call is what made it empty.
    expect(commands.some((c) => isStatus(c.command))).toBe(false);
  });

  /**
   * Establishing the repository is not the same as establishing an empty tree.
   * `git init` over a directory that already holds files leaves every one of
   * them, so the tree still has to be read — the alternative is telling the model
   * a scratchpad is empty and letting it write a brief for one.
   */
  it("does not claim an initialised scratchpad is empty", async () => {
    const { exec, commands } = fakeExec((command) =>
      isProbe(command)
        ? { success: false }
        : isStatus(command)
          ? { success: true, stdout: "?? left-behind.txt\n" }
          : { success: true }
    );

    const said = await open({ exec });

    expect(commands.some((c) => isStatus(c.command))).toBe(true);
    expect(said).not.toContain("It is empty");
    expect(said).toContain("left-behind.txt");
  });

  it("says what went wrong when the repository cannot be created", async () => {
    const { exec } = fakeExec((command) =>
      isProbe(command) || isInit(command)
        ? { success: false }
        : { success: true }
    );

    const said = await open({ exec });

    expect(said).toContain("could not create the scratchpad");
    expect(said).toContain("git said no");
  });
});

describe("the host's half", () => {
  /**
   * The ordering `/repo` gets from `beforeCheckout`. A host that keys its
   * container per repository has to have switched before the first command, or
   * `git init` lands in whichever workspace the last task left open.
   */
  it("lets the host select its workspace before anything runs", async () => {
    const order: string[] = [];
    const { exec } = fakeExec((command) => {
      order.push(command);
      return nothingThere(command);
    });

    await open({ exec, beforeOpen: () => order.push("selected") });

    expect(order[0]).toBe("selected");
  });

  /** A host that cannot choose a workspace has not chosen one. */
  it("fails the open when the host cannot select a workspace", async () => {
    const { exec, commands } = fakeExec();

    await expect(
      open({
        exec,
        beforeOpen: () => {
          throw new Error("no caller identity");
        }
      })
    ).rejects.toThrow("no caller identity");
    expect(commands).toHaveLength(0);
  });

  it("hands the host the scratchpad it opened", async () => {
    const seen: unknown[] = [];
    const { exec } = fakeExec(nothingThere);

    await open({
      exec,
      afterOpen: async (s) => {
        seen.push(s);
      }
    });

    expect(seen).toEqual([{ dir: DEFAULT_SCRATCH_DIR, fresh: true }]);
  });

  /**
   * The failure this exists to prevent: a tool reporting success and a
   * delegation then refusing, in two different places, with nothing connecting
   * them. The plugin knows `git init` exited 0; only the host knows whether its
   * durable record agrees.
   */
  it("reports a scratchpad the host cannot see, rather than claiming it is open", async () => {
    const { exec } = fakeExec(nothingThere);

    const said = await open({
      exec,
      afterOpen: async (): Promise<ScratchReadiness> => ({
        ready: false,
        because: "the workspace has not caught up"
      })
    });

    expect(said).toContain("not usable yet");
    expect(said).toContain("the workspace has not caught up");
    expect(said).toContain(`Call ${SCRATCH_OPEN_TOOL} again`);
  });

  /**
   * Not caught, unlike `/repo`'s `afterCheckout`. A clone is still useful to an
   * agent whose follow-up hook failed; a scratchpad the host did not record
   * cannot be delegated into at all, so swallowing this would promise something
   * that is not there.
   */
  it("does not swallow a host that failed to record it", async () => {
    const { exec } = fakeExec(nothingThere);

    await expect(
      open({
        exec,
        afterOpen: async () => {
          throw new Error("workspace unreachable");
        }
      })
    ).rejects.toThrow("workspace unreachable");
  });

  it("takes a host's own directory", async () => {
    const { exec } = fakeExec(nothingThere);

    const said = await open({ exec, dir: "/srv/pad" });

    expect(said).toContain("/srv/pad");
  });
});

describe("the capability block", () => {
  /**
   * The mixing rule earns its tokens: a host keying one workspace selection per
   * caller points *every* workspace tool at whatever was selected last, so an
   * agent that opens a scratchpad mid-checkout has silently moved its own
   * `repo_diff` and `repo_commit` with it.
   */
  it("names the directory, the absent remote and the mixing rule", () => {
    const capability = scratch({ exec: fakeExec().exec }).capability ?? "";

    expect(capability).toContain(DEFAULT_SCRATCH_DIR);
    expect(capability).toContain("Nothing in it is ever pushed");
    expect(capability).toContain("One task works in one place");
  });
});

describe("a cancelled open", () => {
  it("ends as a cancellation, not as a container that did not answer", async () => {
    const controller = new AbortController();
    const reason = new Error("round cancelled");
    // What `computerExec` does on an abort: the command is killed, and the call
    // rejects with the signal's reason.
    const { exec } = fakeExec(() => {
      controller.abort(reason);
      return reason;
    });
    const tools = (await scratch({ exec }).mainAgentTools?.(
      {} as never
    )) as ToolSet;
    const execute = tools[SCRATCH_OPEN_TOOL]!.execute as (
      input: unknown,
      options: unknown
    ) => Promise<string>;

    // "could not reach the container … try again in a moment" is the sentence an
    // unreachable container earns, and it would send the model straight back to
    // a call that was cancelled on purpose.
    await expect(execute({}, { abortSignal: controller.signal })).rejects.toBe(
      reason
    );
  });
});
