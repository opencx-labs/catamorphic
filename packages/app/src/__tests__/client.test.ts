// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PROTOCOL_VERSION, type GuestToHostMessage } from "../protocol.js";

interface TestContract {
  listOrders: import("../contract.js").Workflow<{
    input: { status: "open" | "all" };
    output: { id: string }[];
  }>;
  reconcile: import("../contract.js").Workflow<{
    input: { month: string };
    output: { matched: number };
  }>;
}

function hostReply(message: GuestToHostMessage, value: unknown, ok = true) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: ok
        ? {
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "result",
            callId: message.callId,
            ok: true,
            value,
          }
        : {
            catamorphicApp: APP_PROTOCOL_VERSION,
            kind: "result",
            callId: message.callId,
            ok: false,
            error: { code: "denied", message: "no" },
          },
    }),
  );
}

describe("createClient", () => {
  let sent: GuestToHostMessage[];

  beforeEach(async () => {
    vi.resetModules();
    sent = [];
    vi.spyOn(window.parent, "postMessage").mockImplementation(
      (data: unknown) => {
        sent.push(data as GuestToHostMessage);
      },
    );
  });

  it("releases unanswered requests on timeout so subsequent calls can proceed", async () => {
    vi.useFakeTimers();
    try {
      const { createClient } = await import("../client.js");
      const workflows = createClient<TestContract>({ requestTimeoutMs: 50 });
      for (let batch = 0; batch < 2; batch++) {
        const pending = Array.from({ length: 128 }, () =>
          workflows.listOrders.call({ status: "open" }),
        );
        const settled = Promise.allSettled(pending);
        await expect(
          workflows.listOrders.call({ status: "open" }),
        ).rejects.toThrow("Too many pending");
        await vi.advanceTimersByTimeAsync(50);
        expect(
          (await settled).every((result) => result.status === "rejected"),
        ).toBe(true);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a pending host call and releases its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { createClient } = await import("../client.js");
      const controller = new AbortController();
      const pending = createClient<TestContract>({
        signal: controller.signal,
      }).listOrders.call({ status: "open" });
      const failed = expect(pending).rejects.toThrow("stop waiting");
      controller.abort(new Error("stop waiting"));
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a plain call with the host's value", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();

    const pending = workflows.listOrders.call({ status: "open" });
    const message = sent.at(-1);
    if (message?.kind !== "call") throw new Error("no call sent");
    expect(message.workflowName).toBe("listOrders");
    expect(message.mode).toBe("invoke");
    expect(message.input).toEqual({ status: "open" });

    hostReply(message, [{ id: "o1" }]);
    expect(await pending).toEqual([{ id: "o1" }]);
  });

  it("start returns a handle that polls to completion", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();

    const pendingStart = workflows.reconcile.start({ month: "2026-07" });
    const startMessage = sent.at(-1);
    if (startMessage?.kind !== "call") throw new Error("no call sent");
    expect(startMessage.mode).toBe("start");
    hostReply(startMessage, { runId: "run-1" });
    const handle = await pendingStart;
    expect(handle.runId).toBe("run-1");

    const pendingResult = handle.result({ pollIntervalMs: 1 });
    // First poll: running; second poll: completed.
    const firstPoll = sent.at(-1);
    if (firstPoll?.kind !== "poll-run") throw new Error("no poll sent");
    hostReply(firstPoll, {
      runId: "run-1",
      status: "running",
      output: null,
      error: null,
    });
    await vi.waitFor(() => {
      const message = sent.at(-1);
      if (message?.kind !== "poll-run" || message === firstPoll)
        throw new Error("second poll not sent yet");
    });
    const secondPoll = sent.at(-1);
    if (secondPoll?.kind !== "poll-run") throw new Error("no second poll");
    hostReply(secondPoll, {
      runId: "run-1",
      status: "completed",
      output: { matched: 12 },
      error: null,
    });
    expect(await pendingResult).toEqual({ matched: 12 });
  });

  it("rejects with a typed error on denial", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();

    const pending = workflows.listOrders.call({ status: "open" });
    const message = sent.at(-1);
    if (message?.kind !== "call") throw new Error("no call sent");
    hostReply(message, undefined, false);
    // vi.resetModules() re-instantiates the module, so match on shape rather
    // than class identity.
    await expect(pending).rejects.toMatchObject({
      name: "AppCallError",
      code: "denied",
    });
  });

  it("ignores messages that are not host protocol messages", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();
    const pending = workflows.listOrders.call({ status: "all" });

    window.dispatchEvent(
      new MessageEvent("message", { data: { random: "noise" } }),
    );
    const message = sent.at(-1);
    if (message?.kind !== "call") throw new Error("no call sent");
    hostReply(message, []);
    expect(await pending).toEqual([]);
  });
});

