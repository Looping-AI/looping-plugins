import { describe, it, expect } from "vitest";
import { createAgentRuntime, PLUGIN_CONTRACT_VERSION } from "@loopingai/core";
import type { SessionLike } from "@loopingai/core/agent";
import { browser, BROWSER_FAMILY } from "./index.js";
import type { QuickActionBinding } from "agents/browser";

/**
 * The tools themselves are the Agents SDK's, and testing them here would be
 * testing someone else's package. What is this plugin's own is the *wiring*:
 * that the binding is closed over rather than model input, that both surfaces
 * are offered, and that a missing binding fails at startup instead of inside a
 * request.
 */

/** Enough of the binding to build tools against; nothing here ever calls it. */
const fakeBinding = {} as QuickActionBinding;

const toolCtx = { session: {} as SessionLike };

describe("browser()", () => {
  it("offers its tools to the main agent and as a recipe tool family", async () => {
    // Both, deliberately. A main agent reads a page to answer directly; a
    // delegated research subtask reads a dozen. Same tools, different holder.
    const plugin = browser({ binding: fakeBinding });

    const mainTools = Object.keys(await plugin.mainAgentTools!(toolCtx));
    expect(mainTools).toContain("browser_markdown");

    const family = plugin.toolFamilies![BROWSER_FAMILY];
    expect(family).toBeDefined();
    const familyTools = Object.keys(
      family({
        workspace: {} as never,
        emitProgress: () => {},
        params: {},
        runtime: {}
      }).tools
    );
    expect(familyTools).toEqual(mainTools);
  });

  it("exposes the text-returning set and keeps raw HTML opt-in", async () => {
    // `content` is large and rarely what a model wants, so it is not in the
    // default set — a page of raw HTML can cost a small model its whole context.
    const plugin = browser({ binding: fakeBinding });
    const names = Object.keys(await plugin.mainAgentTools!(toolCtx));

    expect(names.sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
  });

  it("narrows to the actions the host asked for", async () => {
    const plugin = browser({ binding: fakeBinding, actions: ["markdown"] });
    expect(Object.keys(await plugin.mainAgentTools!(toolCtx))).toEqual([
      "browser_markdown"
    ]);
  });

  it("takes no binding from the model — only from config", async () => {
    // The whole reason config-at-instantiation exists. Every tool's input schema
    // must describe a page and nothing else; a schema naming a binding, an
    // account, or a header would be one the model could fill in.
    const plugin = browser({ binding: fakeBinding });
    const tools = await plugin.mainAgentTools!(toolCtx);

    for (const [name, tool] of Object.entries(tools)) {
      const keys = Object.keys(
        (tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {}
      );
      expect(keys, `${name} input`).not.toContain("browser");
      expect(keys, `${name} input`).not.toContain("binding");
    }
  });

  it("declares the binding it cannot add for itself", () => {
    expect(browser({ binding: fakeBinding }).requires).toEqual({
      bindings: ["BROWSER"]
    });
  });

  it("fails at startup when the host never declared BROWSER", () => {
    // The point of `requires`. Without it the first tool call fails instead —
    // inside a request a user is waiting on, several layers from the cause.
    expect(() =>
      createAgentRuntime({
        plugins: [browser({ binding: fakeBinding })],
        env: {}
      })
    ).toThrow(/BROWSER.*browser|browser.*BROWSER/s);
  });

  it("registers against the contract version it compiled against", () => {
    // Never a literal — the point is that it moves with the core the plugin was
    // built against, so a version train that leaves one repo behind says so.
    expect(browser({ binding: fakeBinding }).contractVersion).toBe(
      PLUGIN_CONTRACT_VERSION
    );
  });
});
