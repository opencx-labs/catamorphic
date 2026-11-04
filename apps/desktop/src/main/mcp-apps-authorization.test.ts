import type { ConnectedMcpServer, McpToolInfo } from "@catamorphic/mcp";
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<ConnectedMcpServer>>(),
}));
vi.mock("@catamorphic/mcp", () => ({
  connectMcpServer: fake.connect,
  uiResourceUri: () => "ui://view",
  mcpConnectionLost: () => false,
  bearerHeaders: (oauth?: { tokens?: { access_token?: string } }) =>
    oauth?.tokens?.access_token
      ? { Authorization: `Bearer ${oauth.tokens.access_token}` }
      : {},
}));
vi.mock("electron", () => ({ safeStorage: {} }));

import type { ConnectionsStore, McpConnection } from "./connections-store.js";
import { McpAppsService, mcpAppViewCsp } from "./mcp-apps.js";

const TOOL: McpToolInfo = {
  name: "view",
  description: "View",
  inputSchema: { type: "object" },
};
function fixture() {
  let changed = () => {};
  const connection: McpConnection = {
    id: "connection",
    name: "probe",
    transport: "stdio",
    command: "fake-only",
    enabled: true,
    source: { kind: "manual" },
  };
  const security = { revision: 0 };
  const store = {
    securityRevision: () => security.revision,
    onChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
    list: () => [connection],
  } as unknown as ConnectionsStore;
  const callToolRaw = vi.fn(async () => ({ content: [] }));
  const refreshTools = vi.fn(async (): Promise<McpToolInfo[]> => [TOOL]);
  const readResource = vi.fn(async () => ({
    uri: "ui://view",
    text: "<html>App</html>",
    meta: {
      ui: {
        csp: {
          connectDomains: [
            "api.example.com",
            "https://*.example.com:443",
            "http://unsafe.test",
            "*",
            "good.test; script-src *",
            "https://bad.test/path",
          ],
          resourceDomains: ["cdn.example.com"],
        },
      },
    },
  }));
  const close = vi.fn(async () => {});
  const client = {
    tools: [TOOL],
    refreshTools,
    callToolRaw,
    readResource,
    callTool: vi.fn(async () => ""),
    close,
  };
  fake.connect.mockReset().mockResolvedValue(client);
  const service = new McpAppsService({ connectionsFor: () => store });
  return {
    service,
    changed: () => changed(),
    connection,
    security,
    callToolRaw,
    refreshTools,
    readResource,
    client,
    close,
  };
}

