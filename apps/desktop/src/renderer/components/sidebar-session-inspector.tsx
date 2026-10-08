import type { AgentSession } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  defaultModelLabel,
  modelId,
  useAgentDefaultModel,
} from "../lib/agent-default-model.js";
import { effectiveEffort, supportedEfforts } from "../lib/agent-effort.js";
import { agentPermissionView } from "../lib/agent-permissions.js";
import {
  type AgentInfo,
  desktopApi,
  projectAgentAsInfo,
  type SessionCheckoutInfo,
} from "../lib/desktop-api.js";
import { useRemoteProject } from "./project-authority-provider.js";
import { SessionInspectorContent } from "./session-inspector.js";

export type SessionCommand =
  | "switch-agent"
  | "model"
  | "effort"
  | "permission-mode"
  | "fork"
  | "parent";

/** Mounted on hover only: the same live details and actions as chat chrome. */
export function SidebarSessionInspector({
  projectId,
  session,
  agent: profileAgent,
  agents = [],
  agentName,
  checkout,
  onCommand,
  onArchive,
}: {
  projectId: string;
  session: AgentSession;
  agent?: AgentInfo;
  /** The profile's agents: what the session may switch to. */
  agents?: AgentInfo[];
  agentName: string;
  checkout: SessionCheckoutInfo | null;
  onCommand: (command: SessionCommand) => void;
  onArchive: () => void;
}) {
  const projectAgents = useQuery({
    queryKey: ["desktop-project-agents", projectId],
    queryFn: () => desktopApi.projectAgentsList(projectId),
    staleTime: 30_000,
  });
  const agent =
    profileAgent ??
    projectAgents.data?.agents
      .map(projectAgentAsInfo)
      .find((entry) => entry.id === session.agentId);
  // Another agent to pick for the session (lib/agent-switch: one on another
  // harness starts a new chat). Committed agents whose definition fails are
  // listed in the picker, never picked. A connected project's session runs
  // on the server's agents, not these.
  const remote = useRemoteProject(projectId);
  const otherAgents = remote
    ? 0
    : [
        ...agents.map((candidate) => candidate.id),
        ...(projectAgents.data?.agents
          .filter((candidate) => !candidate.invalid)
          .map((candidate) => candidate.id) ?? []),
      ].filter((id) => id !== session.agentId).length;
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
  const pinnedModel = session.model || agent?.model;
  const harnessDefault = useAgentDefaultModel({
    projectId,
    agent,
    sessionId: session.id,
    enabled: !pinnedModel,
  });
  const runningModel = pinnedModel || harnessDefault.data?.model?.id;
  const effortModel = catalog.data?.models.find(
    (entry) => entry.id === runningModel || entry.resolvedId === runningModel,
  );
  const permissions = agentPermissionView({ agent });
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
        model={
          pinnedModel
            ? modelId(pinnedModel, catalog.data?.models)
            : defaultModelLabel(agent, harnessDefault.data?.model)
        }
        modelIsDefault={!pinnedModel && Boolean(harnessDefault.data?.model)}
        effort={
          effectiveEffort(
            agent,
            session.modelEffort ?? agent?.effort,
            effortModel,
          ) ?? "Default"
        }
        onEditAgent={
          !session.running && otherAgents > 0
            ? () => onCommand("switch-agent")
            : undefined
        }
        agentDisabledReason={
          otherAgents > 0 && session.running
            ? "Agent can be changed after the current turn finishes."
            : undefined
        }
        onEditModel={
          !session.running && agent ? () => onCommand("model") : undefined
        }
        onEditEffort={
          !session.running && supportedEfforts(agent, effortModel).length
            ? () => onCommand("effort")
            : undefined
        }
        permissionMode={permissions.permissionMode}
        sandboxing={permissions.sandboxing}
        onEditPermissionMode={
          !session.running && permissions.editable
            ? () => onCommand("permission-mode")
            : undefined
        }
        permissionModeDisabledReason={
          permissions.editable ? undefined : permissions.readOnlyReason
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
