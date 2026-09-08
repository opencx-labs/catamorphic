import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
}));
vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    connect = fake.connect;
    close = fake.close;
    listTools = fake.listTools;
  },
  SSEClientTransport: class {},
  StreamableHTTPClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {},
}));

import { probeMcpServer } from "../client.js";

beforeEach(() => {
  fake.connect.mockReset().mockResolvedValue(undefined);
  fake.close.mockReset().mockResolvedValue(undefined);
  fake.listTools.mockReset().mockRejectedValue(new Error("tools/list failed"));
});

describe("MCP failed setup cleanup", () => {
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
