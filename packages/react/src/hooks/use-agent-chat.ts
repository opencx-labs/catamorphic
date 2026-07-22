"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { CatamorphicError } from "../lib/errors.js";
import type { AgentMessage } from "../types.js";
import { useAgentSession } from "./use-agent-session.js";
import { useCreateAgentSession } from "./use-create-agent-session.js";
import { useSendAgentMessage } from "./use-send-agent-message.js";

export interface UseAgentChatResult {
  sessionId: string | null;
  messages: AgentMessage[];
  optimisticMessages: OptimisticAgentMessage[];
  queuedMessageCount: number;
  isLoading: boolean;
  isSending: boolean;
  error: CatamorphicError | null;
  send: (message: string) => Promise<void>;
  startNewSession: () => void;
}

export interface OptimisticAgentMessage {
  id: string;
  role: "user";
  content: string;
}

type QueuedMessage = OptimisticAgentMessage;

/**
 * Headless agent-chat orchestration. Hosts own the visual presentation while
 * this hook owns lazy session creation, message sending, and cache refreshes.
 */
export function useAgentChat(
  projectId: string | undefined,
): UseAgentChatResult {
  const [activeSession, setActiveSession] = useState<{
    projectId: string | undefined;
    sessionId: string | null;
  }>({ projectId, sessionId: null });
  if (activeSession.projectId !== projectId) {
    setActiveSession({ projectId, sessionId: null });
  }
  const [sendInProgress, setSendInProgress] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticAgentMessage[]
  >([]);
  const activeSessionRef = useRef<{
    projectId: string | undefined;
    sessionId: string | null;
  }>({ projectId, sessionId: null });
  if (activeSessionRef.current.projectId !== projectId) {
    activeSessionRef.current = { projectId, sessionId: null };
  }
  const queueRef = useRef<QueuedMessage[]>([]);
  const processingRef = useRef(false);
  const sessionId =
    activeSession.projectId === projectId ? activeSession.sessionId : null;
  const queryClient = useQueryClient();
  const createSession = useCreateAgentSession(projectId);
  const sendMessage = useSendAgentMessage(projectId);
  const session = useAgentSession(projectId, sessionId ?? undefined, {
    refetchInterval: sendInProgress ? 500 : false,
  });

  const isSending =
    sendInProgress || createSession.isPending || sendMessage.isPending;
  const performSend = async (content: string) => {
    if (!projectId) return;

    const existingSessionId = activeSessionRef.current.sessionId;
    const targetSessionId =
      existingSessionId ?? (await createSession.mutateAsync({})).id;
    if (!existingSessionId) {
      activeSessionRef.current = { projectId, sessionId: targetSessionId };
      setActiveSession({ projectId, sessionId: targetSessionId });
    }

    await sendMessage.mutateAsync({
      sessionId: targetSessionId,
      message: content,
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
        const queued = queueRef.current[0];
        if (!queued) continue;
        try {
          await performSend(queued.content);
        } catch {
          // Mutation state exposes the error to consumers; continue draining.
        } finally {
          queueRef.current.shift();
          setOptimisticMessages((messages) =>
            messages.filter((message) => message.id !== queued.id),
          );
        }
      }
    } finally {
      processingRef.current = false;
      setSendInProgress(false);
    }
  };

  const send = (message: string) => {
    const content = message.trim();
    if (!content) return Promise.resolve();
    const optimistic = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content,
    };
    setOptimisticMessages((messages) => [...messages, optimistic]);
    queueRef.current.push(optimistic);
    void processQueue();
    return Promise.resolve();
  };

  return {
    sessionId,
    messages: session.data?.messages ?? [],
    optimisticMessages: reconcileOptimisticMessages(
      session.data?.messages ?? [],
      optimisticMessages,
    ),
    queuedMessageCount: queueRef.current.length,
    isLoading: session.isLoading,
    isSending,
    error: createSession.error ?? sendMessage.error ?? session.error ?? null,
    send,
    startNewSession: () => {
      if (!processingRef.current) {
        activeSessionRef.current = { projectId, sessionId: null };
        setActiveSession({ projectId, sessionId: null });
        setOptimisticMessages([]);
      }
    },
  };
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
