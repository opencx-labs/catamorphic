import { APP_PROTOCOL_VERSION } from "@catamorphic/app";
import { CatamorphicProvider } from "@catamorphic/react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppMount } from "./app-mount.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const APP_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const VERSION_ID = "c3d4e5f6-a7b8-4890-acde-123456789012";

function makeApiClient(overrides?: {
  viewState?: unknown;
  onPost?: (url: string, init: unknown) => unknown;
}) {
  return {
    GET: vi.fn(async (url: string) => {
      if (url.includes("view-state")) {
        return {
          data: overrides?.viewState ?? {
            state: "ready",
            appId: APP_ID,
            versionId: VERSION_ID,
            code: "/* bundle */",
            css: "",
            allowedWorkflows: ["listOrders"],
          },
        };
      }
      return {
        data: {
          id: "run-1",
          status: "completed",
          result: { ok: true },
          error: null,
          batchScopes: [],
        },
      };
    }),
    POST: vi.fn(async (url: string, init: unknown) => {
      return (
        overrides?.onPost?.(url, init) ?? { data: { id: "run-1" }, error: null }
      );
    }),
  };
}

function mount(apiClient: ReturnType<typeof makeApiClient>) {
  return render(
    <CatamorphicProvider apiClient={apiClient as never}>
      <AppMount
        projectId={PROJECT_ID}
        appName="ops-dashboard"
        context={{ tenantId: "t-1", user: { id: "viewer-1" } }}
      />
    </CatamorphicProvider>,
  );
}

describe("AppMount", () => {
  it("renders non-ready view states as copy, not errors", async () => {
    const apiClient = makeApiClient({ viewState: { state: "not_published" } });
    mount(apiClient);
    await screen.findByText(/has not been published/);
  });

  it("mounts a hard-sandboxed iframe for a ready app", async () => {
    const apiClient = makeApiClient();
    const { container } = mount(apiClient);
    await waitFor(() => {
      const frame = container.querySelector("iframe");
      if (!frame) throw new Error("no iframe yet");
      expect(frame.getAttribute("sandbox")).toBe(
        "allow-scripts allow-forms allow-downloads",
      );
      // The two invariants that keep the guest powerless:
      expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(frame.getAttribute("sandbox")).not.toContain(
        "allow-top-navigation",
      );
      expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
      expect(frame.getAttribute("srcdoc")).toContain("/* bundle */");
    });
  });

  it("forwards guest calls with the app audience headers", async () => {
    const posts: { url: string; init: unknown }[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return { data: { id: "run-1" }, error: null };
      },
    });
    const { container } = mount(apiClient);
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });
    const frame = container.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("no frame window");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "call",
          callId: "c1",
          workflowName: "listOrders",
          mode: "start",
          input: { status: "open" },
        },
      }),
    );

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    const init = posts[0]?.init as { headers?: Record<string, string> };
    expect(init.headers?.["X-Catamorphic-App-Id"]).toBe(APP_ID);
    expect(init.headers?.["X-Catamorphic-App-Version-Id"]).toBe(VERSION_ID);
  });

  it("rejects oversized guest input before it reaches the network", async () => {
    const posts: unknown[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return { data: { id: "run-1" }, error: null };
      },
    });
    const { container } = mount(apiClient);
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });
    const frame = container.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("no frame window");

    const replies: unknown[] = [];
    vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(
      (data: unknown) => {
        replies.push(data);
      },
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "call",
          callId: "c1",
          workflowName: "listOrders",
          mode: "invoke",
          input: { blob: "x".repeat(300 * 1024) },
        },
      }),
    );

    await waitFor(() => {
      expect(replies.length).toBeGreaterThan(0);
    });
    expect(replies[0]).toMatchObject({
      kind: "result",
      ok: false,
      error: { code: "not_serializable" },
    });
    expect(posts).toHaveLength(0);
  });

  it("ignores messages that do not come from its own iframe", async () => {
    const posts: unknown[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return { data: { id: "run-1" }, error: null };
      },
    });
    const { container } = mount(apiClient);
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });

    // Same shape, wrong source window.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "call",
          callId: "c1",
          workflowName: "listOrders",
          mode: "start",
          input: {},
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toHaveLength(0);
  });
});
