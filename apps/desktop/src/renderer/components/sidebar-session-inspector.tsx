import type { AgentSession } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { effectiveEffort, supportedEfforts } from "../lib/agent-effort.js";
import {
  type AgentInfo,
  desktopApi,
  projectAgentAsInfo,
  type SessionCheckoutInfo,
} from "../lib/desktop-api.js";
import { SessionInspectorContent } from "./session-inspector.js";

export type SessionCommand = "model" | "effort" | "fork" | "parent";

/** Mounted on hover only: the same live details and actions as chat chrome. */
export function SidebarSessionInspector({
  projectId,
  session,
  agent: profileAgent,
  agentName,
  checkout,
  onCommand,
  onArchive,
}: {
  projectId: string;
  session: AgentSession;
  agent?: AgentInfo;
  agentName: string;
  checkout: SessionCheckoutInfo | null;
  onCommand: (command: SessionCommand) => void;
  onArchive: () => void;
}) {
  const projectAgents = useQuery({
    queryKey: ["desktop-project-agents", projectId],
    queryFn: () => desktopApi.projectAgentsList(projectId),
    enabled: !profileAgent,
    staleTime: 30_000,
  });
  const agent =
    profileAgent ??
    projectAgents.data?.agents
      .map(projectAgentAsInfo)
      .find((entry) => entry.id === session.agentId);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligibility = useQuery({
    queryKey: ["session-move", projectId, session.id, session.running],
    queryFn: () => desktopApi.sessionMoveEligibility(projectId, session.id),
    staleTime: 0,
    retry: false,
  });
  const privacy = useQuery({
    queryKey: ["session-incognito", session.id],
    queryFn: () => desktopApi.sessionIsIncognito(session.id),
  });
  const catalog = useQuery({
    queryKey: ["desktop", "agent-models", agent?.id],
    queryFn: () =>
      agent
        ? desktopApi.agentModels(agent.id)
        : Promise.resolve({ models: [] }),
    enabled: !!agent,
    staleTime: 600_000,
  });
  const model = session.model || agent?.model || "Automatic";
  const effortModel = catalog.data?.models.find(
    (entry) => entry.id === model || entry.resolvedId === model,
  );
  const reason = session.running
    ? "Wait for the current work to finish"
    : eligibility.isPending
      ? "Checking the linked server"
      : eligibility.error
        ? "Could not check the linked server"
        : eligibility.data?.canMove
          ? null
          : (eligibility.data?.reason ?? "Session cannot move to a server");
  return (
    <>
      <SessionInspectorContent
        session={session}
        fallbackTitle="Chat"
        agentName={agentName}
        checkout={checkout}
        incognito={privacy.data ?? false}
        model={model}
        effort={
          effectiveEffort(
            agent,
            session.modelEffort ?? agent?.effort,
            effortModel,
          ) ?? "Default"
        }
        onEditModel={
          !session.running && agent ? () => onCommand("model") : undefined
        }
        onEditEffort={
          !session.running && supportedEfforts(agent, effortModel).length
            ? () => onCommand("effort")
            : undefined
        }
        onFork={() => onCommand("fork")}
        onOpenParent={
          session.parentSessionId ? () => onCommand("parent") : undefined
        }
        onArchive={onArchive}
        moving={moving}
        moveDisabledReason={reason}
        onMove={() => {
          if (reason || moving) return;
          setMoving(true);
          setError(null);
          void desktopApi
            .sessionMoveToServer(projectId, session.id)
            .catch((cause: unknown) =>
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not move this session",
              ),
            )
            .finally(() => {
              setMoving(false);
              void eligibility.refetch();
            });
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}
