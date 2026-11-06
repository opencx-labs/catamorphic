import type { Identity } from "@catamorphic/core";
import type { ProjectMcpHostTool } from "@catamorphic/fastify-plugin";
import { z } from "zod";
import { CreateShareSchema, type WorkSharesService } from "./shares-service.js";

/**
 * Shares on the project MCP (ADR 0165, ADR 0166): a member's own agent
 * shares a document, folder, or app with people outside the company, lists
 * the project's shares, and withdraws one. The service enforces
 * `publications:write` / `publications:read`.
 */
export function shareTools(
  shares: WorkSharesService,
  args: { identity: Identity; projectId: string },
): ProjectMcpHostTool[] {
  const { identity, projectId } = args;
  return [
    {
      definition: {
        name: "share_create",
        description:
          "Share a document, a folder, or a published app with people outside the company. They sign in with their own account at the returned url and see only this. App shares name the Environment the app's workflows run in.",
        inputSchema: z.toJSONSchema(CreateShareSchema, { io: "input" }),
      },
      call: async (input) =>
        shares.create({
          identity,
          projectId,
          input: CreateShareSchema.parse(input),
        }),
    },
    {
      definition: {
        name: "shares_list",
        description:
          "The project's shares: what each shares, with whom, until when, and whether it was withdrawn.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      call: async () => ({
        shares: await shares.list({ identity, projectId }),
      }),
    },
    {
      definition: {
        name: "share_revoke",
        description: "Withdraw a share; its link stops working at once.",
        inputSchema: {
          type: "object",
          properties: { shareId: { type: "string" } },
          required: ["shareId"],
        },
      },
      call: async (input) => {
        const shareId = typeof input.shareId === "string" ? input.shareId : "";
        if (!(await shares.revoke({ identity, projectId, shareId })))
          throw new Error("Share not found");
        return { revoked: shareId };
      },
    },
  ];
}
