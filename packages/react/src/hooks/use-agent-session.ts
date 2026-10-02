"use client";

import {
  applySessionEvents,
  type Item,
  isWorking,
  type SessionSnapshot,
  type SessionState,
  type SessionStreamMessage,
  sessionStateFromSnapshot,
  withOlderItems,
} from "@catamorphic/agent-protocol";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { readSessionStream } from "../lib/session-stream.js";
import { useCatamorphic } from "../provider.js";
import type { AgentSessionDetail } from "../types.js";

/** A session's row: who owns it, where it runs, without the transcript. */
export type AgentSessionInfo = Omit<AgentSessionDetail, "snapshot">;

/** What the session cache holds: the row and the folded log. */
export interface AgentSessionData {
  info: AgentSessionInfo;
  state: SessionState;
}

/** The stream's health, for an honest status line. */
export type AgentSessionConnection =
  /** No session, or the stream is off. */
  | "idle"
  /** Opening the first connection. */
  | "connecting"
  /** Events arrive as they happen. */
  | "live"
  /** The connection dropped; resuming from the last applied event. */
  | "reconnecting";

export interface UseAgentSessionOptions {
  /** Stream live events (default true). Off: the snapshot only. */
  live?: boolean;
}

export interface UseAgentSessionResult {
  /**
   * The session row with its shared fields kept live from the log (title,
   * agent, model, todos); `running` follows the active turn.
   */
  session: AgentSessionInfo | null;
  /** The folded event log: select from it with the protocol's selectors. */
  state: SessionState | null;
  isLoading: boolean;
  error: CatamorphicError | null;
  connection: AgentSessionConnection;
  /** Older transcript exists before what is loaded. */
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** Load the page of items before the oldest loaded one. */
  loadOlder: () => Promise<void>;
}

export function agentSessionQueryKey(
  projectId: string | undefined,
  sessionId: string | undefined,
) {
  return ["cat", "project", projectId, "agent", "session", sessionId] as const;
}

/** How long to wait before reconnecting after `failures` failed attempts. */
export function reconnectDelayMs(failures: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, failures - 1));
}

/**
 * One agent session, live (ADR 0196): loads the snapshot, streams the
 * events after it, and folds them with the protocol's reducer. A dropped
 * stream resumes from the last applied sequence with backoff; a `reset`
 * replaces the state; a gap (the reducer marks the state stale) reloads
 * the snapshot. Every mounted reader of a session shares one cache entry.
 */
