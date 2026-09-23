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
 * How to name an unpinned model: the harness's own answer when it gave one,
 * otherwise who decides ("Claude Code default"), never a vague "Automatic".
 */
export function defaultModelLabel(
  agent: Agent | undefined,
  model: AgentDefaultModel | null | undefined,
): string {
  if (model) return model.name ?? model.id;
  if (agent?.harness === "claude-code") return "Claude Code default";
  if (agent?.harness === "codex") return "Codex default";
  if (agent?.harness === "ai-sdk" && agent.provider === "openrouter")
    return "Best free model";
  return "Agent default";
}
