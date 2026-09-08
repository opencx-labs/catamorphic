import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

const { workflowMcpConnectionEntries } = await import(
  "./workflow-mcp-connections.js"
);

describe("workflowMcpConnectionEntries", () => {
  it("uses the same deterministic aliases as agent MCP configuration", () => {
    const entries = workflowMcpConnectionEntries([
      {
        id: "first",
        name: "Company Mail",
        transport: "http",
        url: "https://first.example.test/mcp",
        enabled: true,
        source: { kind: "manual" },
      },
      {
        id: "second",
        name: "Company Mail",
        transport: "http",
        url: "https://second.example.test/mcp",
        enabled: true,
        source: { kind: "manual" },
      },
    ]);

    expect(entries.map(({ alias }) => alias)).toEqual([
      "company-mail",
      "company-mail-2",
    ]);
    expect(entries.map(({ connection }) => connection.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not adopt disabled or incomplete connections", () => {
    expect(
      workflowMcpConnectionEntries([
        {
          id: "disabled",
          name: "Disabled",
          transport: "http",
          url: "https://disabled.example.test/mcp",
          enabled: false,
          source: { kind: "manual" },
        },
        {
          id: "incomplete",
          name: "Incomplete",
          transport: "stdio",
          enabled: true,
          source: { kind: "manual" },
        },
      ]),
    ).toEqual([]);
  });
});
