import { useEffect, useMemo, useState } from "react";
import type { AgentCommandsResult } from "../../shared/agent-commands.js";
import { desktopApi } from "./desktop-api.js";

/**
 * The chat agent's own commands and skills, fresh on every opening: Claude
 * Code's commands and plugin skills, Codex's skills, read in the chat's
 * checkout. A late answer for another agent or chat never shows.
 */
export function useAgentCommands({
  projectId,
  agentId,
  sessionId,
  active,
  refresh,
}: {
  projectId: string | undefined;
  agentId: string | undefined;
  sessionId: string | null;
  active: boolean;
  refresh: number;
}): AgentCommandsResult & { loading: boolean } {
  const request = useMemo(
    () => ({ projectId, agentId, sessionId, active, refresh }),
    [projectId, agentId, sessionId, active, refresh],
  );
  const [catalog, setCatalog] = useState<
    AgentCommandsResult & { request?: typeof request; loading: boolean }
  >({ commands: [], loading: true });
  useEffect(() => {
    if (!request.active || !request.projectId || !request.agentId) return;
    let cancelled = false;
    setCatalog({ request, commands: [], loading: true });
    void desktopApi
      .agentCommands({
        projectId: request.projectId,
        agentId: request.agentId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      })
      .then((result) => {
        if (!cancelled) setCatalog({ ...result, request, loading: false });
      })
      .catch(() => {
        if (!cancelled)
          setCatalog({
            request,
            commands: [],
            loading: false,
            error: "Could not load the agent's commands.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);
  // One empty list, so rows built from it keep their identity per render.
  if (!projectId || !agentId) return { commands: NO_COMMANDS, loading: false };
  return catalog.request === request
    ? catalog
    : { commands: NO_COMMANDS, loading: active };
}
const NO_COMMANDS: AgentCommandsResult["commands"] = [];
