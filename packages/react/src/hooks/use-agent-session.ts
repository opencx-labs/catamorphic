"use client";

import {
  applySessionEvents,
  type Item,
  isSettledTurnStatus,
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
import { acquireStreamSlot, readSessionStream } from "../lib/session-stream.js";
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
  /**
   * Stream live events (default true). Off, or past the client's stream
   * limit, the snapshot is polled instead: every `pollIntervalMs` while a
   * turn is unsettled, and not at all while idle.
   */
  live?: boolean;
  /** Poll cadence while a turn is unsettled and nothing streams (default 1500). */
  pollIntervalMs?: number;
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
  const live = options.live ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  // Whether this reader holds a stream; one past the limit polls instead.
  const [streaming, setStreaming] = useState(false);
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
    refetchInterval: (current) => {
      if (current.state.error) return 3_000;
      if (streaming) return false;
      const data = current.state.data;
      // Poll while anything is unsettled: a turn running, waiting to
      // start, or waiting to retry.
      return data &&
        Object.values(data.state.turns).some(
          (turn) => !isSettledTurnStatus(turn.status),
        )
        ? pollIntervalMs
        : false;
    },
  });

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
      setStreaming(false);
      return;
    }
    const controller = new AbortController();
    const key = agentSessionQueryKey(projectId, sessionId);
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let slot: ReturnType<typeof acquireStreamSlot> | undefined;
    const sequence = () =>
      queryClient.getQueryData<AgentSessionData>(key)?.state.sequence;
    const start = () => {
      if (controller.signal.aborted) return;
      slot = acquireStreamSlot(apiClient, () => {
        // A slot freed: catch up, then stream from there.
        void queryClient
          .invalidateQueries({ queryKey: key, exact: true })
          .finally(start);
      });
      if (!slot.release) {
        setStreaming(false);
        setConnection("idle");
        return;
      }
      setStreaming(true);
      connect();
    };
    const connect = () => {
      const after = sequence();
      if (after === undefined || controller.signal.aborted) return;
      // One quick retry is not news; a second failure is.
      setConnection(
        failures === 0 ? "connecting" : failures > 1 ? "reconnecting" : "live",
      );
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
          // A clean end (the server closed a slow reader) resumes soon.
          failures += 1;
          if (failures > 1) setConnection("reconnecting");
          timer = setTimeout(connect, reconnectDelayMs(failures));
        });
    };
    start();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      slot?.cancel();
      if (slot?.release) {
        slot.release();
        // Events may have landed since the last one applied: whoever
        // reads next (a poll, another stream) starts from a fresh snapshot.
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
      setStreaming(false);
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
