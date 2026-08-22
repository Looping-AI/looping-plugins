import { describe, expect, it } from "vitest";
import { claudeCode, claudeCodeSession } from "./index.js";
import { CLAUDE_CODE_TYPE, WORKSPACE_RUNTIME_KEY } from "./recipe.js";
// The one cross-realm import in this folder, and it exists to hold two
// declarations of the same string together — see the assertion below.
import { WORKSPACE_RUNTIME_KEY as COMPUTER_KEY } from "../computer/index.js";
import type { CredentialState, CredentialStore } from "./credentials.js";

const CREDENTIAL = "sk-ant-oat01-REAL";

function memoryStore(): CredentialStore {
  let states: CredentialState[] = [];
  return {
    read: async () => states,
    write: async (next) => {
      states = next;
    }
  };
}

const config = (over: Partial<Parameters<typeof claudeCode>[0]> = {}) => ({
  credentials: () => [CREDENTIAL],
  workspaceName: () => "caller|acme/api",
  ...over
});

/** The shape core passes; only `type` is read here. */
const context = {
  taskId: "task-1",
  subtaskId: 3,
  type: CLAUDE_CODE_TYPE,
  params: {},
  toolFamilies: [] as readonly string[]
};

/**
 * The hook this plugin exists to have, and the reason 0.5.0 was unusable by its
 * own reference host.
 *
 * Core dispatches `resolveRuntime` to the plugin that **declared** the subtask
 * type. `claude-code` is declared here, so if this plugin does not carry the
 * hook, nothing else can: a facet receives `{}`, and has no way to address the
 * Durable Object holding the checkout it was told to work in.
 */
describe("resolveRuntime", () => {
  it("hands the subtask the workspace its parent resolved", async () => {
    const plugin = claudeCode(config());
    await expect(plugin.resolveRuntime?.(context)).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|acme/api"
    });
  });

  /**
   * Called per subtask rather than captured once, because the parent's active
   * repository changes mid-task: `repo_clone` picks it, and the workspace name
   * is derived from it. A memoised thunk would send every later subtask to the
   * first repository's container.
   */
  it("reads the thunk each time, so a repository switch is picked up", async () => {
    let repo = "acme/api";
    const plugin = claudeCode(
      config({ workspaceName: () => `caller|${repo}` })
    );

    await plugin.resolveRuntime?.(context);
    repo = "acme/cli";

    await expect(plugin.resolveRuntime?.(context)).resolves.toEqual({
      [WORKSPACE_RUNTIME_KEY]: "caller|acme/cli"
    });
  });

  /**
   * `WORKSPACE_RUNTIME_KEY` is declared twice on purpose — importing
   * `/computer`'s copy from `/claude-code` would merge two realms
   * `verify:exports` keeps apart, and drag the whole computer plugin into the
   * graph of every agent that installs this one, for one string.
   *
   * They have to stay equal, because a host that installs both on its subagent
   * gets them working off a single runtime value. A spec is the one place a
   * cross-realm import costs nothing, so the drift is caught here.
   */
  it("writes under the same key `/computer` reads", () => {
    expect(WORKSPACE_RUNTIME_KEY).toBe(COMPUTER_KEY);
  });
});

/**
 * Fail at Durable Object start, with a sentence naming this plugin — not at the
 * first model call, inside a subtask somebody is already waiting on.
 *
 * This replaced `requires: { secrets: [...] }`, which named
 * `CLAUDE_CODE_OAUTH_TOKEN` back when there was one credential with a name this
 * package could know. Pool entries are host-named, so there is no name left to
 * declare — and checking the value is stronger than checking that a name is set.
 */
describe("construction", () => {
  it("refuses a pool with no credentials in it", () => {
    expect(() => claudeCode(config({ credentials: () => [] }))).toThrow(
      /no credentials/
    );
  });

  it("refuses a pool of empty strings", () => {
    // `[env.TOKEN_1, env.TOKEN_2]` with neither secret set. The array is not
    // empty, and every entry in it is useless.
    expect(() => claudeCode(config({ credentials: () => ["", ""] }))).toThrow(
      /no credentials/
    );
  });

  it("accepts a single credential, which is the ordinary deployment", () => {
    expect(() => claudeCode(config())).not.toThrow();
  });

  /**
   * A plugin that declares a subtask type puts its capability block on the
   * *type*. Declaring both makes the main agent read the same advice twice per
   * round — the exact failure the type's own prompt fields were introduced to
   * end.
   */
  it("declares one subtask type, no tool families and no capability", () => {
    const plugin = claudeCode(config());
    expect(plugin.subtaskType?.key).toBe(CLAUDE_CODE_TYPE);
    expect(plugin.subtaskType?.recipe.toolFamilies).toEqual([]);
    expect(plugin.toolFamilies).toBeUndefined();
    expect(plugin.capability).toBeUndefined();
  });
});

describe("the session's egress", () => {
  /**
   * `store` is an argument rather than a config field because the pool's state
   * belongs to whichever object has storage. The same config is also held by the
   * parent's plugin list and by the subagent facet, and neither has any — making
   * it a field would force both of them to invent one.
   */
  it("takes the store at the point storage actually exists", () => {
    const session = claudeCodeSession(config());
    expect(typeof session.egress(memoryStore()).fetch).toBe("function");
  });
});
