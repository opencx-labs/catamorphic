import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

const { desktopProfileMcpProvider, workflowMcpConnectionEntries } =
  await import("./workflow-mcp-connections.js");

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

describe("profile MCP connections in the broker (ADR 0225)", () => {
  it("passes each tool's results through as its server sent them", () => {
    expect(desktopProfileMcpProvider.mcp).toBe(true);
  });

  it("never names a connector after a host tool server it would shadow", () => {
    const entries = workflowMcpConnectionEntries(
      ["Workspace", "Catamorphic"].map((name) => ({
        id: name,
        name,
        transport: "http" as const,
        url: `https://${name.toLowerCase()}.example.test/mcp`,
        enabled: true,
        source: { kind: "manual" as const },
      })),
    );
    expect(entries.map((entry) => entry.alias)).toEqual([
      "workspace-2",
      "catamorphic-2",
    ]);
  });
});
