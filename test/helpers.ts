import type { Tool, ToolSet } from "ai";

/**
 * Spec helpers shared across plugins.
 *
 * Lives under `test/` rather than `src/` on purpose: it is imported only by
 * specs, and `tsconfig.build.json` excludes this whole directory, so nothing
 * here can reach `dist/` or a consumer's bundle.
 */

/**
 * Run a tool the way the AI SDK would, and return what the model would read.
 *
 * `ToolExecutionOptions` carries fields a real call supplies that most specs care
 * nothing about, so they are filled with the minimum that typechecks. A spec about
 * cancellation passes `abortSignal`, which is what the SDK hands `execute` merged
 * with the tool's deadline. The cast is confined here rather than repeated in
 * every spec.
 */
export async function callTool<T = string>(
  tool: Tool,
  input: unknown,
  options: { abortSignal?: AbortSignal } = {}
): Promise<T> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  return (await execute(
    input as never,
    {
      toolCallId: "test-call",
      messages: [],
      context: undefined,
      ...options
    } as never
  )) as T;
}

/** Same, addressed by name — for asserting against a whole family at once. */
export function callNamed<T = string>(
  tools: ToolSet,
  name: string,
  input: unknown,
  options: { abortSignal?: AbortSignal } = {}
): Promise<T> {
  const tool = tools[name];
  if (!tool) throw new Error(`no tool named "${name}"`);
  return callTool<T>(tool, input, options);
}

/**
 * The zod object behind a tool's `inputSchema`.
 *
 * The SDK types it as `FlexibleSchema`, which is deliberately opaque — it may be
 * a zod schema, a JSON schema, or a custom validator. Every tool here builds one
 * with `z.object`, so a spec may look at its shape; this is where that knowledge
 * is asserted rather than assumed in a dozen places.
 */
export function inputShape(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema as unknown as {
    shape?: Record<string, unknown>;
  };
  if (!schema.shape) throw new Error("tool inputSchema is not a zod object");
  return schema.shape;
}

/** Whether a tool's input schema accepts a value — e.g. an empty object. */
export function acceptsInput(tool: Tool, value: unknown): boolean {
  const schema = tool.inputSchema as unknown as {
    safeParse(v: unknown): { success: boolean };
  };
  return schema.safeParse(value).success;
}
