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

  it("neutralizes a </script> sequence in the bundle", async () => {
    // A bundle carrying the literal closing tag (a string constant is enough)
    // would otherwise end the inline script and spill into the document.
    const apiClient = makeApiClient({
      viewState: {
        state: "ready",
        appId: APP_ID,
        versionId: VERSION_ID,
        code: 'const s = "</script><img src=x onerror=alert(1)>";',
        css: "a{content:'</style><b>'}",
        allowedWorkflows: [],
      },
    });
    const { container } = mount(apiClient);
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });
    const srcdoc =
      container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    // Only the real closing tags survive (the process shim, the auto-height
    // reporter, and the bundle script): the bundle's own copies are escaped.
    expect(srcdoc.match(/<\/script>/g)).toHaveLength(3);
    expect(srcdoc.match(/<\/style>/g)).toHaveLength(1);
    expect(srcdoc).toContain("<\\/script>");
    // The injected markup stays inside the script text, never parsed as HTML.
    expect(srcdoc).toContain("<\\/script><img src=x onerror=alert(1)>");
  });

  it("leaves JS that merely looks like an HTML comment intact", async () => {
    // `a<!--b` is valid JS (a < !(--b)) and minifiers emit it. Rewriting it
    // to \x3C outside a string literal would be a SyntaxError at load.
    const code = "let a=5,b=1;const c=a<!--b;";
    const apiClient = makeApiClient({
      viewState: {
        state: "ready",
        appId: APP_ID,
        versionId: VERSION_ID,
        code,
        css: "",
        allowedWorkflows: [],
      },
    });
    const { container } = mount(apiClient);
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("no iframe");
    });
    const srcdoc =
      container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain(code);
    expect(srcdoc).not.toContain("\\x3C");
  });

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
