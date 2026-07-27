// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PROTOCOL_VERSION, type GuestToHostMessage } from "../protocol.js";

interface TestContract {
  listOrders: import("../contract.js").PlainWorkflow<{
    input: { status: "open" | "all" };
    output: { id: string }[];
  }>;
  reconcile: import("../contract.js").DurableWorkflow<{
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

  it("resolves a plain call with the host's value", async () => {
    const { createClient } = await import("../client.js");
    const workflows = createClient<TestContract>();

    const pending = workflows.listOrders({ status: "open" });
    const message = sent.at(-1);
    if (!message || message.kind !== "call") throw new Error("no call sent");
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
    if (!startMessage || startMessage.kind !== "call")
      throw new Error("no call sent");
    expect(startMessage.mode).toBe("start");
    hostReply(startMessage, { runId: "run-1" });
    const handle = await pendingStart;
    expect(handle.runId).toBe("run-1");

    const pendingResult = handle.result({ pollIntervalMs: 1 });
    // First poll: running; second poll: completed.
    const firstPoll = sent.at(-1);
    if (!firstPoll || firstPoll.kind !== "poll-run")
      throw new Error("no poll sent");
    hostReply(firstPoll, {
      runId: "run-1",
      status: "running",
      output: null,
      error: null,
    });
    await vi.waitFor(() => {
      const message = sent.at(-1);
      if (!message || message.kind !== "poll-run" || message === firstPoll)
        throw new Error("second poll not sent yet");
    });
    const secondPoll = sent.at(-1);
    if (!secondPoll || secondPoll.kind !== "poll-run")
      throw new Error("no second poll");
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

    const pending = workflows.listOrders({ status: "open" });
    const message = sent.at(-1);
    if (!message || message.kind !== "call") throw new Error("no call sent");
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
    const pending = workflows.listOrders({ status: "all" });

    window.dispatchEvent(
      new MessageEvent("message", { data: { random: "noise" } }),
    );
    const message = sent.at(-1);
    if (!message || message.kind !== "call") throw new Error("no call sent");
    hostReply(message, []);
    expect(await pending).toEqual([]);
  });
});