describe("MCP app transport authorization fence", () => {
  it("qualifies every declared CSP host with HTTPS and rejects unsafe expressions", async () => {
    const { service } = fixture();
    const view = await service.view("profile", "probe/view", "connection");
    expect(view.csp.connectDomains).toEqual([
      "https://api.example.com",
      "https://*.example.com:443",
    ]);
    expect(view.csp.resourceDomains).toEqual(["https://cdn.example.com"]);
    expect(mcpAppViewCsp(view)).toContain(
      "connect-src https://api.example.com https://*.example.com:443",
    );
    await service.dispose();
  });

  it("retires a failed refresh client before retrying its safe tool listing", async () => {
    const { service, client, close, refreshTools, callToolRaw } = fixture();
    refreshTools.mockRejectedValue(new Error("connection lost"));
    const freshRefresh = vi.fn(async () => [
      { ...TOOL, description: "Fresh roster" },
    ]);
    fake.connect
      .mockReset()
      .mockResolvedValueOnce(client)
      .mockResolvedValueOnce({
        ...client,
        refreshTools: freshRefresh,
        close: vi.fn(async () => {}),
      });
    await expect(
      service.tools("profile", "probe", "connection"),
    ).resolves.toMatchObject([{ description: "Fresh roster" }]);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(refreshTools).toHaveBeenCalledOnce();
    expect(freshRefresh).toHaveBeenCalledOnce();
    expect(callToolRaw).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("does not return a raw result after its client is invalidated", async () => {
    const { service, callToolRaw, changed } = fixture();
    let finish: (() => void) | undefined;
    callToolRaw.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { content: [] };
    });
    const pending = service.callTool(
      "profile",
      "probe/view",
      "view",
      {},
      {
        connectionId: "connection",
        beforeCall: async () => {},
      },
    );
    const rejected = expect(pending).rejects.toThrow("connection changed");
    await vi.waitFor(() => expect(callToolRaw).toHaveBeenCalledOnce());
    changed();
    finish?.();
    await rejected;
    expect(callToolRaw).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it.each(["endpoint", "header", "command", "environment", "oauth"])(
    "pins the effective %s configuration without exposing credentials",
    async (change) => {
      const { service, connection, security, callToolRaw } = fixture();
      if (change === "endpoint" || change === "header" || change === "oauth") {
        connection.transport = "http";
        connection.url = "https://server-a.test/mcp";
      }
      if (change === "header")
        connection.headers = { Authorization: "Bearer account-a" };
      if (change === "environment") connection.env = { TOKEN: "account-a" };
      if (change === "oauth")
        connection.oauth = {
          tokens: {
            access_token: "account-a",
            token_type: "Bearer",
            refresh_token: "refresh-a",
          },
        };
      const view = await service.view("profile", "probe/view", "connection");
      expect(view.connectionIdentity).not.toContain("account-a");
      if (change === "endpoint") connection.url = "https://server-b.test/mcp";
      if (change === "header")
        connection.headers = { Authorization: "Bearer account-b" };
      if (change === "command") connection.command = "replacement-server";
      if (change === "environment") connection.env = { TOKEN: "account-b" };
      if (change === "oauth") {
        security.revision += 1;
        connection.oauth = {
          tokens: {
            access_token: "account-b",
            token_type: "Bearer",
            refresh_token: "refresh-b",
          },
        };
      }
      expect(
        service.connectionIdentity("profile", "probe", "connection"),
      ).not.toBe(view.connectionIdentity);
      await expect(
        service.tools(
          "profile",
          "probe",
          "connection",
          view.connectionIdentity,
        ),
      ).rejects.toThrow("connection changed");
      await expect(
        service.callTool(
          "profile",
          "probe/view",
          "view",
          {},
          {
            connectionId: "connection",
            connectionIdentity: view.connectionIdentity,
            beforeCall: async () => {},
          },
        ),
      ).rejects.toThrow("connection changed");
      expect(callToolRaw).not.toHaveBeenCalled();
      await service.dispose();
    },
  );

  it("keeps a mount's identity across normal OAuth renewal while replacing its transport client", async () => {
    const { service, connection, client, close, security, callToolRaw } =
      fixture();
    connection.transport = "http";
    connection.url = "https://server.test/mcp";
    connection.oauth = {
      tokens: {
        access_token: "account-a",
        token_type: "Bearer",
        refresh_token: "refresh-a",
      },
    };
    const view = await service.view("profile", "probe/view", "connection");
    connection.oauth = {
      tokens: {
        access_token: "renewed-account-a",
        token_type: "Bearer",
        refresh_token: "renewed-refresh-a",
      },
      tokensObtainedAt: Date.now(),
    };
    expect(security.revision).toBe(0);
    expect(service.connectionIdentity("profile", "probe", "connection")).toBe(
      view.connectionIdentity,
    );
    fake.connect.mockResolvedValue({ ...client, close: vi.fn(async () => {}) });
    await expect(
      service.callTool(
        "profile",
        "probe/view",
        "view",
        {},
        {
          connectionId: "connection",
          connectionIdentity: view.connectionIdentity,
          beforeCall: async () => {},
        },
      ),
    ).resolves.toEqual({ content: [] });
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(callToolRaw).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("does not restore an old mount's authority after endpoint A to B to A", async () => {
    const { service, connection, security } = fixture();
    const view = await service.view("profile", "probe/view", "connection");
    connection.command = "replacement-server";
    security.revision += 1;
    connection.command = "fake-only";
    security.revision += 1;
    expect(
      service.connectionIdentity("profile", "probe", "connection"),
    ).not.toBe(view.connectionIdentity);
    await expect(
      service.tools("profile", "probe", "connection", view.connectionIdentity),
    ).rejects.toThrow("connection changed");
    await service.dispose();
  });

  it("keeps the identity stable across policy and cached-roster updates", async () => {
    const { service, connection } = fixture();
    const identity = service.connectionIdentity(
      "profile",
      "probe",
      "connection",
    );
    connection.toolPolicy = { default: "allow", tools: { view: "allow" } };
    connection.ceiling = {
      source: "organization",
      policy: { default: "allow" },
    };
    connection.tools = [{ name: "new", description: "Updated cached roster" }];
    expect(service.connectionIdentity("profile", "probe", "connection")).toBe(
      identity,
    );
    await service.dispose();
  });

  it("does not re-prompt already-authorized raw capability calls", async () => {
    const { service, callToolRaw, refreshTools } = fixture();
    await service.callTool("profile", "probe/view", "view", {});
    expect(callToolRaw).toHaveBeenCalledOnce();
    expect(refreshTools).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("uses a fresh roster and never forwards a removed tool", async () => {
    const { service, callToolRaw, refreshTools } = fixture();
    refreshTools.mockResolvedValue([]);
    const beforeCall = vi.fn();
    await expect(
      service.callTool(
        "profile",
        "probe/view",
        "view",
        {},
        {
          connectionId: "connection",
          beforeCall,
        },
      ),
    ).rejects.toThrow("Unknown tool");
    expect(beforeCall).not.toHaveBeenCalled();
    expect(callToolRaw).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("does not forward when policy authorization fails", async () => {
    const { service, callToolRaw } = fixture();
    await expect(
      service.callTool(
        "profile",
        "probe/view",
        "view",
        {},
        {
          connectionId: "connection",
          beforeCall: async () => {
            throw new Error("Denied");
          },
        },
      ),
    ).rejects.toThrow("Denied");
    expect(callToolRaw).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("pins the connection id rather than a reused alias", async () => {
    const { service, connection, callToolRaw } = fixture();
    connection.id = "replacement";
    await expect(
      service.callTool(
        "profile",
        "probe/view",
        "view",
        {},
        {
          connectionId: "connection",
          beforeCall: async () => {},
        },
      ),
    ).rejects.toThrow("connection changed");
    expect(callToolRaw).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("refuses an invalidated client after awaiting its final authorization", async () => {
    const { service, changed, callToolRaw } = fixture();
    await expect(
      service.callTool(
        "profile",
        "probe/view",
        "view",
        {},
        {
          connectionId: "connection",
          beforeCall: async () => {
            changed();
          },
        },
      ),
    ).rejects.toThrow("connection changed");
    expect(callToolRaw).not.toHaveBeenCalled();
    await service.dispose();
  });
});
