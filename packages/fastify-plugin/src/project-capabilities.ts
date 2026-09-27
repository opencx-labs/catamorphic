import {
  type AgentCapability,
  type AgentCapabilityContext,
  type AgentCapabilityInvocation,
  type CatamorphicCore,
  defineAgentCapability,
} from "@catamorphic/core";
import { z } from "zod";
import { callPollRunTool, POLL_RUN_TOOL_DEFINITION } from "./mcp-shared.js";
import { type SurfaceFeatures, surfaceTools } from "./project-mcp-surface.js";
import {
  callTool,
  loadProjectTools,
  toolDefinition,
} from "./routes/project-mcp.js";

/**
 * Project tools that make something live for everyone (ADR 0182): only an
 * agent whose sandboxing is `publish` may call them. Output shown in the
 * agent's own chat suits any sandboxing.
 */
const PUBLISHING_TOOLS = new Set([
  "program_deploy",
  "publish_document",
  "revoke_publication",
]);
const OWN_CHAT_TOOLS = new Set(["session_artifact", "set_app_presentation"]);

const Definition = z.object({
  name: z.string(),
  description: z.string().default(""),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
});

/** Internal projection of the public project tools. Both call the same services. */
export async function projectToolCapabilities(args: {
  core: CatamorphicCore;
  context: AgentCapabilityContext;
  features?: SurfaceFeatures;
  /** Host execution version, composed with the project tool definition. */
  revision?: string;
  consent?: (tool: {
    name: string;
    effect: "read" | "write";
  }) => string | undefined;
  allow?: (tool: { name: string; effect: "read" | "write" }) => boolean;
  beforeCall?: (tool: {
    name: string;
    effect: "read" | "write";
    input: unknown;
    invocation: AgentCapabilityInvocation;
  }) => Promise<void>;
}): Promise<AgentCapability[]> {
  const { core, context } = args;
  const workflows = await loadProjectTools(
    core,
    context.identity,
    context.projectId,
  );
  const targets = new Map(workflows.map((tool) => [tool.name, tool.binding]));
  const taken = new Set(targets.keys());
  const tools = [
    ...surfaceTools(
      core,
      context.identity,
      context.projectId,
      args.features,
      context.sessionId,
    ).filter((tool) => !taken.has(String(tool.definition.name))),
    ...workflows.map((tool) => ({
      definition: toolDefinition(tool),
      call: (input: Record<string, unknown>) =>
        callTool(core, context.identity, context.projectId, tool.name, input),
    })),
    {
      definition: POLL_RUN_TOOL_DEFINITION,
      call: (input: Record<string, unknown>) =>
        callPollRunTool(core, context.identity, input),
    },
  ];
  return tools.flatMap((tool) => {
    const definition = Definition.parse(tool.definition);
    const effect = definition.annotations?.readOnlyHint ? "read" : "write";
    if (args.allow && !args.allow({ name: definition.name, effect })) return [];
    return [
      defineAgentCapability({
        revision: JSON.stringify([
          args.revision,
          tool.definition,
          targets.get(definition.name),
        ]),
        consent: args.consent?.({ name: definition.name, effect }),
        name: `project.${definition.name}`,
        description: definition.description,
        effect,
        ...(PUBLISHING_TOOLS.has(definition.name)
          ? { sandboxing: "publish" as const }
          : OWN_CHAT_TOOLS.has(definition.name)
            ? { sandboxing: "contained" as const }
            : {}),
        inputSchema: z.fromJSONSchema(definition.inputSchema),
        outputSchema: z.unknown(),
        authorize: () => true,
        beforeInvoke: (invocation, input) =>
          args.beforeCall?.({
            name: definition.name,
            effect,
            input,
            invocation,
          }) ?? Promise.resolve(),
        execute: async (invocation, input) => {
          invocation.signal?.throwIfAborted();
          const values = z.record(z.string(), z.unknown()).parse(input);
          // These are session-owned operations. The invocation, not model input,
          // chooses their author/owner, including after a cached schema is reused.
          const owned =
            !taken.has(definition.name) &&
            [
              "session_artifact",
              "create_watcher",
              "list_watchers",
              "stop_watcher",
            ].includes(definition.name);
          const result = await tool.call(
            owned ? { ...values, sessionId: context.sessionId } : values,
          );
          if (result.isError) {
            const content = z
              .array(z.object({ text: z.string() }))
              .parse(result.content);
            throw new Error(content.map((part) => part.text).join("\n"));
          }
          if (result.structuredContent !== undefined)
            return JSON.parse(JSON.stringify(result.structuredContent));
          const content = z
            .array(z.object({ text: z.string() }))
            .parse(result.content);
          const text = content.map((part) => part.text).join("\n");
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        },
      }),
    ];
  });
}
