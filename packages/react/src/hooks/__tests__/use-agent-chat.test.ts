import type { SessionSnapshot } from "@catamorphic/agent-protocol";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import {
  PROJECT_ID,
  reply,
  SESSION_ID,
  sessionDetail,
  snapshot,
  sseStream,
  stored,
  turn,
  userMessage,
} from "../../test/session-fixtures.js";
import { useAgentChat } from "../use-agent-chat.js";
import { useAgentSession } from "../use-agent-session.js";

const BASE = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`;

/** A snapshot of one settled turn: "Hello" answered with "Hi". */
function settledSnapshot(): SessionSnapshot {
  return snapshot({
    sequence: 4,
    turns: [turn("t1", 1)],
    items: [
      userMessage("t1:input", 1, "t1", "Hello"),
      reply("r1", 2, "t1", "Hi"),
    ],
  });
}

/**
 * Serve a session: its snapshot (replaceable), and an event stream per
 * connection, recording the cursor each connection asked from.
 */
function serveSession(initial: SessionSnapshot) {
  let current = initial;
  const streams: Array<ReturnType<typeof sseStream>> = [];
  const cursors: number[] = [];
  let snapshots = 0;
  server.use(
    http.get(apiUrl(BASE), () => {
      snapshots += 1;
      return HttpResponse.json(sessionDetail(current));
    }),
    http.get(apiUrl(`${BASE}/events`), ({ request }) => {
      cursors.push(Number(new URL(request.url).searchParams.get("after")));
      const stream = sseStream();
      streams.push(stream);
      return stream.response();
    }),
  );
  return {
    streams,
    cursors,
    snapshots: () => snapshots,
    setSnapshot(next: SessionSnapshot) {
      current = next;
    },
    latest: () => streams.at(-1),
  };
}

describe("useAgentSession", () => {
  it("loads the snapshot and folds streamed events from its sequence", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    expect(result.current.timeline).toHaveLength(1);
    act(() =>
      served.latest()?.send({
        type: "events",
        events: [
          stored(5, {
            type: "turn.changed",
            turn: turn("t2", 2, { status: "running", activity: "Reading" }),
          }),
          stored(6, {
            type: "item.added",
            item: userMessage("t2:input", 5, "t2", "And now?"),
          }),
          stored(7, {
            type: "item.added",
            item: { ...reply("r2", 7, "t2", "Wor"), status: "in_progress" },
          }),
          stored(8, {
            type: "item.text_appended",
            itemId: "r2",
            field: "text",
            text: "king",
            at: new Date().toISOString(),
          }),
        ],
      }),
    );
    await waitFor(() => expect(result.current.isWorking).toBe(true));
    expect(result.current.activity).toBe("Reading");
    const latest = result.current.timeline.at(-1);
    expect(latest?.turn?.id).toBe("t2");
    expect(latest?.entries.map((entry) => entry.kind)).toEqual([
      "input",
      "reply",
    ]);
    const answer = latest?.entries[1];
    expect(answer?.kind === "reply" && answer.item.text).toBe("Working");
    expect(result.current.state?.sequence).toBe(8);
  });

  it("reconnects from the last applied sequence after the stream drops", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    act(() =>
      served.latest()?.send({
        type: "events",
        events: [
          stored(5, {
            type: "session.changed",
            session: { title: "Renamed" },
          }),
        ],
      }),
    );
    await waitFor(() => expect(result.current.session?.title).toBe("Renamed"));
    act(() => served.latest()?.close());
    await waitFor(() => expect(served.cursors).toEqual([4, 5]), {
      timeout: 3_000,
    });
    // Resuming is not a resync: no second snapshot was needed.
    expect(served.snapshots()).toBe(1);
  });

  it("replaces its state when the stream sends a reset", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    act(() =>
      served.latest()?.send({
        type: "reset",
        snapshot: snapshot({
          sequence: 900,
          turns: [turn("t9", 9)],
          items: [
            userMessage("t9:input", 800, "t9", "Much later"),
            reply("r9", 801, "t9", "Caught up"),
          ],
          olderBefore: 800,
        }),
      }),
    );
    await waitFor(() => expect(result.current.state?.sequence).toBe(900));
    expect(result.current.timeline.map((entry) => entry.key)).toEqual([
      "t1",
      "t9",
    ]);
  });

  it("reloads the snapshot when it sees a gap in the events", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    served.setSnapshot(
      snapshot({
        sequence: 12,
        session: { ...settledSnapshot().session, title: "From the snapshot" },
        turns: [turn("t1", 1)],
        items: settledSnapshot().items,
      }),
    );
    act(() =>
      served.latest()?.send({
        type: "events",
        events: [
          stored(9, { type: "session.changed", session: { title: "Skipped" } }),
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.session?.title).toBe("From the snapshot"),
    );
    expect(result.current.state?.stale).toBe(false);
    expect(served.snapshots()).toBe(2);
    // It streams again from the fresh snapshot, so what was sent while it
    // loaded arrives again instead of opening another gap.
    await waitFor(() => expect(served.cursors).toEqual([4, 12]));
    act(() =>
      served.latest()?.send({
        type: "events",
        events: [
          stored(13, { type: "session.changed", session: { title: "Live" } }),
        ],
      }),
    );
    await waitFor(() => expect(result.current.session?.title).toBe("Live"));
    expect(result.current.state?.sequence).toBe(13);
    expect(served.snapshots()).toBe(2);
  });

  it("ignores what the old stream sends once it saw a gap", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    const first = served.latest();
    served.setSnapshot(snapshot({ ...settledSnapshot(), sequence: 10 }));
    act(() =>
      first?.send({
        type: "events",
        events: [
          stored(9, { type: "session.changed", session: { title: "Gap" } }),
        ],
      }),
    );
    await waitFor(() => expect(served.cursors).toEqual([4, 10]));
    // The resumed stream replays 11 onward; the abandoned one is not read.
    act(() => {
      first?.send({
        type: "events",
        events: [
          stored(11, { type: "session.changed", session: { title: "Old" } }),
        ],
      });
      served.latest()?.send({
        type: "events",
        events: [
          stored(11, { type: "session.changed", session: { title: "New" } }),
          stored(12, { type: "session.changed", session: { icon: "bolt" } }),
        ],
      });
    });
    await waitFor(() => expect(result.current.state?.sequence).toBe(12));
    expect(result.current.session?.title).toBe("New");
    expect(result.current.state?.stale).toBe(false);
  });

  it("reads as live as soon as the stream opens", async () => {
    const served = serveSession(settledSnapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    // Nothing was sent: an idle chat is still connected.
    await waitFor(() => expect(result.current.connection).toBe("live"));
  });

  it("stops and says why when the stream is refused", async () => {
    const served = serveSession(settledSnapshot());
    let attempts = 0;
    server.use(
      http.get(apiUrl(`${BASE}/events`), () => {
        attempts += 1;
        return HttpResponse.json(
          { error: "Session not found" },
          { status: 404 },
        );
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
    expect(result.current.error?.message).toBe("Session not found");
    expect(result.current.connection).toBe("idle");
    expect(result.current.connectionLost).toBe(false);
    // Past the first reconnect delays: it did not try again.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(attempts).toBe(1);
    expect(served.snapshots()).toBe(1);
  });

  it("keeps reconnecting after a rate limit", async () => {
    serveSession(settledSnapshot());
    let attempts = 0;
    server.use(
      http.get(apiUrl(`${BASE}/events`), () => {
        attempts += 1;
        return HttpResponse.json({ error: "Slow down" }, { status: 429 });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), {
      timeout: 3_000,
    });
    expect(result.current.error).toBeNull();
  });

  it("pages older items into the state", async () => {
    serveSession(
      snapshot({
        sequence: 50,
        turns: [turn("t1", 1), turn("t2", 2)],
        items: [
          userMessage("t2:input", 40, "t2", "Recent"),
          reply("r2", 41, "t2", "Recent answer"),
        ],
        olderBefore: 40,
      }),
    );
    server.use(
      http.get(apiUrl(`${BASE}/items`), ({ request }) => {
        expect(new URL(request.url).searchParams.get("before")).toBe("40");
        return HttpResponse.json({
          items: [
            userMessage("t1:input", 1, "t1", "First"),
            reply("r1", 2, "t1", "First answer"),
          ],
          olderBefore: null,
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.hasOlder).toBe(true));
    await act(() => result.current.loadOlder());
    expect(result.current.hasOlder).toBe(false);
    expect(
      result.current.timeline.map((entry) => entry.entries.length),
    ).toEqual([2, 2]);
  });
});

describe("useAgentChat commands", () => {
  it("shows a sent message at once and reconciles it with its item", async () => {
    const served = serveSession(settledSnapshot());
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json({
          commandId: body.commandId,
          status: "accepted",
          sequence: 6,
          result: { itemId: "m2", turnId: "t2", mode: "queue" },
          error: null,
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(served.cursors).toEqual([4]));
    let sending: Promise<unknown> | undefined;
    act(() => {
      sending = result.current.send("Second question");
    });
    expect(result.current.pending.map((message) => message.text)).toEqual([
      "Second question",
    ]);
    await act(async () => {
      await sending;
    });
    expect(bodies[0]).toMatchObject({ type: "send", text: "Second question" });
    expect(typeof bodies[0]?.commandId).toBe("string");
    expect(result.current.pending[0]?.status).toBe("sent");
    act(() =>
      served.latest()?.send({
        type: "events",
        events: [
          stored(5, {
            type: "turn.changed",
            turn: turn("t2", 2, { status: "queued", inputItemId: "m2" }),
          }),
          stored(6, {
            type: "item.added",
            item: userMessage("m2", 6, "t2", "Second question", {
              idempotencyKey: `user:test-user:${String(bodies[0]?.commandId)}`,
            }),
          }),
        ],
      }),
    );
    await waitFor(() => expect(result.current.pending).toEqual([]));
    // Nothing runs, so the turn about to start reads in the conversation,
    // not as queued.
    expect(result.current.queue).toEqual([]);
    expect(result.current.startingTurn?.id).toBe("t2");
    expect(result.current.timeline.at(-1)?.entries[0]).toMatchObject({
      kind: "input",
      item: { text: "Second question" },
    });
    expect(result.current.activity).toBe("Waiting for agent");
  });

  it("resends the same command id after a server error", async () => {
    serveSession(settledSnapshot());
    const ids: unknown[] = [];
    server.use(
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        ids.push(body.commandId);
        if (ids.length === 1)
          return HttpResponse.json({ error: "Busy" }, { status: 503 });
        return HttpResponse.json({
          commandId: body.commandId,
          status: "accepted",
          sequence: 5,
          result: {},
          error: null,
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await act(async () => {
      await result.current.interrupt();
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(result.current.error).toBeNull();
  });

  it("shows a refused command's message", async () => {
    serveSession(settledSnapshot());
    server.use(
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          commandId: body.commandId,
          status: "rejected",
          sequence: 4,
          result: null,
          error: {
            code: "already_answered",
            message: "That request was already answered or withdrawn.",
          },
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.state).not.toBeNull());
    let answered: boolean | undefined;
    await act(async () => {
      answered = await result.current.respond("q1", {
        kind: "question",
        answers: ["Grid"],
      });
    });
    expect(answered).toBe(false);
    expect(result.current.error?.message).toBe(
      "That request was already answered or withdrawn.",
    );
  });

  it("sends queue, retry and rollback commands for the turns it names", async () => {
    serveSession(
      snapshot({
        sequence: 9,
        turns: [
          turn("t1", 1, {
            status: "failed",
            error: { message: "Provider down" },
          }),
          turn("t2", 2, { status: "queued" }),
          turn("t3", 3, { status: "running" }),
        ],
        items: [
          userMessage("t1:input", 1, "t1", "Hello"),
          userMessage("t2:input", 3, "t2", "Queued text"),
          userMessage("t3:input", 4, "t3", "Running"),
        ],
      }),
    );
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json({
          commandId: body.commandId,
          status: "accepted",
          sequence: 10,
          result: {},
          error: null,
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    await act(async () => {
      await result.current.holdQueued("t2");
      await result.current.editQueued("t2", "Edited");
      await result.current.sendQueuedNow("t2");
      await result.current.cancelQueued("t2");
      await result.current.retry();
      await result.current.rollback("t1");
      await result.current.interrupt();
      // A turn waiting to retry is stopped by name, not the running one.
      await result.current.interrupt("t1");
    });
    expect(
      bodies.map(({ commandId: _commandId, ...command }) => command),
    ).toEqual([
      { type: "edit_queued", turnId: "t2", held: true },
      { type: "edit_queued", turnId: "t2", text: "Edited", held: false },
      { type: "send_now", turnId: "t2" },
      { type: "cancel_queued", turnId: "t2" },
      { type: "retry", turnId: "t1" },
      { type: "rollback", turnId: "t1" },
      { type: "interrupt", turnId: "t3" },
      { type: "interrupt", turnId: "t1" },
    ]);
    expect(new Set(bodies.map((body) => body.commandId)).size).toBe(8);
  });

  it("creates the session on the first message", async () => {
    const created: string[] = [];
    server.use(
      http.post(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`),
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            agentId: "assistant",
            source: "mobile",
          });
          return HttpResponse.json(sessionDetail(snapshot()), { status: 201 });
        },
      ),
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          commandId: body.commandId,
          status: "accepted",
          sequence: 2,
          result: { itemId: "m1" },
          error: null,
        });
      }),
    );
    serveSession(snapshot());
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, {
        agentId: "assistant",
        source: "mobile",
        onSessionCreated: (id) => created.push(id),
      }),
    );
    expect(result.current.sessionId).toBeNull();
    await act(async () => {
      await result.current.send("Start");
    });
    expect(created).toEqual([SESSION_ID]);
    expect(result.current.sessionId).toBe(SESSION_ID);
    expect(result.current.pending[0]).toMatchObject({
      text: "Start",
      status: "sent",
      itemId: "m1",
    });
  });

  it("keeps a failed send with its command id for resending", async () => {
    serveSession(settledSnapshot());
    const ids: unknown[] = [];
    let fail = true;
    server.use(
      http.post(apiUrl(`${BASE}/commands`), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        ids.push(body.commandId);
        if (fail)
          return HttpResponse.json({ error: "Forbidden" }, { status: 403 });
        return HttpResponse.json({
          commandId: body.commandId,
          status: "accepted",
          sequence: 5,
          result: {},
          error: null,
        });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await act(async () => {
      await result.current.send("Try me");
    });
    const failed = result.current.pending[0];
    expect(failed?.status).toBe("failed");
    fail = false;
    await act(async () => {
      await result.current.resendFailed(failed?.commandId ?? "");
    });
    expect(ids).toEqual([failed?.commandId, failed?.commandId]);
    expect(result.current.pending[0]?.status).toBe("sent");
  });
});
