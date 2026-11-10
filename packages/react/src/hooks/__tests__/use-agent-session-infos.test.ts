import { sessionStateFromSnapshot } from "@catamorphic/agent-protocol";
import { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  acquireStreamSlot,
  MAX_SESSION_STREAMS,
  streamSlotKey,
} from "../../lib/session-stream.js";
import {
  apiUrl,
  HttpResponse,
  http,
  TEST_API_BASE_URL,
} from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import {
  PROJECT_ID,
  SESSION_ID,
  sessionDetail,
  sessionFields,
  snapshot,
  sseStream,
  stored,
  turn,
} from "../../test/session-fixtures.js";
import {
  type AgentSessionData,
  agentSessionQueryKey,
  useAgentSession,
  useAgentSessionInfos,
} from "../use-agent-session.js";
import { useAgentSessions } from "../use-agent-sessions.js";

const SECOND_ID = "00000000-0000-4000-8000-000000000004";
const SECOND_PROJECT = "00000000-0000-4000-8000-000000000005";

function serveSession({
  projectId = PROJECT_ID,
  sessionId = SESSION_ID,
  title = "Older chat",
} = {}) {
  const base = `/api/projects/${projectId}/agent/sessions/${sessionId}`;
  const streams: Array<{
    stream: ReturnType<typeof sseStream>;
    signal: AbortSignal;
  }> = [];
  let snapshots = 0;
  let currentTitle = title;
  server.use(
    http.get(apiUrl(base), () => {
      snapshots += 1;
      return HttpResponse.json(
        sessionDetail(
          snapshot({
            sequence: 3,
            session: sessionFields({
              id: sessionId,
              projectId,
              title: currentTitle,
            }),
          }),
        ),
      );
    }),
    http.get(apiUrl(`${base}/events`), ({ request }) => {
      const stream = sseStream();
      streams.push({ stream, signal: request.signal });
      return stream.response();
    }),
  );
  return {
    streams,
    snapshots: () => snapshots,
    rename: (value: string) => {
      currentTitle = value;
    },
  };
}

function rename(
  stream: ReturnType<typeof sseStream> | undefined,
  title: string,
) {
  stream?.send({
    type: "events",
    events: [stored(4, { type: "session.changed", session: { title } })],
  });
}