export function useAgentSession(
  projectId: string | undefined,
  sessionId: string | undefined,
  options: UseAgentSessionOptions = {},
): UseAgentSessionResult {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const queryKey = agentSessionQueryKey(projectId, sessionId);
  const enabled = Boolean(projectId && sessionId);
  const query = useQuery<AgentSessionData, CatamorphicError>({
    queryKey,
    queryFn: ({ signal }) =>
      runWithCatamorphicError(async () => {
        const detail: AgentSessionInfo & { snapshot: SessionSnapshot } =
          JSON.parse(
            assertApiOk(
              await apiClient.GET(
                "/api/projects/{projectId}/agent/sessions/{sessionId}",
                {
                  signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(15_000),
                  ]),
                  params: {
                    path: {
                      projectId: projectId ?? "",
                      sessionId: sessionId ?? "",
                    },
                  },
                  // The log's JSON is the protocol's own shape (the server
                  // validates it against the same types).
                  parseAs: "text",
                },
              ),
              "Agent session response empty",
            ),
          );
        const { snapshot, ...info } = detail;
        const fresh = sessionStateFromSnapshot(snapshot);
        const current = queryClient.getQueryData<AgentSessionData>(queryKey);
        return { info, state: mergeFresh(current?.state, fresh) };
      }),
    enabled,
    // The stream keeps it current; a refetch is a resync, not a poll.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchInterval: (current) => (current.state.error ? 3_000 : false),
  });

  const live = options.live ?? true;
  const loaded = query.data !== undefined;
  const stale = query.data?.state.stale === true;
  const [connection, setConnection] = useState<AgentSessionConnection>("idle");
  // Resync after a gap: one snapshot reload per stale episode.
  useEffect(() => {
    if (stale)
      void queryClient.invalidateQueries({
        queryKey: agentSessionQueryKey(projectId, sessionId),
        exact: true,
      });
  }, [stale, queryClient, projectId, sessionId]);

  useEffect(() => {
    if (!live || !loaded || !projectId || !sessionId) {
      setConnection("idle");
      return;
    }
    const controller = new AbortController();
    const key = agentSessionQueryKey(projectId, sessionId);
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sequence = () =>
      queryClient.getQueryData<AgentSessionData>(key)?.state.sequence;
    const connect = () => {
      const after = sequence();
      if (after === undefined || controller.signal.aborted) return;
      setConnection(failures === 0 ? "connecting" : "reconnecting");
      void readSessionStream({
        apiClient,
        projectId,
        sessionId,
        after,
        signal: controller.signal,
        onMessage: (message) => {
          failures = 0;
          setConnection("live");
          applyStreamMessage({ queryClient, key, message });
        },
      })
        .catch(() => undefined)
        .then(() => {
          if (controller.signal.aborted) return;
          // A clean end (the server closed a slow reader) resumes at once.
          failures += 1;
          setConnection("reconnecting");
          timer = setTimeout(connect, reconnectDelayMs(failures));
        });
    };
    connect();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [live, loaded, projectId, sessionId, apiClient, queryClient]);

  const [isLoadingOlder, setLoadingOlder] = useState(false);
  const olderRequest = useRef<Promise<void> | null>(null);
  const loadOlder = useCallback(async () => {
    if (!projectId || !sessionId) return;
    const key = agentSessionQueryKey(projectId, sessionId);
    const before =
      queryClient.getQueryData<AgentSessionData>(key)?.state.olderBefore;
    if (before === null || before === undefined) return;
    if (olderRequest.current) return olderRequest.current;
    setLoadingOlder(true);
    olderRequest.current = runWithCatamorphicError(async () => {
      const page: { items: Item[]; olderBefore: number | null } = JSON.parse(
        assertApiOk(
          await apiClient.GET(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/items",
            {
              signal: AbortSignal.timeout(15_000),
              params: { path: { projectId, sessionId }, query: { before } },
              parseAs: "text",
            },
          ),
          "Older messages response empty",
        ),
      );
      queryClient.setQueryData<AgentSessionData>(key, (current) =>
        current
          ? { ...current, state: withOlderItems(current.state, page) }
          : current,
      );
    }).finally(() => {
      olderRequest.current = null;
      setLoadingOlder(false);
    });
    return olderRequest.current;
  }, [apiClient, queryClient, projectId, sessionId]);

  const data = query.data;
  const working = data ? isWorking(data.state) : false;
  // Session lists show titles and running state; keep them in step.
  const listSignature = data
    ? `${data.state.session.title ?? ""}\u0000${working}`
    : null;
  const listSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = listSignatureRef.current;
    listSignatureRef.current = listSignature;
    if (!projectId || previous === null || previous === listSignature) return;
    void queryClient.invalidateQueries({
      queryKey: ["cat", "project", projectId, "agent", "sessions"],
    });
  }, [listSignature, projectId, queryClient]);

  return {
    session: data
      ? { ...data.info, ...data.state.session, running: working }
      : null,
    state: data?.state ?? null,
    isLoading: query.isLoading,
    error: query.error ?? null,
    connection: enabled ? connection : "idle",
    hasOlder: data ? data.state.olderBefore !== null : false,
    isLoadingOlder,
    loadOlder,
  };
}

/** Fold one stream message into the cached session. */
export function applyStreamMessage({
  queryClient,
  key,
  message,
}: {
  queryClient: QueryClient;
  key: readonly unknown[];
  message: SessionStreamMessage;
}): void {
  if (message.type === "heartbeat") return;
  queryClient.setQueryData<AgentSessionData>(key, (current) => {
    if (!current) return current;
    if (message.type === "reset")
      return {
        ...current,
        state: mergeFresh(
          current.state,
          sessionStateFromSnapshot(message.snapshot),
        ),
      };
    const state = applySessionEvents(current.state, message.events);
    return state === current.state ? current : { ...current, state };
  });
}

/**
 * A fresh snapshot replacing what the client holds: the newer of the two
 * wins, and older pages already loaded stay loaded.
 */
function mergeFresh(
  current: SessionState | undefined,
  fresh: SessionState,
): SessionState {
  if (!current) return fresh;
  if (!current.stale && current.sequence > fresh.sequence) return current;
  const freshFrom = fresh.olderBefore;
  if (freshFrom === null) return fresh;
  const older = current.items.filter((item) => item.position < freshFrom);
  if (older.length === 0) return fresh;
  return withOlderItems(fresh, {
    items: older,
    olderBefore:
      current.olderBefore === null || current.olderBefore < freshFrom
        ? current.olderBefore
        : freshFrom,
  });
}
