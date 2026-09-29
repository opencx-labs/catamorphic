import { useQuery } from "@tanstack/react-query";
import type { AgentDefaultModel } from "../../shared/agent-default-model.js";
import { type AgentInfo, desktopApi } from "./desktop-api.js";

type Agent = Pick<AgentInfo, "id" | "harness" | "provider">;

/**
 * The model the agent's harness runs in this project when nothing pins one,
 * asked of the harness itself (main spawns its CLI, so only enable this
 * while the answer is needed and unknown). Keyed by session too: a
 * session's checkout can carry its own project settings.
 */
export function useAgentDefaultModel({
  projectId,
  agent,
  sessionId,
  enabled,
}: {
  projectId: string | undefined;
  agent: Agent | undefined;
  sessionId?: string | null;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [
      "desktop",
      "agent-default-model",
      projectId,
      agent?.id,
      sessionId ?? null,
    ],
    queryFn: () =>
      projectId && agent
        ? desktopApi.agentDefaultModel({
            projectId,
            agentId: agent.id,
            ...(sessionId ? { sessionId } : {}),
          })
        : Promise.resolve({ model: null }),
    enabled: enabled && Boolean(projectId && agent),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Whether two model ids name the same model. Settings ids can carry a
 * context-window suffix ("claude-opus-5[1m]") that usage reports omit.
 */
export function sameModel(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const base = (id: string) => id.replace(/\[[^\]]*\]$/, "");
  return Boolean(a && b && base(a) === base(b));
}

/**
 * The model a chat runs, by the id the harness sends: an alias resolves
 * through the harness's catalog ("opus[1m]" → "claude-opus-5[1m]"). A
 * family name alone ("Opus") does not say which Opus.
 */
export function modelId(
  id: string,
  catalog: readonly { id: string; resolvedId?: string }[] | undefined,
): string {
  const resolved = catalog?.find((model) => model.id === id)?.resolvedId;
  // An id that already names the model keeps its context-window suffix,
  // which the catalog's resolution can drop.
  return resolved && !sameModel(id, resolved) ? resolved : id;
}

/**
 * How to name an unpinned model: the id the harness said it will send,
 * otherwise who decides ("Claude Code default"), never a vague "Automatic".
 */
export function defaultModelLabel(
  agent: Agent | undefined,
  model: AgentDefaultModel | null | undefined,
): string {
  if (model) return model.id;
  if (agent?.harness === "claude-code") return "Claude Code default";
  if (agent?.harness === "codex") return "Codex default";
  if (agent?.harness === "ai-sdk" && agent.provider === "openrouter")
    return "Best free model";
  return "Agent default";
}
