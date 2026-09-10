import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ safeStorage: {} }));

import {
  type McpConnection,
  toAgentMcpServer,
  toPublicConnection,
} from "./connections-store.js";

const connection: McpConnection = {
  id: "github",
  name: "GitHub",
  enabled: true,
  source: { kind: "manual" },
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for plugin credential expansion
  headers: { Authorization: "Bearer ${CATAMORPHIC_TEST_GITHUB_TOKEN}" },
};
describe("connection credentials", () => {
  it("expands stored secrets only for the harness, never in public metadata", () => {
    const configured = {
      ...connection,
      env: { CATAMORPHIC_TEST_GITHUB_TOKEN: "test-secret" },
    };
    expect(toAgentMcpServer(configured)).toMatchObject({
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(JSON.stringify(toPublicConnection(configured))).not.toContain(
      "test-secret",
    );
  });
  it("reports missing authorization without starting a server with a literal placeholder", () => {
    expect(toAgentMcpServer(connection)).toBeUndefined();
    expect(toPublicConnection(connection).authorizationError).toContain(
      "CATAMORPHIC_TEST_GITHUB_TOKEN",
    );
  });
});
