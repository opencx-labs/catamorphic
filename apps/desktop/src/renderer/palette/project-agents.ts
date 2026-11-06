import { useEffect, useState } from "react";
import { desktopApi, type ProjectAgentInfo } from "../lib/desktop-api.js";

/**
 * The active project's committed agent definitions (ADR 0050), fetched on
 * every refresh beat (an opening, a new query, entering a picker):
 * definitions are files a collaborator or an agent may have just written,
 * and consent changes with approvals, so a stale snapshot shows wrong rows.
 */
export function useProjectAgents({
  projectId,
  refresh,
}: {
  projectId: string | undefined;
  refresh: string;
}): ProjectAgentInfo[] {
  const [agents, setAgents] = useState<ProjectAgentInfo[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the refetch beat
  useEffect(() => {
    if (!projectId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    void desktopApi
      .projectAgentsList(projectId)
      .then((data) => {
        if (!cancelled) setAgents(data.agents);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh]);
  return agents;
}