/** JSON-RPC frames the bridge sent (MCP Apps host dialect). */
interface RpcFrame {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcReply(id: number, result: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", { data: { jsonrpc: "2.0", id, result } }),
  );
}

describe("createClient in an MCP Apps host", () => {
  let sent: unknown[];

  const rpcFrames = () =>
    sent.filter(
      (frame): frame is RpcFrame & { method: string } =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as RpcFrame).jsonrpc === "2.0" &&
        typeof (frame as RpcFrame).method === "string",
    );

  beforeEach(async () => {
    vi.resetModules();
    sent = [];
    vi.spyOn(window.parent, "postMessage").mockImplementation(
      (data: unknown) => {
        sent.push(data);
      },
    );
  });

  it("probes with ui/initialize at boot", async () => {
    const { createClient } = await import("../client.js");
    createClient<TestContract>();
    const probe = rpcFrames().find((frame) => frame.method === "ui/initialize");
    expect(probe).toBeDefined();
    expect(probe?.id).toBe(0);
  });

  it("re-dispatches pre-flip calls as tools/call and maps results", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();

    // Call made while the bridge still assumes a Catamorphic host — the
    // MCP host ignored the native-dialect frame.
    const pending = workflows.listOrders.call({ status: "open" });

    // The host answers the initialize probe: mode flips, call re-sends.
    rpcReply(0, { hostContext: { theme: "dark" } });
    const call = rpcFrames().find((frame) => frame.method === "tools/call");
    if (!call?.id) throw new Error("tools/call was not dispatched");
    expect(call.params).toEqual({
      name: "listOrders",
      arguments: { input: { status: "open" }, mode: "invoke" },
    });

    rpcReply(call.id, { structuredContent: [{ id: "o1" }] });
    expect(await pending).toEqual([{ id: "o1" }]);
  });

  it("maps durable start + polling to tools, and getContext synthesizes", async () => {
    const { createClient, getContext } = await import("../client.js");
    const workflows = createClient<TestContract>();
    rpcReply(0, {});

    const pendingStart = workflows.reconcile.start({ month: "2026-07" });
    const startCall = rpcFrames().at(-1);
    if (!startCall?.id) throw new Error("no start call");
    expect(startCall.params?.name).toBe("reconcile");
    rpcReply(startCall.id, { structuredContent: { runId: "run-9" } });
    const handle = await pendingStart;
    expect(handle.runId).toBe("run-9");

    const pendingPoll = handle.poll();
    const pollCall = rpcFrames().at(-1);
    if (!pollCall?.id) throw new Error("no poll call");
    expect(pollCall.params?.name).toBe("catamorphic_poll_run");
    expect(pollCall.params?.arguments).toEqual({ runId: "run-9" });
    rpcReply(pollCall.id, {
      structuredContent: {
        runId: "run-9",
        status: "completed",
        output: { matched: 3 },
        error: null,
      },
    });
    expect((await pendingPoll).output).toEqual({ matched: 3 });

    const context = await getContext();
    expect(context.host?.mcp).toBe(true);
  });

  it("surfaces isError tool results as workflow failures", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();
    rpcReply(0, {});

    const pending = workflows.listOrders.call({ status: "all" });
    const call = rpcFrames().at(-1);
    if (!call?.id) throw new Error("no call");
    rpcReply(call.id, {
      isError: true,
      content: [{ type: "text", text: "denied by policy" }],
    });
    await expect(pending).rejects.toMatchObject({
      name: "AppCallError",
      code: "workflow_failed",
    });
  });

  it("reports height as a size-changed notification", async () => {
    const { reportHeight, createClient } = await import("../client.js");
    createClient<TestContract>();
    rpcReply(0, {});

    reportHeight(420);
    const note = rpcFrames().find(
      (frame) => frame.method === "ui/notifications/size-changed",
    );
    expect(note?.params).toEqual({ height: 420 });
  });
});

describe("app display lifecycle", () => {
  it("observes compact/hidden state and unsubscribes without recreating the client", async () => {
    const { subscribeDisplay } = await import("../client.js");
    const listener = vi.fn();
    const unsubscribe = subscribeDisplay(listener);
    expect(listener).toHaveBeenLastCalledWith({ mode: "full", visible: true });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "display",
          display: { mode: "compact", visible: false },
        },
      }),
    );
    expect(listener).toHaveBeenLastCalledWith({
      mode: "compact",
      visible: false,
    });
    unsubscribe();
    const count = listener.mock.calls.length;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          catamorphicApp: APP_PROTOCOL_VERSION,
          kind: "display",
          display: { mode: "full", visible: true },
        },
      }),
    );
    expect(listener).toHaveBeenCalledTimes(count);
  });
});
