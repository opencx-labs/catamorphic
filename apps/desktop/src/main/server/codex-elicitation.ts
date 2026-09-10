import type { CodexAgentOpts } from "@catamorphic/codex";
import { parseElicitRequest } from "@catamorphic/mcp";
import { z } from "zod";
import type { WorkspaceBridge } from "../agent-bridge.js";

const appConsent = z.object({
  codex_approval_kind: z.literal("mcp_tool_call"),
  connector_id: z.literal("computer-use"),
  tool_params: z.object({ app: z.string().min(1) }).strict(),
  persist: z.array(z.string()).refine((values) => values.includes("session")),
  riskLevel: z.string(),
});
const emptyForm = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.never()),
  required: z.array(z.never()).optional(),
});
const rememberField = "catamorphic_remember_app";
/** Consent belongs to this native process lifetime, never a profile-wide tool grant. */
export function createCodexElicitation({
  elicit,
}: {
  elicit: WorkspaceBridge["elicit"] | undefined;
}): ReturnType<NonNullable<CodexAgentOpts["mcpElicitationForSession"]>> {
  const allowed = new Set<string>();
  return async (request, signal) => {
    if (signal?.aborted) return { action: "cancel" };
    const parsed = parseElicitRequest(request);
    if (!parsed || !elicit) return { action: "decline" };
    const app = appConsent.safeParse(request._meta);
    const scope =
      app.success &&
      request.mode === "form" &&
      emptyForm.safeParse(request.requestedSchema).success
        ? JSON.stringify([
            request.serverName,
            app.data.tool_params.app,
            app.data.riskLevel,
          ])
        : undefined;
    if (scope && allowed.has(scope)) return { action: "accept", content: {} };
    const result = await elicit(
      request.serverName,
      scope && parsed.mode === "form"
        ? {
            ...parsed,
            fields: [
              {
                name: rememberField,
                type: "boolean",
                title: "Allow this app for this chat",
                description:
                  "Resets when the native session restarts or the chat closes.",
                required: false,
                default: false,
              },
            ],
          }
        : parsed,
      signal,
    );
    if (signal?.aborted) return { action: "cancel" };
    if (scope && result.action === "accept") {
      if (result.content?.[rememberField] === true) allowed.add(scope);
      return { action: "accept", content: {} };
    }
    return result;
  };
}
