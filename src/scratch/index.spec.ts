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
 * assertions be made on the exact command strings — and the command strings are
 * where the two properties worth protecting live: a fresh scratchpad is a
 * repository that can be **reset**, and a container that did not answer never
 * looks like a repository that is not there.
 *
 * What is deliberately *not* here is anything about how a host addresses a
 * scratchpad — which workspace it selects, how it is recorded, when it is
 * reclaimed. That is the host's, exercised in the host's own suite through the
 * two hooks.
 */

/** A shell that records what it was asked and answers from a script. */
function fakeExec(
  answer: (
    command: string
  ) => { success: boolean; stdout?: string } | Error = () => ({
    success: true
  })
) {
  const commands: { command: string; cwd?: string; env?: unknown }[] = [];
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

/** "Nothing is checked out here" — what `rev-parse` says on a bare directory. */
const noRepository = (command: string) =>
  command.startsWith("git rev-parse") ? { success: false } : { success: true };

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

describe("opening a scratchpad", () => {
  /**
   * **The empty commit is the assertion.** Without a `HEAD`, `git reset --hard`
   * fails outright — and that is what a host runs to discard a cancelled task's
   * edits. Since such cleanup is best-effort in every host that has one, the
   * failure would be a logged warning plus a cancelled run's files surviving
   * into the next task as its starting point.
   */
  it("creates a repository that can be reset", async () => {
    const { exec, commands } = fakeExec(noRepository);

    const said = await open({ exec });

    const init = commands.find((c) => c.command.includes("git init"));
    expect(init).toBeDefined();
    expect(init!.command).toContain("git commit -q --allow-empty");
    // From outside the scratchpad, since the command's first act is to create it.
    expect(init!.cwd).toBe("/");
    // Through the environment, so a name with a quote in it stays a value.
    expect(init!.env).toEqual({
      GIT_NAME: "da-coder",
      GIT_EMAIL: "coder@dynamicagents.invalid"
    });
    expect(said).toContain(`Opened a new scratchpad at ${DEFAULT_SCRATCH_DIR}`);
    expect(said).toContain("nothing in it is pushed anywhere");
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
    expect(commands.some((c) => c.command.includes("git init"))).toBe(false);
  });

  /**
   * Durable across tasks is the point — a scratchpad that emptied itself would
   * lose the script the user is about to ask about again. So emptying it is
   * something the model asks for, and reopening says what is there rather than
   * letting a brief be written for a tree that is not empty.
   */
  it("reuses what an earlier task left, unless asked to reset", async () => {
    const { exec, commands } = fakeExec((command) =>
      command.startsWith("git status")
        ? { success: true, stdout: "?? primes.mjs\n" }
        : { success: true }
    );

    const said = await open({ exec });

    expect(commands.some((c) => c.command.includes("git clean"))).toBe(false);
    expect(said).toContain("Reopened the scratchpad");
    expect(said).toContain("primes.mjs");
  });

  it("empties it when asked", async () => {
    const { exec, commands } = fakeExec();

    const said = await open({ exec }, { reset: true });

    expect(commands.some((c) => c.command.includes("git clean -fdxq"))).toBe(
      true
    );
    expect(said).toContain("emptied it");
    // Nothing is asked about the tree — this call is what made it empty.
    expect(commands.some((c) => c.command.startsWith("git status"))).toBe(
      false
    );
  });

  it("says what went wrong when the repository cannot be created", async () => {
    const { exec } = fakeExec((command) =>
      command.startsWith("git rev-parse") || command.includes("git init")
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
      return noRepository(command);
    });

    await open({
      exec,
      beforeOpen: () => order.push("selected")
    });

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
    const { exec } = fakeExec(noRepository);

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
    const { exec } = fakeExec(noRepository);

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
    const { exec } = fakeExec(noRepository);

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
    const { exec, commands } = fakeExec(noRepository);

    const said = await open({ exec, dir: "/srv/pad" });

    expect(commands[0]!.cwd).toBe("/srv/pad");
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
