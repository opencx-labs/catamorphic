"use client";

import { ATTACHMENT_MARKER } from "@catamorphic/sandbox/attachments";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CatamorphicError } from "../lib/errors.js";
import { randomId } from "../lib/random-id.js";
import { useCatamorphic } from "../provider.js";
import type { AgentMessage, AgentSessionDetail } from "../types.js";
import { useAgentSession } from "./use-agent-session.js";
import { useCreateAgentSession } from "./use-create-agent-session.js";
import {
  type AgentChatAttachment,
  useSendAgentMessage,
} from "./use-send-agent-message.js";

export interface UseAgentChatOptions {
  /**
   * Open an existing session instead of lazily creating one on first send.
   * When provided, the hook resets its chat state whenever this changes, so
   * hosts can drive session selection from a sidebar. Lazily created sessions
   * are reported through {@link UseAgentChatOptions.onSessionCreated}.
   */
  sessionId?: string;
  /** Called when the hook lazily creates a session on first send. */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Host-registry key of the agent for lazily created sessions. Read at
   * send time, so hosts can change it up until the first message. Existing
   * sessions are unaffected — switch those via `useUpdateAgentSession`.
   */
  agentId?: string;
  /** Logical Environment for a lazily created session. */
  environment?: string;
}

/** A message waiting behind the in-flight turn. */
export interface PendingAgentTurn {
  id: string;
  content: string;
  attachments: AgentChatAttachment[];
}

export interface UseAgentChatResult {
  sessionId: string | null;
  /** The live session detail (agent, effort, title); null before creation. */
  session: AgentSessionDetail | null;
  messages: AgentMessage[];
  optimisticMessages: OptimisticAgentMessage[];
  /** Messages waiting behind the in-flight turn, in send order. */
  queue: PendingAgentTurn[];
  queuedMessageCount: number;
  isLoading: boolean;
  isSending: boolean;
  /**
   * The agent is working on this chat: a send is in flight from this client
   * OR the server reports an in-progress assistant turn. Prefer this over
   * {@link isSending} for activity indicators — it stays accurate when the
   * request and the turn don't line up (reloads, other clients).
   */
  isWorking: boolean;
  error: CatamorphicError | null;
  /** Missing member credentials that blocked admission before execution. */
  authenticationRequired: AgentAuthenticationRequired | null;
  send: (message: string, attachments?: AgentChatAttachment[]) => Promise<void>;
  /** Jump the queue: front-of-line + interrupt the in-flight turn. */
  sendNow: (
    message: string,
    attachments?: AgentChatAttachment[],
  ) => Promise<void>;
  updateQueued: (id: string, content: string) => void;
  removeQueued: (id: string) => void;
  /** Promote a queued message to the front and interrupt the current turn. */
  sendQueuedNow: (id: string) => void;
  /**
   * Mark a queued message as being edited (null = none). While the edited
   * message is at the head of the queue, dispatch waits for the edit to
   * finish — its turn doesn't lapse, it sends when the user is done.
   */
  holdQueued: (id: string | null) => void;
  /** Re-run the last failed turn in place (no new user message). */
  retry: () => Promise<void>;
  /** Resume the preserved head message after the member authorizes access. */
  resumeAfterAuthentication: () => void;
  /** Abort the in-flight turn (and any scheduled auto-retry). */
  interrupt: () => Promise<void>;
  startNewSession: () => void;
}

export interface AgentAuthenticationRequired {
  environment: string;
  requirements: Array<{
    alias: string;
    providerKind: string;
    principalKinds: Array<"member" | "project_service" | "tenant_service">;
  }>;
}

export interface OptimisticAgentMessage {
  id: string;
  role: "user";
  content: string;
  attachments?: AgentChatAttachment[];
}

/**
 * Headless agent-chat orchestration. Hosts own the visual presentation while
 * this hook owns lazy session creation, message sending, and cache refreshes.
 * The server-owned session inbox is the only queue authority (ADR 0074).
 */
