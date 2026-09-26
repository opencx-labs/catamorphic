import { z } from "zod";
import { defineTriggerKind, hole, mcpToolKind } from "./define-trigger-kind.js";

/**
 * Workflows as AI tools (ADR 0042): the whole payload is one hole, so each
 * bound workflow's own input type is the tool's argument schema, frozen per
 * binding at scan time. The project MCP endpoint serves every binding as a
 * tool to project agents and to members' own MCP clients alike.
 */
export const aiToolCall = defineTriggerKind({
  name: "ai.tool-call",
  description:
    "An AI agent calls this workflow as a tool; the workflow input is the tool's argument schema",
  display: { label: "AI Tool", icon: "wrench", color: "#b45309" },
  payload: hole("Args"),
  config: z.strictObject({
    /** The description the model reads when deciding to call the tool. */
    description: z.string().min(1),
    /** Tool name override; defaults to the workflow name. */
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
});

/** Register under `mcpToolKinds` beside {@link aiToolCall} in `triggerKinds`. */
export const aiToolKind = mcpToolKind(aiToolCall, (config) => ({
  description: config.description,
  ...(config.name ? { name: config.name } : {}),
}));
