// @vitest-environment jsdom

import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { ProjectAuthorityProvider } from "./project-authority-provider.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { remoteAuthority: vi.fn() },
}));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("ProjectAuthorityProvider", () => {
  it("never mounts an incognito chat against a remote authority", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue({
      connectionId: "connection",
      credentialEpoch: "epoch",
      remoteProjectId: "remote-project",
      serverUrl: "https://brain.example/api",
    });
    const mount = vi.fn();
    function Chat() {
      useEffect(mount, []);
      return <p>Private transcript</p>;
    }
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <CatamorphicProvider
            apiClient={createApiClient({
              baseUrl: "http://localhost",
              fetch: async () => Response.json({ projects: [] }),
            })}
            queryClient={queries}
          >
            <ProjectAuthorityProvider projectId="local-project" localOnly>
              <Chat />
            </ProjectAuthorityProvider>
          </CatamorphicProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(container.textContent).toContain(
        "This incognito chat stays on this computer",
      );
      expect(container.textContent).not.toContain("Private transcript");
      expect(mount).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      queries.clear();
      container.remove();
      vi.clearAllMocks();
    }
  });

  it("refuses a server that speaks another session protocol", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue({
      connectionId: "connection-2",
      credentialEpoch: "epoch",
      remoteProjectId: "remote-project",
      serverUrl: "https://brain.example/api",
    });
    const mount = vi.fn();
    function Chat() {
      useEffect(mount, []);
      return <p>Remote transcript</p>;
    }
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <CatamorphicProvider
            apiClient={createApiClient({
              baseUrl: "http://localhost",
              fetch: async () =>
                Response.json({
                  projects: [],
                  agentProtocol: { session: 2, runner: 1 },
                }),
            })}
            queryClient={queries}
          >
            <ProjectAuthorityProvider projectId="local-project">
              <Chat />
            </ProjectAuthorityProvider>
          </CatamorphicProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(container.textContent).toContain("Update Work to continue");
    } finally {
      act(() => root.unmount());
      queries.clear();
      container.remove();
      vi.clearAllMocks();
    }
  });
});
