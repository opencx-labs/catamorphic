import { z } from "zod";

const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  }),
]);
const resultSchema = z.object({
  kind: z.literal("agent-tool-result"),
  content: z.array(contentSchema),
  isError: z.boolean().optional(),
});

/** Explicit media result; ordinary domain objects are never interpreted as MCP. */
export type AgentToolResult = z.infer<typeof resultSchema>;

export function agentToolResult(
  result: Omit<AgentToolResult, "kind">,
): AgentToolResult {
  return resultSchema.parse({ kind: "agent-tool-result", ...result });
}

/** Shared translation for every harness's host tools. */
export function extraToolResult(
  result: unknown,
): Omit<AgentToolResult, "kind"> {
  if (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "agent-tool-result"
  ) {
    const { content, isError } = resultSchema.parse(result);
    return { content, ...(isError === undefined ? {} : { isError }) };
  }
  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string"
            ? result
            : (JSON.stringify(result, null, 2) ?? String(result)),
      },
    ],
  };
}