describe("useAgentSessionInfos", () => {
  it("reads an older canonical cached session outside the recent list, merging its live fields and running state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const snap = snapshot({
      session: sessionFields({ title: "Canonical older title" }),
      turns: [turn("running", 1, { status: "running" })],
    });
    const { snapshot: _, ...info } = sessionDetail(snap);
    queryClient.setQueryData<AgentSessionData>(
      agentSessionQueryKey(PROJECT_ID, SESSION_ID),
      {
        info: { ...info, title: "Stale row title" },
        state: sessionStateFromSnapshot(snap),
      },
    );
    server.use(
      http.get(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json({ items: [], total: 101 }),
      ),
    );
    const view = renderHookWithProviders(
      () => ({
        recent: useAgentSessions(PROJECT_ID, {
          limit: 100,
          refetchInterval: false,
        }),
        open: useAgentSessionInfos(PROJECT_ID, [SESSION_ID, SESSION_ID]),
      }),
      { queryClient },
    );
    try {
      expect(view.result.current.open.sessions).toHaveLength(1);
      expect(view.result.current.open.sessions[0]).toMatchObject({
        id: SESSION_ID,
        title: "Canonical older title",
        running: true,
      });
      await waitFor(() =>
        expect(view.result.current.recent.data?.items).toEqual([]),
      );
      expect(view.result.current.open.error).toBeNull();
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("shares its snapshot and stream with the chat and follows live renames", async () => {
    const served = serveSession();
    const { result, rerender } = renderHookWithProviders(
      ({ chatLive }: { chatLive: boolean }) => ({
        chat: useAgentSession(PROJECT_ID, SESSION_ID, { live: chatLive }),
        open: useAgentSessionInfos(PROJECT_ID, [SESSION_ID], { live: true }),
        second: useAgentSessionInfos(PROJECT_ID, [SESSION_ID], {
          live: true,
        }),
      }),
      { initialProps: { chatLive: true } },
    );
    await waitFor(() => expect(result.current.chat.connection).toBe("live"));
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(1);
    rerender({ chatLive: false });
    act(() => rename(served.streams[0]?.stream, "Renamed while unfocused"));
    await waitFor(() =>
      expect(result.current.open.sessions[0]?.title).toBe(
        "Renamed while unfocused",
      ),
    );
    expect(result.current.second.sessions[0]?.title).toBe(
      "Renamed while unfocused",
    );
    expect(result.current.chat.session?.title).toBe("Renamed while unfocused");
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(1);
  });

  it("keeps existing leases when IDs change and releases removed sessions and the final unmount", async () => {
    const first = serveSession();
    const second = serveSession({ sessionId: SECOND_ID });
    const view = renderHookWithProviders(
      ({ ids, live }: { ids: string[]; live: boolean }) =>
        useAgentSessionInfos(PROJECT_ID, ids, { live }),
      { initialProps: { ids: [SESSION_ID], live: true } },
    );
    await waitFor(() => expect(first.streams).toHaveLength(1));
    view.rerender({ ids: [SECOND_ID, SESSION_ID, SESSION_ID], live: true });
    await waitFor(() => expect(second.streams).toHaveLength(1));
    expect(first.streams).toHaveLength(1);
    expect(first.streams[0]?.signal.aborted).toBe(false);
    expect(view.result.current.sessions.map((session) => session.id)).toEqual([
      SECOND_ID,
      SESSION_ID,
    ]);
    view.rerender({ ids: [SESSION_ID], live: true });
    await waitFor(() => expect(second.streams[0]?.signal.aborted).toBe(true));
    expect(first.streams).toHaveLength(1);
    view.rerender({ ids: [SESSION_ID], live: false });
    await waitFor(() => expect(first.streams[0]?.signal.aborted).toBe(true));
    view.rerender({ ids: [SESSION_ID], live: true });
    await waitFor(() => expect(first.streams).toHaveLength(2));
    expect(first.snapshots()).toBe(1);
    view.unmount();
    await waitFor(() => expect(first.streams[1]?.signal.aborted).toBe(true));
  });

  it("scopes snapshots and leases by project for the same session ID", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const first = serveSession({ title: "First project" });
    const second = serveSession({
      projectId: SECOND_PROJECT,
      title: "Second project",
    });
    const { result, rerender, unmount } = renderHookWithProviders(
      ({ projectId }: { projectId: string }) =>
        useAgentSessionInfos(projectId, [SESSION_ID], { live: true }),
      { queryClient, initialProps: { projectId: PROJECT_ID } },
    );
    await waitFor(() => expect(first.streams).toHaveLength(1));
    rerender({ projectId: SECOND_PROJECT });
    await waitFor(() =>
      expect(result.current.sessions[0]?.title).toBe("Second project"),
    );
    expect(first.streams[0]?.signal.aborted).toBe(true);
    await waitFor(() => expect(second.streams).toHaveLength(1));
    rerender({ projectId: PROJECT_ID });
    await waitFor(() => expect(first.streams).toHaveLength(2));
    expect(result.current.sessions[0]?.title).toBe("First project");
    expect(second.streams[0]?.signal.aborted).toBe(true);
    expect(first.snapshots()).toBe(1);
    expect(second.snapshots()).toBe(1);
    unmount();
    queryClient.clear();
  });

  it("polls while stream slots are full, then shares the existing queued-stream recovery", async () => {
    const served = serveSession();
    const slots = Array.from({ length: MAX_SESSION_STREAMS }, () =>
      acquireStreamSlot(streamSlotKey(TEST_API_BASE_URL), () => {}),
    );
    const view = renderHookWithProviders(() =>
      useAgentSessionInfos(PROJECT_ID, [SESSION_ID], {
        live: true,
        pollIntervalMs: 25,
      }),
    );
    try {
      await waitFor(() =>
        expect(view.result.current.sessions[0]?.title).toBe("Older chat"),
      );
      expect(served.streams).toHaveLength(0);
      served.rename("Changed while waiting for a slot");
      await waitFor(() =>
        expect(view.result.current.sessions[0]?.title).toBe(
          "Changed while waiting for a slot",
        ),
      );
      act(() => slots[0]?.release());
      await waitFor(() => expect(served.streams).toHaveLength(1));
      expect(view.result.current.error).toBeNull();
    } finally {
      view.unmount();
      for (const slot of slots) slot.release();
    }
  });

  it("keeps more retained chats than stream slots dormant and follows only the visible intersection without reconnecting remaining chats", async () => {
    const ids = [
      SESSION_ID,
      SECOND_ID,
      ...Array.from({ length: MAX_SESSION_STREAMS }, (_, i) => `dormant-${i}`),
    ];
    const served = ids.map((sessionId) => serveSession({ sessionId }));
    const view = renderHookWithProviders(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        useAgentSessionInfos(PROJECT_ID, ids, {
          live: true,
          liveSessionIds,
          pollIntervalMs: 25,
        }),
      { initialProps: { liveSessionIds: [] } },
    );
    try {
      await waitFor(() =>
        expect(view.result.current.sessions).toHaveLength(ids.length),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(served.map((session) => session.snapshots())).toEqual(
        ids.map(() => 1),
      );
      expect(served.map((session) => session.streams.length)).toEqual(
        ids.map(() => 0),
      );
      // A visible ID outside the requested set must not create a reader.
      view.rerender({
        liveSessionIds: [SESSION_ID, SECOND_ID, "outside-the-open-set"],
      });
      await waitFor(() => expect(served[1]?.streams).toHaveLength(1));
      expect(served[0]?.streams).toHaveLength(1);
      const replacement = ids[2] ?? "";
      view.rerender({ liveSessionIds: [SECOND_ID, replacement] });
      await waitFor(() => expect(served[2]?.streams).toHaveLength(1));
      expect(served[0]?.streams[0]?.signal.aborted).toBe(true);
      expect(served[1]?.streams).toHaveLength(1);
      expect(served[1]?.streams[0]?.signal.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(served.map((session) => session.snapshots())).toEqual(
        ids.map(() => 1),
      );
      expect(
        served.slice(3).every((session) => session.streams.length === 0),
      ).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("makes no requests without a project or session IDs", () => {
    const { result } = renderHookWithProviders(() => ({
      noProject: useAgentSessionInfos(undefined, [SESSION_ID]),
      noSessions: useAgentSessionInfos(PROJECT_ID, []),
    }));
    expect(result.current.noProject).toEqual({
      sessions: [],
      isLoading: false,
      error: null,
    });
    expect(result.current.noSessions).toEqual(result.current.noProject);
  });
});