export function useAgentChat(
  projectId: string | undefined,
  options: UseAgentChatOptions = {},
): UseAgentChatResult {
  const controlledSessionId = options.sessionId ?? null;
  const [activeSession, setActiveSession] = useState<{
    projectId: string | undefined;
    controlledSessionId: string | null;
    sessionId: string | null;
  }>({ projectId, controlledSessionId, sessionId: controlledSessionId });
  const [sendInProgress, setSendInProgress] = useState(0);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticAgentMessage[]
  >([]);
  const activeSessionRef = useRef<{
    projectId: string | undefined;
    controlledSessionId: string | null;
    sessionId: string | null;
  }>({ projectId, controlledSessionId, sessionId: controlledSessionId });
  const blockedSendRef = useRef<{
    content: string;
    attachments: AgentChatAttachment[];
    deliveryMode: "next_turn" | "interrupt";
  } | null>(null);
  const sessionCreationRef = useRef<Promise<string> | null>(null);
  const heldTurnIdRef = useRef<string | null>(null);
  const { apiClient } = useCatamorphic();
  // A controlled-id change normally means the host switched sessions, so chat
  // state resets. But when the host echoes back the id this hook just created
  // (via onSessionCreated), it is the SAME conversation — resetting would
  // wipe optimistic messages mid-send and flicker the timeline.
  const adoptedOwnSession =
    projectId === activeSession.projectId &&
    controlledSessionId !== null &&
    controlledSessionId === activeSession.sessionId;
  if (
    activeSession.projectId !== projectId ||
    activeSession.controlledSessionId !== controlledSessionId
  ) {
    setActiveSession({
      projectId,
      controlledSessionId,
      sessionId: controlledSessionId,
    });
    if (!adoptedOwnSession) {
      setOptimisticMessages([]);
      blockedSendRef.current = null;
    }
  }
  if (
    activeSessionRef.current.projectId !== projectId ||
    activeSessionRef.current.controlledSessionId !== controlledSessionId
  ) {
    const refAdoptedOwnSession =
      projectId === activeSessionRef.current.projectId &&
      controlledSessionId !== null &&
      controlledSessionId === activeSessionRef.current.sessionId;
    activeSessionRef.current = {
      projectId,
      controlledSessionId,
      sessionId: controlledSessionId,
    };
    if (!refAdoptedOwnSession) blockedSendRef.current = null;
    if (!refAdoptedOwnSession) sessionCreationRef.current = null;
  }
  const sessionId =
    activeSession.projectId === projectId ? activeSession.sessionId : null;
  const queryClient = useQueryClient();
  const createSession = useCreateAgentSession(projectId);
  const sendMessage = useSendAgentMessage(projectId);
  // Read at send time so the host's latest default applies to lazy creation.
  const agentIdRef = useRef(options.agentId);
  agentIdRef.current = options.agentId;
  // Poll while a send is in flight OR the server still reports an
  // in-progress assistant turn. The latter covers sends that end in an HTTP
  // error: the server persists the terminal (failed) message, and without a
  // final refetch the cached snapshot would show a spinning placeholder
  // forever. Auto-retries also need the poll: their countdown and re-run
  // happen entirely server-side.
  const session = useAgentSession(projectId, sessionId ?? undefined, {
    refetchInterval: (data) =>
      sendInProgress > 0 ||
      hasPendingAssistant(data?.messages) ||
      (data?.pendingTurns?.length ?? 0) > 0 ||
      hasScheduledAutoRetry(data?.messages)
        ? 500
        : false,
  });
  const sessionListSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !session.data) return;
    const snapshot = JSON.stringify({
      sessionId: session.data.id,
      title: session.data.title,
      running: session.data.running,
    });
    const previous = sessionListSnapshotRef.current;
    sessionListSnapshotRef.current = snapshot;
    if (previous === null || previous === snapshot) return;
    void queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId, "agent", "sessions"],
    });
  }, [projectId, queryClient, session.data]);

  const isSending =
    sendInProgress > 0 || createSession.isPending || sendMessage.isPending;
  const persistedMessages = session.data?.messages ?? [];
  const queuedTurns =
    session.data?.pendingTurns?.filter((turn) => turn.status !== "running") ??
    [];
  const queuedMessageIds = new Set(queuedTurns.map((turn) => turn.messageId));
  const visibleMessages = persistedMessages.filter(
    (message) => !queuedMessageIds.has(message.id),
  );
  const queue: PendingAgentTurn[] = queuedTurns.map((turn) => ({
    id: turn.id,
    content: turn.content,
    attachments: attachmentsFromMetadata(turn.metadata),
  }));
  const reconciledOptimistic = reconcileOptimisticMessages(
    persistedMessages,
    optimisticMessages,
  );
  useEffect(() => {
    if (optimisticMessages.length === 0 || persistedMessages.length === 0) {
      return;
    }
    const persistedIds = new Set(
      persistedMessages.map((message) => message.id),
    );
    setOptimisticMessages((messages) => {
      const pending = messages.filter(
        (message) => !persistedIds.has(message.id),
      );
      return pending.length === messages.length ? messages : pending;
    });
  }, [optimisticMessages, persistedMessages]);
  // Server truth beats local request state: the turn runs inside the send
  // request, and if that response stalls after the turn's messages are
  // already persisted, `isSending` would spin forever. Once the server
  // shows the turn settled — last message is a completed assistant reply,
  // nothing optimistic or queued left — the indicator stops.
  const turnSettled =
    persistedMessages.at(-1)?.role === "assistant" &&
    !hasPendingAssistant(persistedMessages) &&
    reconciledOptimistic.length === 0 &&
    queuedTurns.length === 0;
  const isWorking =
    hasPendingAssistant(persistedMessages) ||
    (session.data?.pendingTurns?.some((turn) => turn.status === "running") ??
      false) ||
    (isSending && !turnSettled);

  const ensureSessionId = async (): Promise<string | null> => {
    if (!projectId) return null;
    const existingSessionId = activeSessionRef.current.sessionId;
    if (existingSessionId) return existingSessionId;
    if (!sessionCreationRef.current) {
      sessionCreationRef.current = createSession
        .mutateAsync({
          ...(agentIdRef.current ? { agentId: agentIdRef.current } : {}),
          ...(options.environment ? { environment: options.environment } : {}),
        })
        .then((created) => {
          activeSessionRef.current = {
            projectId,
            controlledSessionId,
            sessionId: created.id,
          };
          setActiveSession({
            projectId,
            controlledSessionId,
            sessionId: created.id,
          });
          options.onSessionCreated?.(created.id);
          return created.id;
        })
        .finally(() => {
          sessionCreationRef.current = null;
        });
    }
    return sessionCreationRef.current;
  };

  const performSend = async (input: {
    content: string;
    attachments: AgentChatAttachment[];
    deliveryMode: "next_turn" | "interrupt";
  }) => {
    if (!projectId) return;
    let accepted = false;
    const optimistic: OptimisticAgentMessage = {
      id: randomId(),
      role: "user",
      content: input.content,
      ...(input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    };
    setOptimisticMessages((messages) => [...messages, optimistic]);
    setSendInProgress((count) => count + 1);
    try {
      const targetSessionId = await ensureSessionId();
      if (!targetSessionId) return;
      const receipt = await sendMessage.mutateAsync({
        sessionId: targetSessionId,
        message: input.content,
        attachments: input.attachments,
        deliveryMode: input.deliveryMode,
      });
      accepted = true;
      setOptimisticMessages((messages) =>
        messages.map((message) =>
          message.id === optimistic.id
            ? { ...message, id: receipt.messageId }
            : message,
        ),
      );
      blockedSendRef.current = null;
    } catch (error) {
      if (
        error instanceof CatamorphicError &&
        error.code === "authentication_required"
      ) {
        // This request was rejected before the server accepted it. Retain one
        // retryable intent; accepted messages always live in the server inbox.
        blockedSendRef.current = input;
      }
    } finally {
      setSendInProgress((count) => Math.max(0, count - 1));
      if (!accepted) {
        setOptimisticMessages((messages) =>
          messages.filter((message) => message.id !== optimistic.id),
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
    }
  };

  const interrupt = async () => {
    const target = activeSessionRef.current.sessionId;
    if (!projectId || !target) return;
    await apiClient
      .POST("/api/projects/{projectId}/agent/sessions/{sessionId}/interrupt", {
        params: { path: { projectId, sessionId: target } },
      })
      .catch(() => {});
    await queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId, "agent", "session", target],
    });
  };

  const [retryInProgress, setRetryInProgress] = useState(false);
  const retry = async () => {
    const target = activeSessionRef.current.sessionId;
    if (!projectId || !target || retryInProgress) return;
    setRetryInProgress(true);
    try {
      await apiClient.POST(
        "/api/projects/{projectId}/agent/sessions/{sessionId}/retry",
        { params: { path: { projectId, sessionId: target } } },
      );
    } finally {
      setRetryInProgress(false);
      await queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", target],
      });
    }
  };

  const send = (message: string, attachments?: AgentChatAttachment[]) => {
    const content = message.trim();
    if (!content && (attachments?.length ?? 0) === 0) {
      return Promise.resolve();
    }
    return performSend({
      content,
      attachments: attachments ?? [],
      deliveryMode: "next_turn",
    });
  };

  const error =
    createSession.error ?? sendMessage.error ?? session.error ?? null;

  return {
    sessionId,
    session: session.data ?? null,
    messages: visibleMessages,
    optimisticMessages: reconciledOptimistic,
    queue,
    queuedMessageCount: queue.length,
    isLoading: session.isLoading,
    isSending: isSending || retryInProgress,
    isWorking: isWorking || retryInProgress,
    error,
    authenticationRequired: authenticationRequiredFrom(error),
    send,
    sendNow: async (message, attachments) => {
      const content = message.trim();
      if (!content && (attachments?.length ?? 0) === 0) return;
      await performSend({
        content,
        attachments: attachments ?? [],
        deliveryMode: "interrupt",
      });
    },
    updateQueued: (id, content) => {
      const queued = queue.find((message) => message.id === id);
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target || !queued) return;
      if (heldTurnIdRef.current === id) heldTurnIdRef.current = null;
      const withoutMarkers = content.split(ATTACHMENT_MARKER).join("");
      const markerCount =
        (content.length - withoutMarkers.length) / ATTACHMENT_MARKER.length;
      const next =
        markerCount === queued.attachments.length
          ? content
          : withoutMarkers +
            ATTACHMENT_MARKER.repeat(queued.attachments.length);
      void apiClient
        .PATCH(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
          {
            params: { path: { projectId, sessionId: target, turnId: id } },
            body: {
              content: next,
              metadata: { attachments: queued.attachments },
              held: false,
            },
          },
        )
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "agent", "session", target],
          }),
        );
    },
    removeQueued: (id) => {
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return;
      void apiClient
        .DELETE(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
          { params: { path: { projectId, sessionId: target, turnId: id } } },
        )
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "agent", "session", target],
          }),
        );
    },
    sendQueuedNow: (id) => {
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return;
      void apiClient
        .POST(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}/send-now",
          { params: { path: { projectId, sessionId: target, turnId: id } } },
        )
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "agent", "session", target],
          }),
        );
    },
    holdQueued: (id) => {
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return;
      const turnId = id ?? heldTurnIdRef.current;
      if (!turnId) return;
      heldTurnIdRef.current = id;
      void apiClient
        .PATCH(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
          {
            params: { path: { projectId, sessionId: target, turnId } },
            body: { held: id !== null },
          },
        )
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "agent", "session", target],
          }),
        );
    },
    retry,
    resumeAfterAuthentication: () => {
      const blocked = blockedSendRef.current;
      if (blocked) void performSend(blocked);
    },
    interrupt,
    startNewSession: () => {
      if (sendInProgress === 0) {
        activeSessionRef.current = {
          projectId,
          controlledSessionId,
          sessionId: null,
        };
        setActiveSession({ projectId, controlledSessionId, sessionId: null });
        setOptimisticMessages([]);
        blockedSendRef.current = null;
        sessionCreationRef.current = null;
      }
    },
  };
}

