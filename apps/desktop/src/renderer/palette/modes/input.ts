import { useQuery } from "@tanstack/react-query";
import { Bot, Search } from "lucide-react";
import { createElement, useCallback, useMemo } from "react";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { HarnessIcon } from "../../components/harness-icon.js";
import {
  defaultModelLabel,
  modelLabel,
  useAgentDefaultModel,
} from "../../lib/agent-default-model.js";
import { effectiveEffort } from "../../lib/agent-effort.js";
import {
  desktopApi,
  type ProjectAgentInfo,
  projectAgentAsInfo,
} from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/** Modes that send the whole input somewhere: the agent or the web. */
export function useInputModes({
  projectAgents,
  agentModeActive,
}: {
  projectAgents: readonly ProjectAgentInfo[];
  agentModeActive: boolean;
}): PaletteMode[] {
  const { projectId, onOpenUrl, onSendToAgent, agents, defaultAgentId } =
    usePaletteHost();
  const agent = useMemo(
    () =>
      [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
        (candidate) => candidate.id === defaultAgentId,
      ),
    [agents, projectAgents, defaultAgentId],
  );
  const catalog = useQuery({
    queryKey: ["desktop", "agent-models", agent?.id],
    queryFn: () =>
      agent
        ? desktopApi.agentModels(agent.id)
        : Promise.resolve({ models: [] }),
    enabled: agentModeActive && Boolean(agent),
    staleTime: 600_000,
  });
  const harnessDefault = useAgentDefaultModel({
    projectId,
    agent,
    enabled: agentModeActive && Boolean(agent && !agent.model),
  });
  const modelId = agent?.model || harnessDefault.data?.model?.id;
  const model = catalog.data?.models.find(
    (candidate) => candidate.id === modelId || candidate.resolvedId === modelId,
  );
  const modelName = model
    ? modelLabel(model, catalog.data?.models).title
    : agent?.model ||
      harnessDefault.data?.model?.name ||
      defaultModelLabel(agent, harnessDefault.data?.model);
  const detail = agent
    ? [agent.name, modelName, effectiveEffort(agent, agent.effort, model)]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  // One row that sends the whole input somewhere: the agent or the web.
  const inputRows = useCallback(
    (target: "agent" | "web", query: string): PaletteItem[] => {
      const typed = query.trim();
      if (target === "agent")
        return [
          {
            id: "mode:agent",
            icon: Bot,
            iconNode: createElement(HarnessIcon, {
              harness: agent?.harness,
              provider: agent?.provider,
              className: "size-4 text-fg-faint",
            }),
            label: "Ask agent",
            detail: detail ?? (typed ? undefined : "Type a message"),
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
          url: typed
            ? `https://www.google.com/search?q=${encodeURIComponent(typed)}`
            : undefined,
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
    [agent, detail, onSendToAgent, onOpenUrl],
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
