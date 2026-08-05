import { describe, it, expect } from "vitest";
import { TEST_MODELS } from "@loopingai/core/testing";
import {
  createAgentRuntime,
  makeWorkspaceHandle,
  memoryWorkspaceBacking,
  WORKSPACE_MAX_FILE_BYTES
} from "@loopingai/core";
import type { ToolFamilyContext } from "@loopingai/core";
import { buildWorkspaceTools, workspace, WORKSPACE_FAMILY } from "./index.js";
import { callNamed as call } from "../../test/helpers.js";

/**
 * The handle and its caps are core's and are tested there. What is this
 * plugin's own is the model-facing surface — what a tool says back when a file
 * is missing, when a write is refused, when the workspace is empty — and the
 * fact that it supplies core's one workspace backend.
 */

const tools = () =>
  buildWorkspaceTools(makeWorkspaceHandle(memoryWorkspaceBacking()));

describe("buildWorkspaceTools", () => {
  it("round-trips a file through write and read", async () => {
    const t = tools();
    expect(
      await call(t, "ws_write", { path: "notes.md", content: "plan A" })
    ).toBe("wrote notes.md");
    expect(await call(t, "ws_read", { path: "notes.md" })).toBe("plan A");
  });

  it("tells the model a file is missing rather than failing the call", async () => {
    // A missing file is an ordinary answer to an ordinary question, not an
    // error. Surfacing it as a tool failure would spend a turn on a retry that
    // cannot succeed.
    expect(await call(tools(), "ws_read", { path: "nope.md" })).toBe(
      "(no file at nope.md)"
    );
  });

  it("reports an empty workspace in words", async () => {
    // `[]` renders as nothing at all, which reads to a model as a broken tool.
    expect(await call(tools(), "ws_list", {})).toBe("(workspace is empty)");
  });

  it("lists files with their sizes", async () => {
    const t = tools();
    await call(t, "ws_write", { path: "a.txt", content: "12345" });
    expect(await call(t, "ws_list", {})).toBe("a.txt (5 bytes)");
  });

  it("returns a refused write to the model instead of throwing", async () => {
    // The model is the only thing that can correct an oversized write, and it
    // can only correct what it is told. The message carries the limit.
    const result = await call(tools(), "ws_write", {
      path: "big.txt",
      content: "a".repeat(WORKSPACE_MAX_FILE_BYTES + 1)
    });
    expect(result).toMatch(/^error writing big\.txt:/);
    expect(result).toContain(String(WORKSPACE_MAX_FILE_BYTES));
  });
});

describe("workspace()", () => {
  it("supplies core's workspace backend", () => {
    // Core declares the shape and enforces the caps but ships no backend, so
    // that an agent which never delegates file work carries no experimental
    // `@cloudflare/shell` dependency.
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [workspace()]
    });
    expect(rt.workspaceBacking).toBeDefined();
    expect(rt.workspaceBacking).not.toBe(memoryWorkspaceBacking);
  });

  it("offers the model-facing tools only to a recipe that asks", async () => {
    // The two halves are independent: every execution gets the durable backing,
    // but only a recipe naming `workspace` puts the tools in front of a model.
    // Two logged ARC plays never called `ws_read` once — a family that reaches
    // the workspace in code does not need the model to have tools for it.
    const plugin = workspace();
    expect(plugin.mainAgentTools).toBeUndefined();

    const built = plugin.toolFamilies![WORKSPACE_FAMILY]({
      workspace: makeWorkspaceHandle(memoryWorkspaceBacking()),
      emitProgress: () => {},
      params: {},
      runtime: {}
    } as ToolFamilyContext);

    expect(Object.keys(built.tools).sort()).toEqual([
      "ws_list",
      "ws_read",
      "ws_write"
    ]);
  });

  it("requires nothing of the host", () => {
    // Shell backs the workspace with the DO's own SQLite, which every DO
    // already has — so unlike every other plugin here, there is no binding to
    // declare in `wrangler.jsonc`.
    expect(workspace().requires).toBeUndefined();
    expect(
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [workspace()],
        env: {}
      }).requirements
    ).toEqual({ secrets: [], bindings: [] });
  });
});
