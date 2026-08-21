"use client";

import { ATTACHMENT_MARKER } from "@catamorphic/sandbox/attachments";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { CatamorphicError } from "../lib/errors.js";
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
  /**
   * Create the lazy session as incognito (ADR 0062): local-only history,
   * never mirrored to a linked remote. Read at send time, like `agentId`.
   */
  incognito?: boolean;
}

/** A message waiting behind the in-flight turn. */
export interface QueuedAgentMessage {
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
  queue: QueuedAgentMessage[];
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
  /** Abort the in-flight turn (and any scheduled auto-retry). */
  interrupt: () => Promise<void>;
  startNewSession: () => void;
}

export interface OptimisticAgentMessage {
  id: string;
  role: "user";
  content: string;
  attachments?: AgentChatAttachment[];
}

/**
 * Headless agent-chat orchestration. Hosts own the visual presentation while
 * this hook owns lazy session creation, message sending, the outgoing queue
 * (messages sent while a turn runs wait their turn, editable until
 * dispatched), and cache refreshes.
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
  const [sendInProgress, setSendInProgress] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticAgentMessage[]
  >([]);
  const [queue, setQueue] = useState<QueuedAgentMessage[]>([]);
  const activeSessionRef = useRef<{
    projectId: string | undefined;
    controlledSessionId: string | null;
    sessionId: string | null;
  }>({ projectId, controlledSessionId, sessionId: controlledSessionId });
  const queueRef = useRef<QueuedAgentMessage[]>([]);
  const holdRef = useRef<string | null>(null);
  const processingRef = useRef(false);
  const { apiClient } = useCatamorphic();
  const syncQueue = () => setQueue([...queueRef.current]);
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
      setQueue([]);
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
    if (!refAdoptedOwnSession) {
      // Real session switch: drop the stale queue.
      queueRef.current = [];
    }
  }
  const sessionId =
    activeSession.projectId === projectId ? activeSession.sessionId : null;
  const queryClient = useQueryClient();
  const createSession = useCreateAgentSession(projectId);
  const sendMessage = useSendAgentMessage(projectId);
  // Read at send time so the host's latest default applies to lazy creation.
  const agentIdRef = useRef(options.agentId);
  agentIdRef.current = options.agentId;
  const incognitoRef = useRef(options.incognito);
  incognitoRef.current = options.incognito;
  // Poll while a send is in flight OR the server still reports an
  // in-progress assistant turn. The latter covers sends that end in an HTTP
  // error: the server persists the terminal (failed) message, and without a
  // final refetch the cached snapshot would show a spinning placeholder
  // forever. Auto-retries also need the poll: their countdown and re-run
  // happen entirely server-side.
  const session = useAgentSession(projectId, sessionId ?? undefined, {
    refetchInterval: (data) =>
      sendInProgress ||
      hasPendingAssistant(data?.messages) ||
      hasScheduledAutoRetry(data?.messages)
        ? 500
        : false,
  });

  const isSending =
    sendInProgress || createSession.isPending || sendMessage.isPending;
  const persistedMessages = session.data?.messages ?? [];
  const reconciledOptimistic = reconcileOptimisticMessages(
    persistedMessages,
    optimisticMessages,
  );
  // Server truth beats local request state: the turn runs inside the send
  // request, and if that response stalls after the turn's messages are
  // already persisted, `isSending` would spin forever. Once the server
  // shows the turn settled — last message is a completed assistant reply,
  // nothing optimistic or queued left — the indicator stops.
  const turnSettled =
    persistedMessages.at(-1)?.role === "assistant" &&
    !hasPendingAssistant(persistedMessages) &&
    reconciledOptimistic.length === 0 &&
    queueRef.current.length === 0;
  const isWorking =
    hasPendingAssistant(persistedMessages) || (isSending && !turnSettled);

  const ensureSessionId = async (): Promise<string | null> => {
    if (!projectId) return null;
    const existingSessionId = activeSessionRef.current.sessionId;
    if (existingSessionId) return existingSessionId;
    const created = await createSession.mutateAsync({
      ...(agentIdRef.current ? { agentId: agentIdRef.current } : {}),
      ...(incognitoRef.current ? { incognito: true } : {}),
    });
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
  };

  const performSend = async (queued: QueuedAgentMessage) => {
    if (!projectId) return;
    const targetSessionId = await ensureSessionId();
    if (!targetSessionId) return;
    await sendMessage.mutateAsync({
      sessionId: targetSessionId,
      message: queued.content,
      attachments: queued.attachments,
    });
    await queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId],
    });
  };

  const processQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    setSendInProgress(true);
    try {
      while (queueRef.current.length > 0) {
        const head = queueRef.current[0];
        if (!head) continue;
        // The head is being edited: its turn WAITS for the edit — the user
        // finishes, the message sends. Nothing skips ahead of it.
        if (holdRef.current === head.id) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        queueRef.current.shift();
        syncQueue();
        const optimistic: OptimisticAgentMessage = {
          id: head.id,
          role: "user",
          content: head.content,
          ...(head.attachments.length > 0
            ? { attachments: head.attachments }
            : {}),
        };
        setOptimisticMessages((messages) => [...messages, optimistic]);
        try {
          await performSend(head);
        } catch {
          // Mutation state exposes the error to consumers; continue draining.
        } finally {
          setOptimisticMessages((messages) =>
            messages.filter((message) => message.id !== head.id),
          );
        }
      }
    } finally {
      processingRef.current = false;
      setSendInProgress(false);
    }
  };

  const enqueue = (
    message: string,
    attachments: AgentChatAttachment[],
    position: "back" | "front",
  ) => {
    const queued: QueuedAgentMessage = {
      id: crypto.randomUUID(),
      content: message,
      attachments,
    };
    if (position === "front") queueRef.current.unshift(queued);
    else queueRef.current.push(queued);
    syncQueue();
    void processQueue();
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
    enqueue(content, attachments ?? [], "back");
    return Promise.resolve();
  };

  return {
    sessionId,
    session: session.data ?? null,
    messages: session.data?.messages ?? [],
    optimisticMessages: reconciledOptimistic,
    queue,
    queuedMessageCount: queue.length,
    isLoading: session.isLoading,
    isSending: isSending || retryInProgress,
    isWorking: isWorking || retryInProgress,
    error: createSession.error ?? sendMessage.error ?? session.error ?? null,
    send,
    sendNow: async (message, attachments) => {
      const content = message.trim();
      if (!content && (attachments?.length ?? 0) === 0) return;
      enqueue(content, attachments ?? [], "front");
      await interrupt();
    },
    updateQueued: (id, content) => {
      queueRef.current = queueRef.current.map((queued) => {
        if (queued.id !== id) return queued;
        // Invariant: marker count equals attachments length (the n-th
        // marker is the n-th attachment). A plain-text edit can delete or
        // duplicate markers; when the counts diverge, reflow every pill to
        // the end of the prose instead of silently remapping positions.
        const withoutMarkers = content.split(ATTACHMENT_MARKER).join("");
        const markerCount =
          (content.length - withoutMarkers.length) / ATTACHMENT_MARKER.length;
        const next =
          markerCount === queued.attachments.length
            ? content
            : withoutMarkers +
              ATTACHMENT_MARKER.repeat(queued.attachments.length);
        return { ...queued, content: next };
      });
      syncQueue();
    },
    removeQueued: (id) => {
      queueRef.current = queueRef.current.filter((queued) => queued.id !== id);
      if (holdRef.current === id) holdRef.current = null;
      syncQueue();
    },
    sendQueuedNow: (id) => {
      const index = queueRef.current.findIndex((queued) => queued.id === id);
      if (index < 0) return;
      const [queued] = queueRef.current.splice(index, 1);
      if (!queued) return;
      if (holdRef.current === id) holdRef.current = null;
      queueRef.current.unshift(queued);
      syncQueue();
      void interrupt();
      void processQueue();
    },
    holdQueued: (id) => {
      holdRef.current = id;
    },
    retry,
    interrupt,
    startNewSession: () => {
      if (!processingRef.current) {
        activeSessionRef.current = {
          projectId,
          controlledSessionId,
          sessionId: null,
        };
        setActiveSession({ projectId, controlledSessionId, sessionId: null });
        setOptimisticMessages([]);
        queueRef.current = [];
        setQueue([]);
      }
    },
  };
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
  const counts = new Map<string, number>();
  for (const message of persisted) {
    if (message.role !== "user") continue;
    counts.set(message.content, (counts.get(message.content) ?? 0) + 1);
  }
  return optimistic.filter((message) => {
    const count = counts.get(message.content) ?? 0;
    if (count === 0) return true;
    counts.set(message.content, count - 1);
    return false;
  });
}
