// @vitest-environment jsdom

import { SESSION_PROTOCOL_VERSION } from "@catamorphic/agent-protocol";
import {
  type CatamorphicApiClient,
  createApiClient,
} from "@catamorphic/api-client";
import { CatamorphicProvider, useCatamorphic } from "@catamorphic/react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import {
  remoteQueryClients,
  remoteQueryClientUsers,
} from "../lib/remote-query-clients.js";
import { ProjectAuthorityProvider } from "./project-authority-provider.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { remoteAuthority: vi.fn() },
}));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const remote = {
  connectionId: "shared-connection",
  credentialEpoch: "first",
  remoteProjectId: "remote-project",
  serverUrl: "https://brain.example/api",
};
const fetchMember: typeof fetch = async () =>
  Response.json({
    projects: [{ projectId: remote.remoteProjectId, permissions: [] }],
    identity: { externalUserId: "member" },
    agentProtocol: { session: SESSION_PROTOCOL_VERSION },
  });

async function captureProviders() {
  const seen = new Map<
    string,
    { apiClient: CatamorphicApiClient; queries: QueryClient }
  >();
  function Capture({ id }: { id: string }) {
    const { apiClient } = useCatamorphic();
    const queries = useQueryClient();
    useEffect(() => {
      seen.set(id, { apiClient, queries });
    }, [id, apiClient, queries]);
    return <p>{id}</p>;
  }
  const local = createApiClient({
    baseUrl: "http://localhost",
    fetch: fetchMember,
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (children: ReactNode, apiClient = local) => {
    await act(async () =>
      root.render(
        <CatamorphicProvider apiClient={apiClient} queryClient={queries}>
          {children}
        </CatamorphicProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  return {
    seen,
    local,
    queries,
    Capture,
    render,
    cleanup: () => {
      act(() => root.unmount());
      queries.clear();
      container.remove();
      vi.clearAllMocks();
    },
  };
}

describe("ProjectAuthorityProvider", () => {
  it("shares sibling cache and API identities until the last provider leaves", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue(remote);
    const view = await captureProviders();
    const { Capture } = view;
    try {
      await view.render(
        <>
          <ProjectAuthorityProvider projectId="local-project">
            <Capture id="first" />
          </ProjectAuthorityProvider>
          <ProjectAuthorityProvider projectId="local-project">
            <Capture id="second" />
          </ProjectAuthorityProvider>
        </>,
      );
      const first = view.seen.get("first");
      const second = view.seen.get("second");
      expect(first).toBeDefined();
      expect(second?.apiClient).toBe(first?.apiClient);
      expect(second?.queries).toBe(first?.queries);
      expect(first?.apiClient.baseUrl).toBe(
        "http://localhost/desktop/projects/local-project/remote-api",
      );
      expect(first && remoteQueryClientUsers.get(first.queries)).toBe(2);
      await view.render(
        <ProjectAuthorityProvider projectId="local-project">
          <Capture id="first" />
        </ProjectAuthorityProvider>,
      );
      expect(view.seen.get("first")?.apiClient).toBe(first?.apiClient);
      expect(first && remoteQueryClientUsers.get(first.queries)).toBe(1);
      expect(remoteQueryClients.get("shared-connection:first")).toBe(
        first?.queries,
      );
      await view.render(null);
      expect(remoteQueryClients.has("shared-connection:first")).toBe(false);
      expect(first && remoteQueryClientUsers.has(first.queries)).toBe(false);
    } finally {
      view.cleanup();
    }
  });

  it("isolates local API object identity even when its fetch and base URL match", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue(remote);
    const view = await captureProviders();
    const { Capture } = view;
    const other = createApiClient({
      baseUrl: view.local.baseUrl,
      fetch: view.local.fetch,
    });
    try {
      await view.render(
        <>
          <ProjectAuthorityProvider projectId="local-project">
            <Capture id="first" />
          </ProjectAuthorityProvider>
          <CatamorphicProvider apiClient={other} queryClient={view.queries}>
            <ProjectAuthorityProvider projectId="local-project">
              <Capture id="second" />
            </ProjectAuthorityProvider>
          </CatamorphicProvider>
        </>,
      );
      const first = view.seen.get("first");
      const second = view.seen.get("second");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.queries).toBe(second?.queries);
      expect(first?.apiClient).not.toBe(second?.apiClient);
      // A new local identity on an existing provider must also replace its transport.
      await view.render(
        <ProjectAuthorityProvider projectId="local-project">
          <Capture id="replacement" />
        </ProjectAuthorityProvider>,
        other,
      );
      expect(view.seen.get("replacement")?.apiClient).not.toBe(
        first?.apiClient,
      );
    } finally {
      view.cleanup();
    }
  });

  it("keeps project proxy addresses separate within an authority", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue(remote);
    const view = await captureProviders();
    const { Capture } = view;
    try {
      await view.render(
        <>
          <ProjectAuthorityProvider projectId="local-one">
            <Capture id="first" />
          </ProjectAuthorityProvider>
          <ProjectAuthorityProvider projectId="local-two">
            <Capture id="second" />
          </ProjectAuthorityProvider>
        </>,
      );
      const first = view.seen.get("first");
      const second = view.seen.get("second");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.queries).toBe(second?.queries);
      expect(first?.apiClient).not.toBe(second?.apiClient);
      expect(second?.apiClient.baseUrl).toContain("/local-two/remote-api");
    } finally {
      view.cleanup();
    }
  });

  it("replaces the shared cache and API client after a credential epoch changes", async () => {
    vi.mocked(desktopApi.remoteAuthority).mockResolvedValue(remote);
    const view = await captureProviders();
    const { Capture } = view;
    try {
      const children = (
        <>
          <ProjectAuthorityProvider projectId="local-project">
            <Capture id="first" />
          </ProjectAuthorityProvider>
          <ProjectAuthorityProvider projectId="local-project">
            <Capture id="second" />
          </ProjectAuthorityProvider>
        </>
      );
      await view.render(children);
      const before = view.seen.get("first");
      before?.queries.setQueryData(["private"], "old credential data");
      await act(async () =>
        view.queries.setQueryData(
          ["desktop", "project-authority", "local-project"],
          { ...remote, credentialEpoch: "second" },
        ),
      );
      await view.render(children);
      const first = view.seen.get("first");
      const second = view.seen.get("second");
      expect(before).toBeDefined();
      expect(first).toBeDefined();
      expect(first?.apiClient).not.toBe(before?.apiClient);
      expect(first?.queries).not.toBe(before?.queries);
      expect(second?.apiClient).toBe(first?.apiClient);
      expect(second?.queries).toBe(first?.queries);
      expect(before?.queries.getQueryData(["private"])).toBeUndefined();
      expect(remoteQueryClients.has("shared-connection:first")).toBe(false);
      expect(remoteQueryClients.get("shared-connection:second")).toBe(
        first?.queries,
      );
    } finally {
      view.cleanup();
    }
  });

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
                  agentProtocol: { session: 1, runner: 1 },
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
