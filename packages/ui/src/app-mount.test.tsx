import { APP_PROTOCOL_VERSION } from "@catamorphic/app";
import { CatamorphicProvider } from "@catamorphic/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppMount } from "./app-mount.js";

// Each mount installs a window message listener; unmount between tests so a
// stray guest message cannot be handled by a previous test's broker.
afterEach(cleanup);

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const APP_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const VERSION_ID = "c3d4e5f6-a7b8-4890-acde-123456789012";
const GUEST_URL = `http://127.0.0.1:4100/api/projects/${PROJECT_ID}/apps/ops-dashboard/guest?channel=dev`;

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
            guestUrl: GUEST_URL,
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

/**
 * Waits for the iframe *and* for the broker's message listener to be
 * installed. The listener is registered by an effect that runs after the
 * frame paints, so a guest message dispatched too early is silently dropped.
 * A `resize` probe is the cheap observable: it is handled before any
 * authorization or network path and only mutates the frame's height.
 */
async function mountReadyFrame(apiClient: ReturnType<typeof makeApiClient>) {
  const { container } = mount(apiClient);
  await waitFor(() => {
    if (!container.querySelector("iframe")) throw new Error("no iframe");
  });
  const frame = container.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame window");
  await waitFor(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "resize",
          height: 321,
        },
      }),
    );
    expect(frame.style.height).toBe("321px");
  });
  return { container, frame };
}

describe("AppMount", () => {
  it("navigates the frame to the guest URL with the theme riding along", async () => {
    const apiClient = makeApiClient();
    const { container } = render(
      <CatamorphicProvider apiClient={apiClient as never}>
        <AppMount
          projectId={PROJECT_ID}
          appName="ops-dashboard"
          context={{ tenantId: "t-1", user: { id: "viewer-1" } }}
          theme={{
            appearance: "light",
            colors: { bg: "#f7f7f5", accent: "#d63c0c" },
          }}
        />
      </CatamorphicProvider>,
    );
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });
    const src = container.querySelector("iframe")?.getAttribute("src") ?? "";
    const url = new URL(src);
    // The document is served by the API (its own CSP), never srcdoc.
    expect(
      `${url.origin}${url.pathname}?channel=${url.searchParams.get("channel")}`,
    ).toBe(GUEST_URL);
    expect(
      container.querySelector("iframe")?.getAttribute("srcdoc"),
    ).toBeNull();
    // The mount-time theme rides the URL so the first paint is themed.
    expect(JSON.parse(url.searchParams.get("theme") ?? "{}")).toEqual({
      appearance: "light",
      colors: { bg: "#f7f7f5", accent: "#d63c0c" },
    });
  });

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
      expect(frame.getAttribute("src")).toBe(GUEST_URL);
    });
  });

  it("forwards guest starts to the app's own run route, no headers", async () => {
    const posts: { url: string; init: unknown }[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return { data: { id: "run-1" }, error: null };
      },
    });
    const { frame } = await mountReadyFrame(apiClient);

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
    // The URL names the app: narrowing is structural on the server, so the
    // mount carries no audience claim of its own.
    expect(posts[0]?.url).toBe(
      "/api/projects/{projectId}/apps/{appName}/runs/{workflowName}",
    );
    const init = posts[0]?.init as {
      headers?: Record<string, string>;
      params: { path: Record<string, string> };
    };
    expect(init.headers).toBeUndefined();
    expect(init.params.path).toEqual({
      projectId: PROJECT_ID,
      appName: "ops-dashboard",
      workflowName: "listOrders",
    });
  });

  it("answers an invoke from the synchronous call route", async () => {
    const posts: { url: string; init: unknown }[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return {
          data: { status: "completed", runId: "run-1", output: { n: 3 } },
          error: null,
        };
      },
    });
    const { frame } = await mountReadyFrame(apiClient);
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
          input: {},
        },
      }),
    );

    await waitFor(() => {
      expect(replies).toHaveLength(1);
    });
    expect(posts[0]?.url).toBe(
      "/api/projects/{projectId}/apps/{appName}/calls/{workflowName}",
    );
    // No poll happened: the sync call settled and the output went straight
    // back to the guest.
    expect(apiClient.GET).toHaveBeenCalledTimes(1); // the view-state read
    expect(replies[0]).toMatchObject({
      kind: "result",
      callId: "c1",
      ok: true,
      value: { n: 3 },
    });
  });

  it("polls the app run route when a call suspends", async () => {
    const apiClient = makeApiClient({
      onPost: () => ({
        data: { status: "suspended", runId: "run-1", suspendedOn: "budget" },
        error: null,
      }),
    });
    const { frame } = await mountReadyFrame(apiClient);
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
          input: {},
        },
      }),
    );

    await waitFor(() => {
      expect(replies).toHaveLength(1);
    });
    const gets = apiClient.GET.mock.calls.map((call) => call[0]);
    expect(gets).toContain(
      "/api/projects/{projectId}/apps/{appName}/runs/{runId}",
    );
    expect(replies[0]).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("rejects oversized guest input before it reaches the network", async () => {
    const posts: unknown[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        return { data: { id: "run-1" }, error: null };
      },
    });
    const { frame } = await mountReadyFrame(apiClient);

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
    // Ready frame first, so a dropped message proves the source check —
    // not that the listener simply was not installed yet.
    await mountReadyFrame(apiClient);

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

  // Guest-document construction (script/style escaping, CSP, theme seeding)
  // is covered by @catamorphic/app's guest-document tests — the mount only
  // points its iframe at the served document.

  it("caps concurrent guest calls", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posts: unknown[] = [];
    const apiClient = makeApiClient({
      onPost: (url, init) => {
        posts.push({ url, init });
        // Hold every call open so the cap is what ends the flood.
        return gate.then(() => ({ data: { id: "run-1" }, error: null }));
      },
    });
    const { frame } = await mountReadyFrame(apiClient);

    const replies: { error?: { code?: string } }[] = [];
    vi.spyOn(frame.contentWindow, "postMessage").mockImplementation(
      (data: unknown) => {
        replies.push(data as { error?: { code?: string } });
      },
    );

    for (let index = 0; index < 12; index += 1) {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "call",
            callId: `c${index}`,
            workflowName: "listOrders",
            mode: "start",
            input: {},
          },
        }),
      );
    }

    await waitFor(() => {
      if (replies.length < 4) throw new Error("no rejections yet");
    });
    // 8 admitted, the rest refused without reaching the network.
    expect(posts).toHaveLength(8);
    expect(
      replies.filter((reply) => reply.error?.code === "denied").length,
    ).toBe(4);
    // Drain the held calls so no in-flight work leaks into the next test.
    release?.();
    await waitFor(() => {
      if (replies.length < 12) throw new Error("calls still in flight");
    });
  });
});
