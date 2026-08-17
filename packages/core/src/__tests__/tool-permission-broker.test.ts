import { describe, expect, it, vi } from "vitest";
import { ToolPermissionBroker } from "../services/tool-permission-broker.js";

const request = {
  sessionId: "s1",
  server: "slack",
  tool: "post_message",
  input: { text: "hi" },
};

describe("ToolPermissionBroker", () => {
  it("parks an ask, lists it per session, and resolves on answer", async () => {
    const broker = new ToolPermissionBroker();
    const changes = vi.fn();
    broker.onChange(changes);
    const pending = broker.handlerFor("Ops agent")(request);
    const [entry] = broker.list("s1");
    expect(entry?.agentLabel).toBe("Ops agent");
    expect(entry?.request.tool).toBe("post_message");
    expect(broker.list("other")).toEqual([]);
    expect(
      broker.answer(entry?.id ?? "", { decision: "allow", remember: "always" }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      decision: "allow",
      remember: "always",
    });
    expect(broker.list()).toEqual([]);
    expect(broker.answer(entry?.id ?? "", { decision: "deny" })).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("denies on timeout so a tool call never hangs on a missing UI", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ToolPermissionBroker({ timeoutMs: 1000 });
      const pending = broker.ask(request);
      vi.advanceTimersByTime(1001);
      await expect(pending).resolves.toEqual({ decision: "deny" });
      expect(broker.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
