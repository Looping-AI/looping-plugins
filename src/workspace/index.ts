import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { definePlugin } from "@loopingai/core";
import type {
  AgentPlugin,
  WorkspaceBacking,
  WorkspaceHandle
} from "@loopingai/core";
import { Workspace } from "@cloudflare/shell";

/**
 * `@loopingai/plugins/workspace` — a durable file store for long subagent runs,
 * and the model-facing tools over it.
 *
 * Core already owns the *interface*: `WorkspaceHandle`, `WorkspaceBacking`, the
 * per-file and file-count caps, and `makeWorkspaceHandle` which enforces them.
 * What core deliberately does not own is a **backend**, because the only good
 * one is `@cloudflare/shell` and shell is experimental ("expect breaking
 * changes"). An agent that never delegates file work should not carry that
 * dependency, so it ships here and is an optional peer.
 *
 * This is the only `@cloudflare/shell` import surface in the package — the same
 * discipline the predecessor kept, for the same reason: everything else codes
 * against core's stable wrapper rather than shell's large, churning API.
 *
 * Two halves, and they are independent:
 *
 * - `workspaceBacking` gives every subagent execution a real file store. An
 *   agent that installs this plugin and nothing else still benefits, because the
 *   tool families that persist session state to the workspace now have somewhere
 *   durable to put it.
 * - the `workspace` tool family puts `ws_read`/`ws_write`/`ws_list` in front of
 *   the *model*, so it can keep notes across a context window it will outlive.
 *
 * A recipe opts into the second by naming `workspace` in its `toolFamilies`;
 * the first applies to every execution regardless.
 */

/** This plugin's tool-family name, as a recipe's `toolFamilies` lists it. */
export const WORKSPACE_FAMILY = "workspace";

/**
 * The model-facing workspace tools: read/write/list over the execution's durable
 * file store.
 *
 * Long recipes keep a small rolling context window, so these are how a model
 * persists anything it must remember after older turns scroll out. Exported
 * separately from the plugin so they unit-test without a runtime, and so a host
 * with its own tool assembly can reuse them.
 */
export function buildWorkspaceTools(workspace: WorkspaceHandle): ToolSet {
  return {
    ws_read: tool({
      description:
        "Read a file from your workspace. Returns the file's text, or a note if it does not exist.",
      inputSchema: z.object({
        path: z.string().describe("File path, e.g. 'notes.md'")
      }),
      execute: async ({ path }) => {
        const content = await workspace.read(path);
        return content === null ? `(no file at ${path})` : content;
      }
    }),
    ws_write: tool({
      description:
        "Create or overwrite a workspace file. Use this to persist notes, hypotheses, and plans so you remember them after older turns scroll out of context.",
      inputSchema: z.object({
        path: z.string().describe("File path, e.g. 'notes.md'"),
        content: z
          .string()
          .describe("Full file content (overwrites any existing file)")
      }),
      execute: async ({ path, content }) => {
        // Returned rather than thrown: a write over the size cap is the model's
        // mistake to correct, and it can only correct what it is told. The SDK
        // would surface a throw as a tool error too, but this reads better and
        // keeps the limit itself in the message.
        try {
          await workspace.write(path, content);
          return `wrote ${path}`;
        } catch (err) {
          return `error writing ${path}: ${String(err)}`;
        }
      }
    }),
    ws_list: tool({
      description: "List the files currently in your workspace.",
      inputSchema: z.object({
        dir: z.string().optional().describe("Directory to list (default: root)")
      }),
      execute: async ({ dir }) => {
        const entries = await workspace.list(dir);
        if (entries.length === 0) return "(workspace is empty)";
        return entries
          .map(
            (e) =>
              `${e.path}${e.type === "directory" ? "/" : ""} (${e.size} bytes)`
          )
          .join("\n");
      }
    })
  };
}

/**
 * Build a shell {@link Workspace} over a Durable Object's SQLite storage.
 *
 * The executing facet passes its *own* `ctx.storage.sql`, so per-execution
 * isolation is free and deleting the child wipes the workspace with the rest of
 * its storage. `name` is lazy because a facet's name is set after construction.
 *
 * Exported because a host that assembles its own `SubagentRuntime` by hand may
 * want it directly; the plugin's `workspaceBacking` is this same function.
 */
export function durableWorkspaceBacking(
  sql: SqlStorage,
  name: () => string | undefined
): WorkspaceBacking {
  return new Workspace({ sql, name });
}

export function workspace(): AgentPlugin {
  return definePlugin({
    key: "workspace",

    workspaceBacking: durableWorkspaceBacking,

    toolFamilies: {
      [WORKSPACE_FAMILY]: (ctx) => ({
        tools: buildWorkspaceTools(ctx.workspace)
      })
    }

    // No `requires`: shell backs the workspace with the Durable Object's own
    // SQLite, which every DO already has. Nothing for the host to declare.
  });
}
