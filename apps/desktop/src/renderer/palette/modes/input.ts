import { Bot, Search } from "lucide-react";
import { useCallback, useMemo } from "react";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import {
  type ProjectAgentInfo,
  projectAgentAsInfo,
} from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** Modes that send the whole input somewhere: the agent or the web. */
export function useInputModes({
  projectAgents,
}: {
  projectAgents: readonly ProjectAgentInfo[];
}): PaletteMode[] {
  const { projectId, onOpenUrl, onSendToAgent, agents, defaultAgentId } =
    usePaletteHost();
  // One row that sends the whole input somewhere: the agent or the web.
  const inputRows = useCallback(
    (target: "agent" | "web", query: string): PaletteItem[] => {
      const typed = query.trim();
      if (target === "agent")
        return [
          {
            id: "mode:agent",
            icon: Bot,
            label: "Ask agent",
            detail:
              [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
                (agent) => agent.id === defaultAgentId,
              )?.name ?? (typed ? undefined : "Type a message"),
            keywords: [],
            kind: "navigate",
            ...(typed ? {} : { commit: "stay" as const }),
            run: (commitMode) => {
              if (typed)
                onSendToAgent(query, commitMode === "tab" ? "tab" : "float");
            },
          },
        ];
      return [
        {
          id: "mode:web",
          icon: Search,
          label: typed ? `Search the web for "${typed}"` : "Search the web",
          detail: typed ? "Google Search" : "Type a query",
          keywords: [],
          kind: "navigate",
          ...(typed ? {} : { commit: "stay" as const }),
          run: (commitMode) => {
            if (typed)
              onOpenUrl(
                `https://www.google.com/search?q=${encodeURIComponent(typed)}`,
                commitMode,
              );
          },
        },
      ];
    },
    [agents, projectAgents, defaultAgentId, onSendToAgent, onOpenUrl],
  );

  return useMemo(
    () => [
      {
        id: "agent",
        chip: "Ask agent",
        icon: Bot,
        label: "Ask the agent",
        description: "Send everything you type to a new chat",
        placeholder: "Message the agent…",
        names: projectId ? BUILTIN_PALETTE_TRIGGERS.agent : undefined,
        rows: { kind: "compute", rows: (typed) => inputRows("agent", typed) },
      },
      {
        id: "web",
        chip: "Search web",
        icon: Search,
        label: "Search the web",
        description: "Google search in a browser tab",
        placeholder: "Search the web…",
        names: BUILTIN_PALETTE_TRIGGERS.web,
        rows: { kind: "compute", rows: (typed) => inputRows("web", typed) },
      },
    ],
    [projectId, inputRows],
  );
}
