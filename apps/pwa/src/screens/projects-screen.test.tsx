import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "../lib/api.js";
import {
  activeProfile,
  addRemoteConnection,
  getState,
  removeConnection,
} from "../lib/store.js";
import { ProjectsScreen } from "./projects-screen.js";

vi.mock("../lib/api.js", () => ({
  clientFor: vi.fn(),
  fetchMe: vi.fn(),
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const connectionIds: string[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  const profile = activeProfile(getState());
  for (const connectionId of connectionIds.splice(0)) {
    removeConnection(profile.id, connectionId);
  }
  vi.clearAllMocks();
});

describe("ProjectsScreen", () => {
  it("shows a pending remote as a sign-in action without making API calls", () => {
    const profile = activeProfile(getState());
    const connection = addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: "https://brain.acme.dev/api",
        remoteProjectId: "project-1",
        remoteProjectName: "Acme Brain",
      },
    });
    connectionIds.push(connection.id);
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectsScreen />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Acme Brain");
    expect(container.textContent).toContain("Sign in required");
    expect(
      container.querySelector('[data-testid="project-sign-in"]'),
    ).toBeTruthy();
    expect(fetchMe).not.toHaveBeenCalled();
  });
});
