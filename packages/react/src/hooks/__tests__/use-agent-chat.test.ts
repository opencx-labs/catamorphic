import { ATTACHMENT_MARKER } from "@catamorphic/sandbox/attachments";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useAgentChat } from "../use-agent-chat.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_ID = "00000000-0000-4000-8000-000000000003";

const session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  externalUserId: "test-user",
  provider: "ai-sdk",
  providerSessionId: "provider-session",
  sandboxId: null,
  title: null,
  status: "active" as const,
  baseCommitSha: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("useAgentChat", () => {
  it("sends on plain-HTTP origins where crypto.randomUUID is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    let sends = 0;
    try {
      server.use(
        http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
          HttpResponse.json(session, { status: 201 }),
        ),
        http.post(
          apiUrl(
            `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
          ),
          () => {
            sends += 1;
            return HttpResponse.json(
              {
                id: "00000000-0000-4000-8000-000000000004",
                sessionId: SESSION_ID,
                role: "assistant",
                content: "Done",
                commitSha: null,
                metadata: null,
                createdAt: new Date().toISOString(),
              },
              { status: 201 },
            );
          },
        ),
        http.get(
          apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
          () => HttpResponse.json({ ...session, messages: [] }),
        ),
      );
      const { result } = renderHookWithProviders(() =>
        useAgentChat(PROJECT_ID),
      );

      await act(() => result.current.send("Hello from the LAN"));

      await waitFor(() => expect(sends).toBe(1));
    } finally {
      if (descriptor) {
        Object.defineProperty(crypto, "randomUUID", descriptor);
      } else {
        Reflect.deleteProperty(crypto, "randomUUID");
      }
    }
  });

  it("creates one session lazily and reuses it", async () => {
    let creates = 0;
    let sends = 0;
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () => {
        creates += 1;
        return HttpResponse.json(session, { status: 201 });
      }),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () => {
          sends += 1;
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));

    await act(() => result.current.send("First"));
    await act(() => result.current.send("Second"));

    expect(creates).toBe(1);
    expect(sends).toBe(2);
    expect(result.current.sessionId).toBe(SESSION_ID);
  });

  it("keeps a message queued while authorization is required and resumes it", async () => {
    let authorized = false;
    let creates = 0;
    let sends = 0;
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () => {
        creates += 1;
        if (!authorized) {
          return HttpResponse.json(
            {
              error: "Authentication required",
              code: "authentication_required",
              environment: "company",
              requirements: [
                {
                  alias: "slack",
                  providerKind: "mcp",
                  principalKinds: ["member"],
                },
              ],
            },
            { status: 428 },
          );
        }
        return HttpResponse.json(session, { status: 201 });
      }),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () => {
          sends += 1;
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));

    act(() => {
      void result.current.send("Welcome the new teammate");
    });

    await waitFor(() => {
      expect(result.current.authenticationRequired).toEqual({
        environment: "company",
        requirements: [
          {
            alias: "slack",
            providerKind: "mcp",
            principalKinds: ["member"],
          },
        ],
      });
      expect(result.current.queue).toEqual([
        expect.objectContaining({ content: "Welcome the new teammate" }),
      ]);
    });
    expect(result.current.sessionId).toBeNull();
    expect(sends).toBe(0);

    authorized = true;
    act(() => result.current.resumeAfterAuthentication());

    await waitFor(() => expect(sends).toBe(1));
    expect(creates).toBe(2);
    expect(result.current.queue).toEqual([]);
    expect(result.current.sessionId).toBe(SESSION_ID);
  });

  it("queues overlapping sends in one session", async () => {
    let creates = 0;
    let sends = 0;
    server.use(
      http.post(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`),
        async () => {
          creates += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return HttpResponse.json(session, { status: 201 });
        },
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () => {
          sends += 1;
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));

    act(() => {
      void result.current.send("First");
      void result.current.send("Second");
    });

    await waitFor(() => expect(sends).toBe(2));
    expect(creates).toBe(1);
  });

  it("exposes the pending user message immediately", async () => {
    let finishSend: (() => void) | undefined;
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(session, { status: 201 }),
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        async () => {
          await new Promise<void>((resolve) => {
            finishSend = resolve;
          });
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));

    act(() => {
      void result.current.send("Update the workflow");
    });
    await waitFor(() => {
      expect(result.current.optimisticMessages).toEqual([
        expect.objectContaining({ content: "Update the workflow" }),
      ]);
      expect(result.current.isSending).toBe(true);
    });
    finishSend?.();
    await waitFor(() => expect(result.current.isSending).toBe(false));
    expect(result.current.optimisticMessages).toEqual([]);
  });

  it("reconciles duplicate optimistic messages one persisted copy at a time", async () => {
    let finishFirst: (() => void) | undefined;
    let sends = 0;
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(session, { status: 201 }),
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        async () => {
          sends += 1;
          if (sends === 1) {
            await new Promise<void>((resolve) => {
              finishFirst = resolve;
            });
          }
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () =>
          HttpResponse.json({
            ...session,
            messages: [
              {
                id: crypto.randomUUID(),
                sessionId: SESSION_ID,
                role: "user",
                content: "Repeat",
                commitSha: null,
                metadata: null,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));

    act(() => {
      void result.current.send("Repeat");
      void result.current.send("Repeat");
    });
    await waitFor(() => expect(result.current.sessionId).toBe(SESSION_ID));
    // The in-flight copy reconciles against the one persisted "Repeat";
    // the duplicate is NOT swallowed with it — it waits in the queue.
    await waitFor(() =>
      expect(result.current.optimisticMessages).toHaveLength(0),
    );
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]?.content).toBe("Repeat");
    finishFirst?.();
    await waitFor(() => expect(sends).toBe(2));
  });

  it("reflows attachment markers to the end when an edit desyncs them", async () => {
    let finishFirst: (() => void) | undefined;
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(session, { status: 201 }),
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        async () => {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
          return HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useAgentChat(PROJECT_ID));
    const attachments = [
      {
        kind: "text" as const,
        name: "a.md",
        text: "a",
        source: { type: "paste" as const },
      },
      {
        kind: "text" as const,
        name: "b.md",
        text: "b",
        source: { type: "paste" as const },
      },
    ];

    act(() => {
      void result.current.send("First");
      void result.current.send(
        `see ${ATTACHMENT_MARKER} and ${ATTACHMENT_MARKER}`,
        attachments,
      );
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    const queuedId = result.current.queue[0]?.id as string;

    // Marker count matches the attachments: the edit stands as typed.
    act(() =>
      result.current.updateQueued(
        queuedId,
        `look at ${ATTACHMENT_MARKER} then ${ATTACHMENT_MARKER}`,
      ),
    );
    expect(result.current.queue[0]?.content).toBe(
      `look at ${ATTACHMENT_MARKER} then ${ATTACHMENT_MARKER}`,
    );

    // A marker was deleted: all pills reflow to the end, none remapped.
    act(() =>
      result.current.updateQueued(queuedId, `only ${ATTACHMENT_MARKER} left`),
    );
    expect(result.current.queue[0]?.content).toBe(
      `only  left${ATTACHMENT_MARKER}${ATTACHMENT_MARKER}`,
    );
    expect(result.current.queue[0]?.attachments).toHaveLength(2);
    finishFirst?.();
  });

  it("reports isWorking while the server has an in-progress turn, without a local send", async () => {
    let status = "in_progress";
    server.use(
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () =>
          HttpResponse.json({
            ...session,
            messages: [
              {
                id: "00000000-0000-4000-8000-00000000000a",
                sessionId: SESSION_ID,
                role: "assistant",
                content: "Thinking...",
                commitSha: null,
                metadata: { status },
                createdAt: new Date().toISOString(),
              },
            ],
          }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, { sessionId: SESSION_ID }),
    );

    await waitFor(() => expect(result.current.isWorking).toBe(true));
    expect(result.current.isSending).toBe(false);

    // The turn settles server-side (e.g. finished or marked interrupted).
    status = "completed";
    await waitFor(() => expect(result.current.isWorking).toBe(false));
  });

  it("opens a controlled session and resets when it changes", async () => {
    const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000004";
    server.use(
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () =>
          HttpResponse.json({
            ...session,
            messages: [
              {
                id: crypto.randomUUID(),
                sessionId: SESSION_ID,
                role: "user",
                content: "Earlier message",
                commitSha: null,
                metadata: null,
                createdAt: new Date().toISOString(),
              },
            ],
          }),
      ),
      http.get(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${OTHER_SESSION_ID}`,
        ),
        () =>
          HttpResponse.json({
            ...session,
            id: OTHER_SESSION_ID,
            messages: [],
          }),
      ),
    );
    const { result, rerender } = renderHookWithProviders(
      ({ sessionId }: { sessionId?: string }) =>
        useAgentChat(PROJECT_ID, { sessionId }),
      { initialProps: { sessionId: SESSION_ID } },
    );

    expect(result.current.sessionId).toBe(SESSION_ID);
    await waitFor(() =>
      expect(result.current.messages).toEqual([
        expect.objectContaining({ content: "Earlier message" }),
      ]),
    );

    rerender({ sessionId: OTHER_SESSION_ID });
    expect(result.current.sessionId).toBe(OTHER_SESSION_ID);
    await waitFor(() => expect(result.current.messages).toEqual([]));
  });

  it("reports lazily created sessions through onSessionCreated", async () => {
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(session, { status: 201 }),
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () =>
          HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          ),
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const created: string[] = [];
    const { result } = renderHookWithProviders(() =>
      useAgentChat(PROJECT_ID, {
        onSessionCreated: (id) => created.push(id),
      }),
    );

    await act(() => result.current.send("First"));

    expect(created).toEqual([SESSION_ID]);
  });

  it("drops the active session when the project changes", async () => {
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(session, { status: 201 }),
      ),
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () =>
          HttpResponse.json(
            {
              id: crypto.randomUUID(),
              sessionId: SESSION_ID,
              role: "assistant",
              content: "Done",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          ),
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ ...session, messages: [] }),
      ),
    );
    const { result, rerender } = renderHookWithProviders(
      ({ projectId }) => useAgentChat(projectId),
      { initialProps: { projectId: PROJECT_ID } },
    );

    await act(() => result.current.send("First"));
    await waitFor(() => expect(result.current.sessionId).toBe(SESSION_ID));
    rerender({ projectId: OTHER_PROJECT_ID });

    expect(result.current.sessionId).toBeNull();
    expect(result.current.messages).toEqual([]);
    rerender({ projectId: PROJECT_ID });
    expect(result.current.sessionId).toBeNull();
  });
});
