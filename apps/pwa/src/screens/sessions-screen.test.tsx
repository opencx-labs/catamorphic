import { QueryClient } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PwaConnection } from "../lib/store.js";
import { SessionsScreen } from "./sessions-screen.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(async () => undefined),
  request: vi.fn(async () => new Response("{}", { status: 200 })),
  navigate: vi.fn(),
}));

vi.mock("@catamorphic/react", () => ({
  CatamorphicProvider: ({ children }: { children: ReactNode }) => children,
  useProject: () => ({ data: { name: "Project" } }),
  useAgentSessions: () => ({
    data: {
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "From the laptop",
          icon: null,
          parentSessionId: null,
          status: "active",
          resumable: true,
          authorityRevision: 4,
          createdAt: "2026-08-29T10:00:00.000Z",
          updatedAt: "2026-08-29T10:00:00.000Z",
        },
      ],
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: mocks.refetch,
  }),
}));

vi.mock("../lib/api.js", () => ({
  clientFor: vi.fn(() => ({})),
  authenticatedFetch: vi.fn(() => mocks.request),
}));

vi.mock("../lib/nav.js", () => ({
  navigate: mocks.navigate,
  goBack: vi.fn(),
}));

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("SessionsScreen", () => {
  it("marks a paused session and resumes it before opening the chat", async () => {
    const connection: PwaConnection = {
      id: "connection-1",
      kind: "device",
      serverUrl: "https://server.example/api",
      projectId: "project-1",
      credentials: { accessToken: "token" },
      addedAt: "2026-08-29T10:00:00.000Z",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <SessionsScreen
          connection={connection}
          projectId="project-1"
          projectName="Project"
          queryClient={new QueryClient()}
        />,
      );
    });

    expect(container.textContent).toContain("Paused · Tap to resume");
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-row"]',
    );
    await act(async () => row?.click());

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining(
        "/agent/sessions/11111111-1111-4111-8111-111111111111/resume",
      ),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedAuthorityRevision: 4 }),
      }),
    );
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "chat",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("shows a resume failure in the sessions list without opening the chat", async () => {
    mocks.request.mockResolvedValueOnce(new Response("{}", { status: 409 }));
    const connection: PwaConnection = {
      id: "connection-1",
      kind: "device",
      serverUrl: "https://server.example/api",
      projectId: "project-1",
      credentials: { accessToken: "token" },
      addedAt: "2026-08-29T10:00:00.000Z",
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <SessionsScreen
          connection={connection}
          projectId="project-1"
          projectName="Project"
          queryClient={new QueryClient()}
        />,
      );
    });

    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-row"]',
    );
    await act(async () => row?.click());

    expect(container.textContent).toContain(
      "This session changed on another machine",
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
