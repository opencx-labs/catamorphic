import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  acquireStreamSlot,
  MAX_SESSION_STREAMS,
  streamSlotKey,
} from "../../lib/session-stream.js";
import { CatamorphicProvider } from "../../provider.js";
import {
  apiUrl,
  HttpResponse,
  http,
  TEST_API_BASE_URL,
} from "../../test/handlers.js";
import {
  createTestApiClient,
  renderHookWithProviders,
} from "../../test/render.js";
import { server } from "../../test/server.js";
import {
  PROJECT_ID,
  SESSION_ID,
  sessionDetail,
  sessionFields,
  snapshot,
  sseStream,
  stored,
} from "../../test/session-fixtures.js";
import {
  useAgentSession,
  useAgentSessionFields,
} from "../use-agent-session.js";

const BASE = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`;
const pullRequests = [
  { url: "https://github.com/acme/web/pull/5", number: 5, state: "open" },
];

/** Serve one session, counting snapshot loads and stream connections. */
function serve() {
  const streams: Array<ReturnType<typeof sseStream>> = [];
  let snapshots = 0;
  const cursors: number[] = [];
  server.use(
    http.get(apiUrl(BASE), () => {
      snapshots += 1;
      return HttpResponse.json(
        sessionDetail(
          snapshot({
            sequence: 3,
            session: sessionFields({ metadata: { note: "first" } }),
          }),
        ),
      );
    }),
    http.get(apiUrl(`${BASE}/events`), ({ request }) => {
      cursors.push(Number(new URL(request.url).searchParams.get("after")));
      const stream = sseStream();
      streams.push(stream);
      return stream.response();
    }),
  );
  return { streams, cursors, snapshots: () => snapshots };
}

describe("useAgentSessionFields (ADR 0226)", () => {
  it("shares one stream across live field readers and a retained chat, resuming without snapshots", async () => {
    const served = serve();
    const { result, rerender } = renderHookWithProviders(
      ({ live, chat }: { live: boolean; chat: boolean }) => ({
        conversation: useAgentSession(PROJECT_ID, SESSION_ID, { live: chat }),
        first: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live }),
        second: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live }),
        third: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live }),
        fourth: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live }),
      }),
      { initialProps: { live: true, chat: true } },
    );
    await waitFor(() =>
      expect(result.current.conversation.connection).toBe("live"),
    );
    expect(served.streams).toHaveLength(1);
    expect(served.snapshots()).toBe(1);
    const change = (sequence: number, note: string) => ({
      type: "events",
      events: [
        stored(sequence, {
          type: "session.changed",
          session: { metadata: { note } },
        }),
      ],
    });
    act(() => served.streams[0]?.send(change(4, "external metadata")));
    await waitFor(() =>
      expect(result.current.fourth.fields?.metadata).toEqual({
        note: "external metadata",
      }),
    );
    expect(result.current.conversation.session?.metadata).toEqual({
      note: "external metadata",
    });
    expect(result.current.first.fields).toEqual(result.current.fourth.fields);
    // The chat can leave while its context readers still need current fields.
    rerender({ live: true, chat: false });
    act(() => served.streams[0]?.send(change(5, "while the chat is away")));
    await waitFor(() =>
      expect(result.current.second.fields?.metadata).toEqual({
        note: "while the chat is away",
      }),
    );
    rerender({ live: true, chat: true });
    expect(served.streams).toHaveLength(1);
    expect(served.snapshots()).toBe(1);
    // With every live lease gone, events stop; the retained cache survives.
    rerender({ live: false, chat: false });
    const state = result.current.conversation.state;
    act(() => served.streams[0]?.send(change(6, "not observed")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.conversation.state).toBe(state);
    rerender({ live: true, chat: true });
    await waitFor(() => expect(served.streams).toHaveLength(2));
    expect(served.cursors).toEqual([3, 5]);
    expect(served.snapshots()).toBe(1);
    // A dropped shared stream gets one reconnect loop, from that same cursor.
    act(() => served.streams[1]?.close());
    await waitFor(() => expect(served.streams).toHaveLength(3));
    expect(served.cursors).toEqual([3, 5, 5]);
    expect(served.snapshots()).toBe(1);
    act(() => served.streams[2]?.send(change(6, "resumed")));
    await waitFor(() =>
      expect(result.current.third.fields?.metadata).toEqual({
        note: "resumed",
      }),
    );
  });

  it("releases the final observer and reuses its cached history when remounted", async () => {
    const served = serve();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const apiClient = createTestApiClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(CatamorphicProvider, { apiClient, queryClient, children });
    const read = () => ({
      conversation: useAgentSession(PROJECT_ID, SESSION_ID),
      fields: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live: true }),
    });
    const first = renderHook(read, { wrapper });
    await waitFor(() =>
      expect(first.result.current.conversation.connection).toBe("live"),
    );
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(4, {
            type: "session.changed",
            session: { title: "Retained" },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(first.result.current.fields.fields?.title).toBe("Retained"),
    );
    first.unmount();
    const second = renderHook(read, { wrapper });
    try {
      await waitFor(() => expect(served.streams).toHaveLength(2));
      expect(served.snapshots()).toBe(1);
      expect(served.cursors).toEqual([3, 4]);
      expect(second.result.current.conversation.session?.title).toBe(
        "Retained",
      );
      expect(second.result.current.fields.fields?.title).toBe("Retained");
    } finally {
      second.unmount();
      queryClient.clear();
    }
  });

  it("queues one session lease and catches up once when a real stream slot frees", async () => {
    const served = serve();
    const slots = Array.from({ length: MAX_SESSION_STREAMS }, () =>
      acquireStreamSlot(streamSlotKey(TEST_API_BASE_URL), () => {}),
    );
    const view = renderHookWithProviders(() => ({
      conversation: useAgentSession(PROJECT_ID, SESSION_ID),
      first: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live: true }),
      second: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live: true }),
    }));
    try {
      await waitFor(() =>
        expect(view.result.current.second.fields).not.toBeNull(),
      );
      expect(served.snapshots()).toBe(1);
      expect(served.streams).toHaveLength(0);
      act(() => slots[0]?.release());
      await waitFor(() =>
        expect(view.result.current.conversation.connection).toBe("live"),
      );
      expect(served.streams).toHaveLength(1);
      expect(served.snapshots()).toBe(2);
    } finally {
      view.unmount();
      for (const slot of slots) slot.release();
    }
  });

  it("shares a permanent refusal without reconnecting once per observer", async () => {
    serve();
    let connections = 0;
    server.use(
      http.get(apiUrl(`${BASE}/events`), () => {
        connections += 1;
        return HttpResponse.json({ error: "Access removed" }, { status: 403 });
      }),
    );
    const { result } = renderHookWithProviders(() => ({
      conversation: useAgentSession(PROJECT_ID, SESSION_ID),
      first: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live: true }),
      second: useAgentSessionFields(PROJECT_ID, SESSION_ID, { live: true }),
    }));
    await waitFor(() => expect(result.current.second.error?.status).toBe(403));
    expect(result.current.conversation.error).toBe(result.current.first.error);
    expect(result.current.first.error).toBe(result.current.second.error);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(connections).toBe(1);
  });

  it("follows what the conversation's live reader folds, without a stream of its own", async () => {
    const served = serve();
    const { result } = renderHookWithProviders(() => ({
      live: useAgentSession(PROJECT_ID, SESSION_ID),
      beside: useAgentSessionFields(PROJECT_ID, SESSION_ID),
    }));
    await waitFor(() => expect(served.streams).toHaveLength(1));
    expect(result.current.beside.fields?.metadata).toEqual({ note: "first" });
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(4, {
            type: "session.changed",
            session: { metadata: { pull_requests: pullRequests } },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.beside.fields?.metadata).toEqual({
        pull_requests: pullRequests,
      }),
    );
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(1);
  });

  it("loads once on its own and never streams unless live", async () => {
    const served = serve();
    const { result } = renderHookWithProviders(() =>
      useAgentSessionFields(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() =>
      expect(result.current.fields?.metadata).toEqual({ note: "first" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(served.snapshots()).toBe(1);
    expect(served.streams).toHaveLength(0);
  });

  it("follows the session itself while live, as a section on screen does", async () => {
    const served = serve();
    const { result, rerender } = renderHookWithProviders(
      ({ live }: { live: boolean }) =>
        useAgentSessionFields(PROJECT_ID, SESSION_ID, { live }),
      { initialProps: { live: true } },
    );
    // No conversation reader is mounted: a change made outside any turn
    // (another client's PATCH, a workflow) still arrives.
    await waitFor(() => expect(served.streams).toHaveLength(1));
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(4, {
            type: "session.changed",
            session: { metadata: { pull_requests: pullRequests } },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.fields?.metadata).toEqual({
        pull_requests: pullRequests,
      }),
    );
    // Off screen it lets the stream go and opens no other.
    rerender({ live: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(5, {
            type: "session.changed",
            session: { metadata: { note: "unseen" } },
          }),
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(served.streams).toHaveLength(1);
    expect(result.current.fields?.metadata).toEqual({
      pull_requests: pullRequests,
    });
  });

  it("retains a settled chat across tab switches and resumes from its applied sequence", async () => {
    const served = serve();
    const { result, rerender } = renderHookWithProviders(
      ({ live }: { live: boolean }) =>
        useAgentSession(PROJECT_ID, SESSION_ID, { live }),
      { initialProps: { live: true } },
    );
    await waitFor(() => expect(served.streams).toHaveLength(1));
    act(() =>
      served.streams[0]?.send({
        type: "events",
        events: [
          stored(4, {
            type: "session.changed",
            session: { title: "Kept while away" },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.session?.title).toBe("Kept while away"),
    );
    const state = result.current.state;
    rerender({ live: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(served.snapshots()).toBe(1);
    expect(result.current.state).toBe(state);
    rerender({ live: true });
    await waitFor(() => expect(served.streams).toHaveLength(2));
    expect(served.snapshots()).toBe(1);
    expect(result.current.state?.sequence).toBe(4);
    act(() =>
      served.streams[1]?.send({
        type: "events",
        events: [
          stored(5, {
            type: "session.changed",
            session: { title: "Caught up" },
          }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.session?.title).toBe("Caught up"),
    );
  });

  it("reads nothing without a session", () => {
    const served = serve();
    const { result } = renderHookWithProviders(() =>
      useAgentSessionFields(PROJECT_ID, undefined),
    );
    expect(result.current.fields).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(served.snapshots()).toBe(0);
  });
});
