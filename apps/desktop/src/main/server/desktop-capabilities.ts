import {
  type AgentCapability,
  type AgentCapabilityContext,
  type AgentCapabilityInvocation,
  type AgentCapabilitySource,
  type CatamorphicCore,
  defineAgentCapability,
} from "@catamorphic/core";
import { projectToolCapabilities } from "@catamorphic/fastify-plugin";
import type { McpToolInfo } from "@catamorphic/mcp";
import {
  agentToolResult,
  resolveToolPermissionAcross,
  ToolGate,
  type ToolPolicyAnnotations,
} from "@catamorphic/sandbox";
import { z } from "zod";
import type { McpAppsService } from "../mcp-apps.js";
import type { DesktopAgentRegistry } from "./agent-registry.js";

/** Desktop, project and connection operations enter core's single live registry. */
export function desktopCapabilitySource(deps: {
  core(): CatamorphicCore;
  agents: DesktopAgentRegistry;
  mcpApps?: McpAppsService;
  workingDirectory(
    context: AgentCapabilityContext,
  ): Promise<string | undefined>;
}): AgentCapabilitySource {
  return async (context, selection) => {
    const core = deps.core();
    const session = await core.agentSessions?.toolContextForSession(context);
    const agentId =
      session?.agentId ?? deps.agents.defaultAgentId(context.projectId);
    const surface = agentId
      ? deps.agents.capabilitySurface(agentId)
      : undefined;
    if (!surface) return [];
    const callerPolicies = session?.toolPolicies;
    const revision = JSON.stringify([
      surface.revision,
      surface.mcp.connectionIds,
    ]);
    const layers = (server: string) => {
      const values = [
        ...(surface.mcp.policies[server] ?? []),
        ...(callerPolicies?.[server] ?? []),
      ];
      return values.length ? values : undefined;
    };
    const allowed = (
      server: string,
      name: string,
      annotations?: ToolPolicyAnnotations,
    ) =>
      resolveToolPermissionAcross(layers(server), name, annotations) !== "deny";
    const consent = (
      server: string,
      name: string,
      annotations?: ToolPolicyAnnotations,
    ) =>
      resolveToolPermissionAcross(layers(server), name, annotations) === "ask"
        ? JSON.stringify([layers(server), annotations])
        : undefined;
    const approve = async (args: {
      server: string;
      name: string;
      input: unknown;
      invocation: AgentCapabilityInvocation;
      annotations?: ToolPolicyAnnotations;
    }) => {
      const verdict = await new ToolGate(surface.ask).decide({
        server: args.server,
        tool: args.name,
        input: z.record(z.string(), z.unknown()).parse(args.input),
        sessionId: context.sessionId,
        layers: layers(args.server),
        annotations: args.annotations,
        abortSignal: args.invocation.signal,
      });
      if (!verdict.allowed) throw new Error(verdict.message);
    };
    const capabilities: AgentCapability[] = [];
    if (!selection.name || selection.name.startsWith("workspace.")) {
      for (const tool of surface.tools.filter((tool) => !tool.eager)) {
        capabilities.push(
          defineAgentCapability({
            revision,
            name: `workspace.${tool.name}`,
            description: tool.description,
            effect: tool.effect,
            inputSchema: z.object(
              z
                .record(z.string(), z.instanceof(z.ZodType))
                .parse(tool.parameters),
            ),
            outputSchema: z.unknown(),
            authorize: () => true,
            execute: async (_invocation, input) => {
              const value = await tool.execute(input, {
                projectId: context.projectId,
                sessionId: context.sessionId,
                caller: context.identity,
                workingDirectory: await deps.workingDirectory(context),
              });
              return JSON.parse(JSON.stringify(value ?? null));
            },
          }),
        );
      }
    }
    if (!selection.name || selection.name.startsWith("project.")) {
      capabilities.push(
        ...(await projectToolCapabilities({
          core,
          context,
          revision,
          consent: ({ name, effect }) =>
            consent("catamorphic", name, { readOnlyHint: effect === "read" }),
          allow: ({ name, effect }) =>
            !["list_skills", "read_skill", "send_agent_message"].includes(
              name,
            ) &&
            (!surface.readOnly || effect === "read") &&
            allowed("catamorphic", name, { readOnlyHint: effect === "read" }),
          beforeCall: ({ name, effect, input, invocation }) =>
            approve({
              server: "catamorphic",
              name,
              input,
              invocation,
              annotations: { readOnlyHint: effect === "read" },
            }),
        })),
      );
    }
    const mcpApps = deps.mcpApps;
    if (
      mcpApps &&
      (!selection.name || selection.name.startsWith("connections."))
    ) {
      for (const [server, connectionId] of Object.entries(
        surface.mcp.connectionIds,
      )) {
        const catalogName = `connections.${server}`;
        const prefix = `${catalogName}.`;
        if (
          selection.name &&
          selection.name !== catalogName &&
          !selection.name.startsWith(prefix)
        )
          continue;
        const make = (tool: McpToolInfo): AgentCapability =>
          defineAgentCapability({
            revision: JSON.stringify([revision, connectionId, tool]),
            consent: consent(server, tool.name, tool.annotations),
            name: `${prefix}${encodeURIComponent(tool.name)}`,
            description: `${server}: ${tool.description}`,
            effect: tool.annotations?.readOnlyHint ? "read" : "write",
            inputSchema: z.fromJSONSchema(tool.inputSchema),
            outputSchema: z.unknown(),
            authorize: () =>
              (!surface.readOnly || tool.annotations?.readOnlyHint === true) &&
              allowed(server, tool.name, tool.annotations),
            beforeInvoke: (invocation, input) =>
              approve({
                server,
                name: tool.name,
                input,
                invocation,
                annotations: tool.annotations,
              }),
            execute: async (invocation, input) => {
              invocation.signal?.throwIfAborted();
              const raw = await mcpApps.callTool(
                surface.profileId,
                `${server}/${tool.name}`,
                tool.name,
                z.record(z.string(), z.unknown()).parse(input),
              );
              if (raw.isError) throw new Error(JSON.stringify(raw.content));
              // Preserve image content and structured app output together. Other
              // resource blocks remain readable data rather than failing a union.
              const blocks = z.array(z.unknown()).parse(raw.content ?? []);
              const imageBlock = z.object({
                type: z.literal("image"),
                data: z.string(),
                mimeType: z.enum([
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "image/gif",
                ]),
              });
              const textBlock = z.object({
                type: z.literal("text"),
                text: z.string(),
              });
              const images = blocks.flatMap((block) => {
                const parsed = imageBlock.safeParse(block);
                return parsed.success ? [parsed.data] : [];
              });
              if (images.length) {
                const text = blocks.flatMap((block) => {
                  if (imageBlock.safeParse(block).success) return [];
                  const parsed = textBlock.safeParse(block);
                  return [
                    {
                      type: "text" as const,
                      text: parsed.success
                        ? parsed.data.text
                        : JSON.stringify(block),
                    },
                  ];
                });
                if (raw.structuredContent !== undefined)
                  text.push({
                    type: "text",
                    text: JSON.stringify(raw.structuredContent),
                  });
                return agentToolResult({ content: [...text, ...images] });
              }
              return raw.structuredContent ?? raw;
            },
          });
        const load = async () =>
          (await mcpApps.tools(surface.profileId, server)).filter(
            (tool) =>
              allowed(server, tool.name, tool.annotations) &&
              (!surface.readOnly || tool.annotations?.readOnlyHint === true),
          );
        // An empty/global discovery never connects every installed service.
        // Service-specific discovery (or a previously discovered invocation) loads its roster.
        const specific = selection.name
          ? selection.name !== catalogName
          : selection.query
              ?.toLowerCase()
              .split(/\s+/)
              .some(
                (word) =>
                  word.length > 2 && server.toLowerCase().includes(word),
              );
        if (specific) capabilities.push(...(await load()).map(make));
        capabilities.push(
          defineAgentCapability({
            revision,
            name: catalogName,
            description: `List permitted tools and schemas for the ${server} connection. Search by topic before calling one.`,
            effect: "read",
            inputSchema: z.object({
              query: z.string().default(""),
              cursor: z.string().optional(),
              limit: z.number().int().min(1).max(20).default(10),
            }),
            outputSchema: z.unknown(),
            authorize: () => Boolean(connectionId),
            execute: async (_invocation, input) => {
              const matches = (await load())
                .filter(
                  (tool) =>
                    (!input.cursor || tool.name > input.cursor) &&
                    `${tool.name} ${tool.description}`
                      .toLowerCase()
                      .includes(input.query.toLowerCase()),
                )
                .sort((a, b) =>
                  a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
                );
              return {
                items: matches.slice(0, input.limit).map((tool) => ({
                  name: make(tool).name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
                ...(matches.length > input.limit
                  ? { nextCursor: matches[input.limit - 1]?.name }
                  : {}),
              };
            },
          }),
        );
      }
    }
    return capabilities;
  };
}