function authenticationRequiredFrom(
  error: CatamorphicError | null,
): AgentAuthenticationRequired | null {
  if (error?.code !== "authentication_required") return null;
  const details = error.details;
  if (details === null || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (typeof record.environment !== "string") return null;
  if (!Array.isArray(record.requirements)) return null;
  const requirements: AgentAuthenticationRequired["requirements"] = [];
  for (const raw of record.requirements) {
    if (raw === null || typeof raw !== "object") return null;
    const requirement = raw as Record<string, unknown>;
    if (
      typeof requirement.alias !== "string" ||
      typeof requirement.providerKind !== "string" ||
      !Array.isArray(requirement.principalKinds)
    ) {
      return null;
    }
    const principalKinds = requirement.principalKinds.filter(
      (kind): kind is "member" | "project_service" | "tenant_service" =>
        kind === "member" ||
        kind === "project_service" ||
        kind === "tenant_service",
    );
    if (principalKinds.length !== requirement.principalKinds.length)
      return null;
    requirements.push({
      alias: requirement.alias,
      providerKind: requirement.providerKind,
      principalKinds,
    });
  }
  return { environment: record.environment, requirements };
}

function attachmentsFromMetadata(
  metadata: Record<string, unknown> | null,
): AgentChatAttachment[] {
  const value = metadata?.attachments;
  if (!Array.isArray(value)) return [];
  return value.filter((attachment): attachment is AgentChatAttachment => {
    if (!attachment || typeof attachment !== "object") return false;
    const record = attachment as Record<string, unknown>;
    if (
      (record.kind === "image" || record.kind === "document") &&
      typeof record.name === "string" &&
      typeof record.mediaType === "string" &&
      typeof record.dataBase64 === "string"
    ) {
      return true;
    }
    return (
      record.kind === "text" &&
      typeof record.name === "string" &&
      typeof record.text === "string" &&
      record.source !== null &&
      typeof record.source === "object"
    );
  });
}

function hasPendingAssistant(messages: AgentMessage[] | undefined): boolean {
  const last = messages?.at(-1);
  if (last?.role !== "assistant") return false;
  const metadata = last.metadata as Record<string, unknown> | null;
  return metadata?.status === "in_progress";
}

/** A failed turn with a scheduled auto-retry still needs the poll. */
function hasScheduledAutoRetry(messages: AgentMessage[] | undefined): boolean {
  const last = messages?.at(-1);
  if (last?.role !== "assistant") return false;
  const metadata = last.metadata as Record<string, unknown> | null;
  if (metadata?.status !== "failed") return false;
  const autoRetry = metadata?.autoRetry as { nextAtMs?: number } | undefined;
  // Poll through the scheduled window (plus slack for the retry itself).
  return (
    typeof autoRetry?.nextAtMs === "number" &&
    Date.now() < autoRetry.nextAtMs + 30_000
  );
}

function reconcileOptimisticMessages(
  persisted: AgentMessage[],
  optimistic: OptimisticAgentMessage[],
): OptimisticAgentMessage[] {
  const persistedIds = new Set(persisted.map((message) => message.id));
  return optimistic.filter((message) => !persistedIds.has(message.id));
}
