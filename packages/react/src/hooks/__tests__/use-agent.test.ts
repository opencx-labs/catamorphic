import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useAgentSession } from "../use-agent-session.js";
import { useAgentSessions } from "../use-agent-sessions.js";
import { useCreateAgentSession } from "../use-create-agent-session.js";
import { useSendAgentMessage } from "../use-send-agent-message.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "00000000-0000-0000-0000-000000000002";
const USER_ID = "00000000-0000-0000-0000-000000000003";

const SESSION_BASE = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  provider: "codex",
  providerSessionId: null,
  sandboxId: null,
  title: null,
  status: "active" as const,
  baseCommitSha: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("useAgentSessions", () => {
  it("returns the sessions list", async () => {
    server.use(
      http.get(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json({ items: [SESSION_BASE], total: 1 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentSessions(PROJECT_ID),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.get(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json({ error: "x" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentSessions(PROJECT_ID),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("not_found");
  });
});

describe("useAgentSession", () => {
  it("returns the session detail", async () => {
    server.use(
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () =>
          HttpResponse.json({
            ...SESSION_BASE,
            messages: [],
          }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(SESSION_ID);
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`),
        () => HttpResponse.json({ error: "x" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useAgentSession(PROJECT_ID, SESSION_ID),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("not_found");
  });
});

describe("useCreateAgentSession / useSendAgentMessage", () => {
  it("creates a session", async () => {
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json(SESSION_BASE, { status: 201 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useCreateAgentSession(PROJECT_ID),
    );
    const out = await result.current.mutateAsync({ userId: USER_ID });
    expect(out.id).toBe(SESSION_ID);
  });

  it("sends a message", async () => {
    server.use(
      http.post(
        apiUrl(
          `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        ),
        () =>
          HttpResponse.json(
            {
              id: "msg-1",
              sessionId: SESSION_ID,
              role: "user" as const,
              content: "hello",
              commitSha: null,
              metadata: null,
              createdAt: new Date().toISOString(),
            },
            { status: 201 },
          ),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useSendAgentMessage(PROJECT_ID),
    );
    const out = await result.current.mutateAsync({
      sessionId: SESSION_ID,
      message: "hello",
    });
    expect(out.content).toBe("hello");
  });

  it("maps create 404 to not_found", async () => {
    server.use(
      http.post(apiUrl(`/api/projects/${PROJECT_ID}/agent/sessions`), () =>
        HttpResponse.json({ error: "x" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useCreateAgentSession(PROJECT_ID),
    );
    await expect(
      result.current.mutateAsync({ userId: USER_ID }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
