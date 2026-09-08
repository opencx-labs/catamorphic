import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentCapabilityGateway,
  agentCapabilityTools,
} from "./agent-capabilities.js";
import { listenAgentCapabilityGateway } from "./capability-mcp.js";

describe("capability transport", () => {
  it("keeps schemas deferred and protects the subprocess bridge", async () => {
    const gateway: AgentCapabilityGateway = {
      discover: vi.fn(async () => ({ items: [] })),
      invoke: vi.fn(async () => ({ ok: true })),
    };
    const listener = await listenAgentCapabilityGateway(gateway);
    try {
      const payload = { jsonrpc: "2.0", id: 1, method: "tools/list" };
      const request = (headers: Record<string, string>, body = payload) =>
        fetch(listener.config.url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await request({})).status).toBe(403);
      expect(
        (
          await request({
            ...listener.config.headers,
            origin: "https://untrusted.invalid",
          })
        ).status,
      ).toBe(403);
      const response = await request(listener.config.headers);
      const body = z
        .object({
          result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
        })
        .parse(await response.json());
      expect(body.result.tools.map((tool) => tool.name)).toEqual([
        "discover_capabilities",
        "invoke_capability",
      ]);
      expect(gateway.discover).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
    await expect(fetch(listener.config.url)).rejects.toThrow();
  });
  it("forwards cancellation and validates bootstrap input", async () => {
    const invoke = vi.fn(async () => null);
    const abort = new AbortController();
    const tools = agentCapabilityTools(
      { discover: async () => ({ items: [] }), invoke },
      abort.signal,
    );
    const tool = tools.find((item) => item.name === "invoke_capability");
    if (!tool) throw new Error("No invocation tool");
    await tool.execute(
      { name: "host.read", input: {}, requestId: "once" },
      { projectId: "project" },
    );
    expect(invoke).toHaveBeenCalledWith({
      name: "host.read",
      input: {},
      requestId: "once",
      signal: abort.signal,
    });
    expect(() =>
      tool.execute({ name: "host.read" }, { projectId: "project" }),
    ).toThrow();
  });
});
