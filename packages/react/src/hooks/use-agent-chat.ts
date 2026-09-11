"use client";

import { ATTACHMENT_MARKER } from "@catamorphic/sandbox/attachments";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  chatDeliveryReducer,
  initialChatDelivery,
} from "../lib/chat-delivery.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
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
  /** Per-session overrides captured when the first message creates the session. */
  model?: string;
  effort?: AgentSessionDetail["modelEffort"];
  /** Logical Environment for a lazily created session. */
  environment?: string;
  /** Surface creating a lazy session. Informational provenance only. */
  source?: AgentSessionDetail["source"];
  /**
   * Optional quiet polling cadence while the session is idle. Hosts should
   * enable this only for a visible chat that can be changed by another client.
   */
  idleRefetchIntervalMs?: number | false;
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
  /** Failed local deliveries retain their content and idempotency key for recovery. */
  failedMessages: OptimisticAgentMessage[];
  resendFailed: (id: string) => Promise<void>;
  dismissFailed: (id: string) => void;
  /** Messages waiting behind the in-flight turn, in send order. */
  queue: PendingAgentTurn[];
  queuedMessageCount: number;
  isLoading: boolean;
  isSending: boolean;
  /**
   * The server's durable execution record reports a running turn.
   * A pending HTTP request is sending, not proof of agent execution.
   */
  isWorking: boolean;
  /** Honest, compact activity from execution state; absent while disconnected. */
  activity: string | undefined;
  /** The host cannot currently confirm the agent's status. */
  connectionLost: boolean;
  error: CatamorphicError | null;
  /** Missing member credentials that blocked admission before execution. */
  authenticationRequired: AgentAuthenticationRequired | null;
  send: (message: string, attachments?: AgentChatAttachment[]) => Promise<void>;
  /** Jump the queue: front-of-line + interrupt the in-flight turn. */
  sendNow: (
    message: string,
    attachments?: AgentChatAttachment[],
  ) => Promise<void>;
  updateQueued: (id: string, content: string) => Promise<boolean>;
  removeQueued: (id: string) => Promise<boolean>;
  /** Promote a queued message to the front and interrupt the current turn. */
  sendQueuedNow: (id: string) => Promise<boolean>;
  /**
   * Mark a queued message as being edited (null = none). While the edited
   * message is at the head of the queue, dispatch waits for the edit to
   * finish — its turn doesn't lapse, it sends when the user is done.
   */
  holdQueued: (id: string | null) => Promise<boolean>;
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
  /** Preserve admission intent when retrying an uncertain delivery. */
  deliveryMode?: "next_turn" | "interrupt";
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
  const operationScopeRef = useRef({});
  const [delivery, dispatchDelivery] = useReducer(
    chatDeliveryReducer,
    operationScopeRef.current,
    initialChatDelivery,
  );
  const {
    optimistic: optimisticMessages,
    error: actionError,
    retrying: retryInProgress,
  } = delivery;
  const sendInProgress = delivery.pending.length;
  const setActionError = (error: CatamorphicError | null) =>
    dispatchDelivery({
      type: "error",
      scope: operationScopeRef.current,
      error,
    });
  const retryRequestRef = useRef<object | null>(null);
  const queueActionTailRef = useRef(Promise.resolve());
  const pendingSendIdsRef = useRef(new Set<string>());
  const activeSessionRef = useRef<{
    projectId: string | undefined;
    controlledSessionId: string | null;
    sessionId: string | null;
  }>({ projectId, controlledSessionId, sessionId: controlledSessionId });
  const blockedSendRef = useRef<{
    id?: string;
    content: string;
    attachments: AgentChatAttachment[];
    deliveryMode: "next_turn" | "interrupt";
  } | null>(null);
  const sessionCreationRef = useRef<Promise<string | null> | null>(null);
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
      operationScopeRef.current = {};
      dispatchDelivery({ type: "reset", scope: operationScopeRef.current });
      retryRequestRef.current = null;
      queueActionTailRef.current = Promise.resolve();
      pendingSendIdsRef.current = new Set();
      heldTurnIdRef.current = null;
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
  // Poll quickly while a turn is active. Hosts may keep a quieter cadence for
  // the one visible chat when another client can write to the same session;
  // hidden mounted chats stay dormant.
  const session = useAgentSession(projectId, sessionId ?? undefined, {
    refetchInterval: (data) =>
      sendInProgress > 0 ||
      data?.execution?.status === "running" ||
      data?.execution?.status === "queued"
        ? 500
        : (options.idleRefetchIntervalMs ?? false),
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

  // The operation spans lazy creation through delivery acknowledgement.
  // Mutation observers can retain an older pending snapshot when the host
  // adopts the created id; they are not another source of chat activity.
  const isSending = sendInProgress > 0;
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
    if (
      (optimisticMessages.length === 0 && delivery.failed.length === 0) ||
      persistedMessages.length === 0
    ) {
      return;
    }
    const persistedIds = new Set(
      persistedMessages.map((message) => message.id),
    );
    dispatchDelivery({
      type: "persisted",
      scope: operationScopeRef.current,
      ids: persistedIds,
    });
  }, [optimisticMessages, delivery.failed, persistedMessages]);
  const isWorking = session.data?.execution?.status === "running";

  const ensureSessionId = async (): Promise<string | null> => {
    if (!projectId) return null;
    const existingSessionId = activeSessionRef.current.sessionId;
    if (existingSessionId) return existingSessionId;
    if (!sessionCreationRef.current) {
      const scope = operationScopeRef.current;
      sessionCreationRef.current = createSession
        .mutateAsync({
          ...(agentIdRef.current ? { agentId: agentIdRef.current } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.source ? { source: options.source } : {}),
        })
        .then((created) => {
          if (operationScopeRef.current !== scope) return null;
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
          if (operationScopeRef.current === scope)
            sessionCreationRef.current = null;
        });
    }
    return sessionCreationRef.current;
  };

  const performSend = async (input: {
    content: string;
    attachments: AgentChatAttachment[];
    deliveryMode: "next_turn" | "interrupt";
    id?: string;
  }) => {
    if (!projectId || delivery.scope !== operationScopeRef.current) return;
    const scope = delivery.scope;
    setActionError(null);
    let accepted = false;
    const optimistic: OptimisticAgentMessage = {
      id: input.id ?? randomId(),
      role: "user",
      content: input.content,
      deliveryMode: input.deliveryMode,
      ...(input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    };
    if (pendingSendIdsRef.current.has(optimistic.id)) return;
    pendingSendIdsRef.current.add(optimistic.id);
    dispatchDelivery({ type: "start", scope, message: optimistic });
    try {
      const targetSessionId = await ensureSessionId();
      if (!targetSessionId || operationScopeRef.current !== scope) return;
      const receipt = await sendMessage.mutateAsync({
        idempotencyKey: optimistic.id,
        sessionId: targetSessionId,
        message: input.content,
        attachments: input.attachments,
        deliveryMode: input.deliveryMode,
      });
      accepted = true;
      if (operationScopeRef.current !== scope) return;
      dispatchDelivery({
        type: "accepted",
        scope,
        id: optimistic.id,
        messageId: receipt.messageId,
      });
      blockedSendRef.current = null;
    } catch (error) {
      if (operationScopeRef.current !== scope) return;
      setActionError(toCatamorphicError({ cause: error }));
      if (
        error instanceof CatamorphicError &&
        error.code === "authentication_required"
      ) {
        // This request was rejected before the server accepted it. Retain one
        // retryable intent; accepted messages always live in the server inbox.
        blockedSendRef.current = { ...input, id: optimistic.id };
      }
    } finally {
      if (scope === operationScopeRef.current)
        pendingSendIdsRef.current.delete(optimistic.id);
      dispatchDelivery({ type: "settled", scope, id: optimistic.id, accepted });
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
    }
  };

  const interrupt = async () => {
    if (delivery.scope !== operationScopeRef.current) return;
    const target = activeSessionRef.current.sessionId;
    if (!projectId || !target) return;
    const scope = delivery.scope;
    if (scope !== operationScopeRef.current) return;
    setActionError(null);
    try {
      await runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/interrupt",
            {
              params: { path: { projectId, sessionId: target } },
              signal: AbortSignal.timeout(15_000),
            },
          ),
          "Stop was not confirmed",
        ),
      );
    } catch (error) {
      if (operationScopeRef.current !== scope) return;
      setActionError(
        error instanceof CatamorphicError
          ? error
          : toCatamorphicError({ cause: error }),
      );
    }
    await queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId, "agent", "session", target],
    });
  };

  const retry = async () => {
    if (delivery.scope !== operationScopeRef.current) return;
    const target = activeSessionRef.current.sessionId;
    if (!projectId || !target || retryRequestRef.current) return;
    const scope = operationScopeRef.current;
    retryRequestRef.current = scope;
    dispatchDelivery({ type: "retry", scope, active: true });
    setActionError(null);
    try {
      await runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/retry",
            {
              params: { path: { projectId, sessionId: target } },
              signal: AbortSignal.timeout(15_000),
            },
          ),
          "Retry was not confirmed",
        ),
      );
    } catch (error) {
      if (operationScopeRef.current !== scope) return;
      setActionError(
        error instanceof CatamorphicError
          ? error
          : toCatamorphicError({ cause: error }),
      );
    } finally {
      if (retryRequestRef.current === scope) retryRequestRef.current = null;
      dispatchDelivery({ type: "retry", scope, active: false });
      void queryClient.invalidateQueries({
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
      // Taking over a live child is an interruption, not another item for
      // the delegated queue. Core records the takeover and notifies its
      // parent, which may have been waiting on the original assignment.
      deliveryMode:
        session.data?.parentSessionId && isWorking ? "interrupt" : "next_turn",
    });
  };

  const runQueueAction = async ({
    target,
    action,
    onSuccess,
  }: {
    target: string;
    action: (signal: AbortSignal) => Promise<unknown>;
    onSuccess?: () => void;
  }) => {
    const scope = delivery.scope;
    if (scope !== operationScopeRef.current) return false;
    setActionError(null);
    const previous = queueActionTailRef.current;
    let release = () => {};
    queueActionTailRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (operationScopeRef.current !== scope) return false;
      await runWithCatamorphicError(() => action(AbortSignal.timeout(15_000)));
      if (operationScopeRef.current !== scope) return false;
      onSuccess?.();
      return true;
    } catch (error) {
      if (operationScopeRef.current === scope)
        setActionError(toCatamorphicError({ cause: error }));
      return false;
    } finally {
      release();
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", target],
      });
    }
  };

  const error = actionError ?? session.error ?? null;

  return {
    sessionId,
    session: session.data ?? null,
    messages: visibleMessages,
    optimisticMessages: reconciledOptimistic,
    failedMessages: delivery.failed,
    resendFailed: async (id) => {
      const message = delivery.failed.find((item) => item.id === id);
      if (message)
        await performSend({
          id: message.id,
          content: message.content,
          attachments: message.attachments ?? [],
          deliveryMode: message.deliveryMode ?? "next_turn",
        });
    },
    dismissFailed: (id) =>
      dispatchDelivery({
        type: "dismiss-failed",
        scope: operationScopeRef.current,
        id,
      }),
    queue,
    queuedMessageCount: queue.length,
    isLoading: session.isLoading,
    isSending: isSending || retryInProgress,
    isWorking,
    activity:
      session.error?.code === "network"
        ? undefined
        : isWorking
          ? !session.data?.execution?.executorHealthy
            ? "Checking agent status"
            : session.data.execution.cancellationRequested
              ? "Stopping agent"
              : (session.data.execution.activity ?? "Waiting for agent")
          : retryInProgress
            ? "Retrying message"
            : isSending
              ? "Sending message"
              : undefined,
    connectionLost: session.error?.code === "network",
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
    updateQueued: async (id, content) => {
      const queued = queue.find((message) => message.id === id);
      if (delivery.scope !== operationScopeRef.current) return false;
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target || !queued) return false;
      const withoutMarkers = content.split(ATTACHMENT_MARKER).join("");
      const markerCount =
        (content.length - withoutMarkers.length) / ATTACHMENT_MARKER.length;
      const next =
        markerCount === queued.attachments.length
          ? content
          : withoutMarkers +
            ATTACHMENT_MARKER.repeat(queued.attachments.length);
      return runQueueAction({
        target,
        onSuccess: () => {
          if (heldTurnIdRef.current === id) heldTurnIdRef.current = null;
        },
        action: async (signal) =>
          assertApiOk(
            await apiClient.PATCH(
              "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
              {
                signal,
                params: { path: { projectId, sessionId: target, turnId: id } },
                body: {
                  content: next,
                  metadata: { attachments: queued.attachments },
                  held: false,
                },
              },
            ),
            "Queued message could not be updated",
          ),
      });
    },
    removeQueued: async (id) => {
      if (delivery.scope !== operationScopeRef.current) return false;
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return false;
      return runQueueAction({
        target,
        onSuccess: () => {
          if (heldTurnIdRef.current === id) heldTurnIdRef.current = null;
        },
        action: async (signal) =>
          assertApiOk(
            await apiClient.DELETE(
              "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
              {
                signal,
                params: { path: { projectId, sessionId: target, turnId: id } },
              },
            ),
            "Queued message could not be removed",
          ),
      });
    },
    sendQueuedNow: async (id) => {
      if (delivery.scope !== operationScopeRef.current) return false;
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return false;
      return runQueueAction({
        target,
        onSuccess: () => {
          if (heldTurnIdRef.current === id) heldTurnIdRef.current = null;
        },
        action: async (signal) =>
          assertApiOk(
            await apiClient.POST(
              "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}/send-now",
              {
                signal,
                params: { path: { projectId, sessionId: target, turnId: id } },
              },
            ),
            "Queued message could not be sent now",
          ),
      });
    },
    holdQueued: async (id) => {
      if (delivery.scope !== operationScopeRef.current) return false;
      const target = activeSessionRef.current.sessionId;
      if (!projectId || !target) return false;
      const turnId = id ?? heldTurnIdRef.current;
      if (!turnId) return false;
      if (id !== null) heldTurnIdRef.current = id;
      return runQueueAction({
        target,
        onSuccess: () => {
          if (id === null && heldTurnIdRef.current === turnId)
            heldTurnIdRef.current = null;
        },
        action: async (signal) =>
          assertApiOk(
            await apiClient.PATCH(
              "/api/projects/{projectId}/agent/sessions/{sessionId}/turns/{turnId}",
              {
                signal,
                params: { path: { projectId, sessionId: target, turnId } },
                body: { held: id !== null },
              },
            ),
            "Queued message editing state could not be updated",
          ),
      });
    },
    retry,
    resumeAfterAuthentication: () => {
      const blocked = blockedSendRef.current;
      if (blocked) void performSend(blocked);
    },
    interrupt,
    startNewSession: () => {
      if (
        delivery.scope === operationScopeRef.current &&
        pendingSendIdsRef.current.size === 0
      ) {
        operationScopeRef.current = {};
        dispatchDelivery({ type: "reset", scope: operationScopeRef.current });
        retryRequestRef.current = null;
        queueActionTailRef.current = Promise.resolve();
        pendingSendIdsRef.current = new Set();
        heldTurnIdRef.current = null;
        activeSessionRef.current = {
          projectId,
          controlledSessionId,
          sessionId: null,
        };
        setActiveSession({ projectId, controlledSessionId, sessionId: null });
        blockedSendRef.current = null;
        sessionCreationRef.current = null;
      }
    },
  };
}

export function authenticationRequiredFrom(
  error: unknown,
): AgentAuthenticationRequired | null {
  if (
    !(error instanceof CatamorphicError) ||
    error.code !== "authentication_required"
  )
    return null;
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

function reconcileOptimisticMessages(
  persisted: AgentMessage[],
  optimistic: OptimisticAgentMessage[],
): OptimisticAgentMessage[] {
  const persistedIds = new Set(persisted.map((message) => message.id));
  return optimistic.filter((message) => !persistedIds.has(message.id));
}
