import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
}));
vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    connect = fake.connect;
    close = fake.close;
    listTools = fake.listTools;
    callTool = fake.callTool;
    getDiscoverResult() {
      return undefined;
    }
  },
  SSEClientTransport: class {},
  StreamableHTTPClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {},
}));

import { connectMcpServer, probeMcpServer } from "../client.js";

beforeEach(() => {
  fake.connect.mockReset().mockResolvedValue(undefined);
  fake.close.mockReset().mockResolvedValue(undefined);
  fake.listTools.mockReset().mockRejectedValue(new Error("tools/list failed"));
});

describe("MCP failed setup cleanup", () => {
  it("cancels SDK calls and closes the transport with the workflow attempt signal", async () => {
    fake.listTools.mockResolvedValue({ tools: [] });
    fake.callTool.mockImplementation(
      (_args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const abort = new AbortController();
    const server = await connectMcpServer(
      { transport: "stdio", command: "mock-only" },
      { signal: abort.signal },
    );
    expect(fake.connect.mock.calls[0]?.[1]).toEqual({ signal: abort.signal });
    const request = server.callToolRaw("slow", {});
    const rejected = expect(request).rejects.toThrow("attempt canceled");
    abort.abort(new Error("attempt canceled"));
    await rejected;
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("closes every connected client when discovery fails", async () => {
    for (let i = 0; i < 100; i++)
      expect(
        (await probeMcpServer({ transport: "stdio", command: "mock-only" })).ok,
      ).toBe(false);
    expect(fake.connect).toHaveBeenCalledTimes(100);
    expect(fake.close).toHaveBeenCalledTimes(100);
  });
  it("closes both failed HTTP and fallback SSE transports", async () => {
    fake.connect.mockRejectedValue(new Error("unreachable"));
    expect(
      (
        await probeMcpServer({
          transport: "http",
          url: "https://example.invalid/mcp",
        })
      ).ok,
    ).toBe(false);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(2);
  });
});
