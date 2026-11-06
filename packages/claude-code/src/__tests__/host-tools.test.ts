import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { hostToolServers } from "../host-tools.js";

describe("host tool servers", () => {
  it("lists every host tool as always loaded, never deferred to tool search", async () => {
    const servers = hostToolServers({
      tools: [
        {
          name: "browser_act",
          description: "Act on a browser tab",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
          },
        },
      ],
      call: async () => ({ content: [{ type: "text", text: "ok" }] }),
      toolUseId: () => undefined,
    });
    const server = servers.workspace?.instance;
    if (!server) throw new Error("No workspace server");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([
        expect.objectContaining({
          name: "browser_act",
          _meta: { "anthropic/alwaysLoad": true },
        }),
      ]);
    } finally {
      await client.close();
    }
  });
});
