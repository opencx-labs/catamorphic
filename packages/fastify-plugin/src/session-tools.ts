import type { SessionMessageAuthor } from "@catamorphic/agent-protocol";
import {
  type CatamorphicCore,
  type Identity,
  SESSION_OPERATION_NAMES,
  SESSION_OPERATIONS,
  type SessionOperationName,
  sessionOperationError,
} from "@catamorphic/core";
import { z } from "zod";
import type { McpTool, McpToolResult } from "./mcp-server.js";

export type { McpTool, McpToolResult } from "./mcp-server.js";

/**
 * The session operations as MCP tools (ADR 0346): every entry of core's
 * registry becomes one tool, with the registry's name, title, description,
 * schemas and annotations. Nothing here knows an operation by name, so a
 * tool added to the registry is served by both MCP endpoints and offered
 * to in-product agents at once.
 */

/** The URI a chat is read and subscribed to at. */
export function sessionResourceUri(sessionId: string): string {
  return `work://sessions/${sessionId}`;
}

/** The resource listing the chats that need the caller. */
export const ATTENTION_RESOURCE_URI = "work://attention";

const Linked = z.looseObject({
  sessionId: z.string(),
  title: z.string().nullable().optional(),
});

/**
 * A session operation's value as a tool result: the JSON as text for the
 * model, the same value as `structuredContent` for clients that read the
 * declared `outputSchema`, and a link to the chat's resource.
 */
export function sessionToolResult(value: unknown): McpToolResult {
  const linked = Linked.safeParse(value);
  return {
    content: [
      { type: "text", text: JSON.stringify(value) ?? "null" },
      ...(linked.success
        ? [
            {
              type: "resource_link",
              uri: sessionResourceUri(linked.data.sessionId),
              name: linked.data.title || "Chat",
              mimeType: "application/json",
            },
          ]
        : []),
    ],
    structuredContent: value,
  };
}

/**
 * A failed operation as a tool-execution error (ADR 0346): `isError` with
 * `{"error":{"code","message","retryable","sessionId?"}}` as its text.
 */
export function sessionToolError(error: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(sessionOperationError(error).toJSON()),
      },
    ],
    isError: true,
  };
}

/** Who a session tool acts as: the calling chat's agent, or the member's assistant. */
export async function sessionToolAuthor(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId: string | undefined;
  currentSessionId: string | undefined;
}): Promise<{ author: SessionMessageAuthor; causation: string[] }> {
  const sessions = args.core.agentSessions;
  if (!sessions || !args.currentSessionId || !args.projectId)
    return {
      // Never the person's own words (ADR 0217): their assistant's.
      author: {
        kind: "assistant",
        externalUserId: args.identity.externalUserId,
      },
      causation: [],
    };
  const source = await sessions.get(
    args.identity,
    args.projectId,
    args.currentSessionId,
  );
  return {
    author: { kind: "agent", sessionId: source.id, agentId: source.agentId },
    causation: await sessions.causalContext({
      identity: args.identity,
      projectId: args.projectId,
      sessionId: source.id,
    }),
  };
}

/**
 * The session tools for one caller. `projectId` binds them to a project
 * (its own endpoint); without it they take `project` or follow the chat
 * (the server-wide endpoint). `currentSessionId` is the chat an in-product
 * connection serves: its agent is the author.
 */
export function sessionTools(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId?: string;
  currentSessionId?: string;
}): McpTool[] {
  const operations = args.core.sessionOperations;
  if (!operations) return [];
  return SESSION_OPERATION_NAMES.map((name: SessionOperationName): McpTool => {
    const definition = SESSION_OPERATIONS[name];
    return {
      definition: {
        name,
        title: definition.title,
        description: definition.description,
        inputSchema: z.toJSONSchema(definition.input, { io: "input" }),
        // Compact on purpose: clients hand it to their model (ADR 0347).
        outputSchema: definition.outputSchema,
        annotations: {
          title: definition.title,
          ...definition.annotations,
          openWorldHint: false,
        },
      },
      scope: definition.scope,
      call: async (input, context) => {
        try {
          const origin = await sessionToolAuthor({
            core: args.core,
            identity: args.identity,
            projectId: args.projectId,
            currentSessionId: args.currentSessionId,
          });
          const value = await operations.execute({
            identity: args.identity,
            ...(args.projectId ? { projectId: args.projectId } : {}),
            operation: name,
            args: input,
            ...origin,
            // Only a read stops with its caller: a mutation the caller
            // stopped waiting for still completes, and its retry finds it.
            ...(context?.signal && definition.annotations.readOnlyHint
              ? { signal: context.signal }
              : {}),
          });
          // What clients validate against the declared output schema.
          const shaped = definition.output.safeParse(value);
          return sessionToolResult(shaped.success ? shaped.data : value);
        } catch (error) {
          return sessionToolError(error);
        }
      },
    };
  });
}
