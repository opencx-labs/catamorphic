import type { McpToolInfo } from "@catamorphic/mcp";
import type { McpToolPolicy } from "@catamorphic/sandbox";
import { describe, expect, it, vi } from "vitest";
import { McpAppViews } from "./mcp-app-view-authorization.js";

vi.mock("electron", () => ({ safeStorage: {} }));

const SOURCE: McpToolInfo = {
  name: "view",
  description: "Open the view",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  meta: { ui: { resourceUri: "ui://view" } },
};
const READ: McpToolInfo = {
  name: "read",
  description: "Read a person",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  annotations: { readOnlyHint: true },
};
const WRITE: McpToolInfo = {
  name: "write",
  description: "Write",
  inputSchema: { type: "object" },
};
const APP = {
  projectId: "project",
  sessionId: "session",
  toolKey: "probe/view",
  toolUseId: "call",
};

function fixture() {
  const policy: McpToolPolicy = { default: "allow" };
  const state = {
    profileId: "profile",
    ownerProfile: "profile",
    connectionId: "connection",
    securityRevision: 0,
    connection: {
      url: "https://server-a.test/mcp",
      headers: { Authorization: "Bearer account-a" },
    },
    agentId: "agent",
    missing: false,
    readOnly: false,
    policy,
    tools: [SOURCE, READ, WRITE],
  };
  const connectionIdentity = () =>
    JSON.stringify({ config: state.connection, epoch: state.securityRevision });
  const askApproval = vi.fn(
    async (_request?: { signal?: AbortSignal }): Promise<"allow" | "deny"> =>
      "allow",
  );
  const transported = vi.fn(async () => ({
    content: [{ type: "text", text: "result" }],
  }));
  const callTool = vi.fn(
    async (
      _profile: string,
      _view: string,
      name: string,
      _args: Record<string, unknown>,
      authorization?: {
        connectionId: string;
        beforeCall(tool: McpToolInfo): Promise<void>;
      },
    ) => {
      const tool = state.tools.find((entry) => entry.name === name);
      if (!tool || authorization?.connectionId !== state.connectionId)
        throw new Error("Connection changed");
      await authorization.beforeCall(tool);
      return transported();
    },
  );
  const context = vi.fn(async () => {
    if (state.missing) throw new Error("Missing session");
    return { agentId: state.agentId, readOnly: state.readOnly };
  });
  const views = new McpAppViews({
    core: () =>
      ({
        agentSessions: { toolContextForSession: context, askApproval },
      }) as never,
    agents: {
      defaultAgentId: () => "agent",
      capabilitySurface: () => ({
        profileId: state.profileId,
        readOnly: false,
        connectorsMounted: false,
        mcp: {
          connectionIds: { probe: state.connectionId },
          policies: { probe: [state.policy] },
        },
      }),
    } as never,
    identity: { tenantId: "tenant", externalUserId: "person" },
    ownerProfile: (ownerId) => (ownerId === 1 ? state.ownerProfile : undefined),
    mcpApps: {
      connectionIdentity,
      view: async () => ({
        toolKey: APP.toolKey,
        connectionId: state.connectionId,
        connectionIdentity: connectionIdentity(),
        resourceUri: "ui://view",
        html: "<h1>App</h1>",
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      }),
      tools: async () => state.tools,
      callTool,
    } as never,
  });
  const open = () => views.open({ ownerId: 1, profileId: "profile", app: APP });
  const call = (
    mountId: string,
    toolName = "read",
    args: Record<string, unknown> = { name: "Ada" },
  ) => views.call({ ownerId: 1, mountId, toolName, args });
  return {
    state,
    views,
    open,
    call,
    askApproval,
    transported,
    callTool,
    context,
  };
}

describe("host-owned MCP app view authorization", () => {
  it("binds the original chat and opaque document, allowing permitted tools while idle", async () => {
    const { views, open, call, context, askApproval, transported } = fixture();
    const mounted = await open();
    expect(mounted.mountId).not.toBe(APP.toolKey);
    const document = await views.document(mounted.mountId);
    expect(document.html).toContain(mounted.documentToken);
    expect(document.html.indexOf("work/view-ready")).toBeLessThan(
      document.html.indexOf("<h1>"),
    );
    await call(mounted.mountId);
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project", sessionId: "session" }),
    );
    expect(transported).toHaveBeenCalledOnce();
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("rejects a different profile and a window not owned by the host", async () => {
    const { state, open, views } = fixture();
    state.profileId = "other";
    await expect(open()).rejects.toThrow("another profile");
    await expect(
      views.open({ ownerId: 2, profileId: "profile", app: APP }),
    ).rejects.toThrow("window");
  });

  it("cannot open a view whose original session no longer exists", async () => {
    const { state, open } = fixture();
    state.missing = true;
    await expect(open()).rejects.toThrow("Missing session");
  });

  it("rejects unknown, denied, write-in-read-only, and malformed tool inputs", async () => {
    const { state, open, call, transported } = fixture();
    const { mountId } = await open();
    await expect(call(mountId, "unknown")).rejects.toThrow("Unknown tool");
    await expect(call(mountId, "read", { name: 123 })).rejects.toThrow(
      "Invalid arguments",
    );
    state.policy = { default: "allow", tools: { read: "deny" } };
    await expect(call(mountId)).rejects.toThrow("not allowed");
    state.readOnly = true;
    await expect(call(mountId, "write")).rejects.toThrow("not allowed");
    expect(transported).not.toHaveBeenCalled();
  });

  it.each([
    "connection",
    "agent",
    "profile",
    "resource",
    "source denied",
    "session",
  ])("revokes a mount when its %s changes", async (change) => {
    const { state, open, call, views, transported } = fixture();
    const { mountId } = await open();
    if (change === "connection") state.connectionId = "replacement";
    if (change === "agent") state.agentId = "other";
    if (change === "profile") state.ownerProfile = "other";
    if (change === "resource")
      state.tools = [
        { ...SOURCE, meta: { ui: { resourceUri: "ui://other" } } },
        READ,
      ];
    if (change === "source denied") state.policy = { tools: { view: "deny" } };
    if (change === "session") state.missing = true;
    await expect(call(mountId)).rejects.toThrow();
    await expect(views.document(mountId)).rejects.toThrow();
    expect(transported).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "account", "reauthorization"])(
    "revokes an idle mount after its %s changes under the same connection id",
    async (change) => {
      const { state, open, views, call, transported, callTool } = fixture();
      const { mountId } = await open();
      if (change === "endpoint")
        state.connection.url = "https://server-b.test/mcp";
      else if (change === "account")
        state.connection.headers.Authorization = "Bearer account-b";
      else state.securityRevision += 1;
      expect(state.connectionId).toBe("connection");
      await expect(views.document(mountId)).rejects.toThrow(
        "connection changed",
      );
      await expect(call(mountId)).rejects.toThrow("no longer available");
      expect(transported).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
      const replacement = await open();
      await expect(call(replacement.mountId)).resolves.toBeDefined();
    },
  );

  it.each(["endpoint", "account", "reauthorization"])(
    "refuses dispatch when its %s changes during approval",
    async (change) => {
      const { state, open, views, call, askApproval, transported } = fixture();
      state.policy = { default: "allow", tools: { write: "ask" } };
      askApproval.mockImplementation(async () => {
        if (change === "endpoint")
          state.connection.url = "https://server-b.test/mcp";
        else if (change === "account")
          state.connection.headers.Authorization = "Bearer account-b";
        else state.securityRevision += 1;
        return "allow";
      });
      const { mountId } = await open();
      await expect(call(mountId, "write")).rejects.toThrow(
        "connection changed",
      );
      await expect(views.document(mountId)).rejects.toThrow(
        "no longer available",
      );
      expect(transported).not.toHaveBeenCalled();
    },
  );

  it.each(["endpoint", "account", "reauthorization"])(
    "suppresses an in-flight result when its %s changes",
    async (change) => {
      const { state, open, views, call, transported, callTool } = fixture();
      const { mountId } = await open();
      let finish: (() => void) | undefined;
      transported.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { content: [{ type: "text", text: "PRIVATE_RESPONSE" }] };
      });
      const pending = call(mountId);
      const rejected = expect(pending).rejects.toThrow("connection changed");
      await vi.waitFor(() => expect(transported).toHaveBeenCalledOnce());
      if (change === "endpoint")
        state.connection.url = "https://server-b.test/mcp";
      else if (change === "account")
        state.connection.headers.Authorization = "Bearer account-b";
      else state.securityRevision += 1;
      finish?.();
      await rejected;
      await expect(views.document(mountId)).rejects.toThrow(
        "no longer available",
      );
      expect(callTool).toHaveBeenCalledOnce();
    },
  );

  it("cannot use or close another window's mount", async () => {
    const { open, views, call } = fixture();
    const { mountId } = await open();
    views.close({ ownerId: 2, mountId });
    await expect(
      views.call({
        ownerId: 2,
        mountId,
        toolName: "read",
        args: { name: "Ada" },
      }),
    ).rejects.toThrow("no longer available");
    await expect(call(mountId)).resolves.toBeDefined();
  });

  it("closes every mount when its host is destroyed or navigated", async () => {
    const { open, views, call } = fixture();
    const first = await open(),
      second = await open();
    views.closeOwner(1);
    await expect(call(first.mountId)).rejects.toThrow("no longer available");
    await expect(views.document(second.mountId)).rejects.toThrow(
      "no longer available",
    );
  });

  it("closes one document without revoking another open view", async () => {
    const { open, views, call } = fixture();
    const first = await open(),
      second = await open();
    views.close({ ownerId: 1, mountId: first.mountId });
    await expect(views.document(first.mountId)).rejects.toThrow(
      "no longer available",
    );
    await expect(call(second.mountId)).resolves.toBeDefined();
  });

  it("disposes every document and refuses new mounts after shutdown", async () => {
    const { open, views, call } = fixture();
    const first = await open(),
      second = await open();
    views.dispose();
    views.dispose();
    await expect(call(first.mountId)).rejects.toThrow("no longer available");
    await expect(views.document(second.mountId)).rejects.toThrow(
      "no longer available",
    );
    await expect(open()).rejects.toThrow("no longer available");
  });

  it("aborts a pending approval when the view manager is disposed", async () => {
    const { state, open, views, call, askApproval, transported } = fixture();
    state.policy = { default: "allow", tools: { write: "ask" } };
    askApproval.mockImplementation(
      async (request) =>
        new Promise((resolve) => {
          request?.signal?.addEventListener("abort", () => resolve("deny"), {
            once: true,
          });
        }),
    );
    const { mountId } = await open();
    const pending = call(mountId, "write");
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(askApproval).toHaveBeenCalledOnce());
    views.dispose();
    await failed;
    expect(transported).not.toHaveBeenCalled();
  });

  it("rechecks denied policy after an approval before contacting the raw transport", async () => {
    const { state, open, call, askApproval, transported } = fixture();
    state.policy = { default: "allow", tools: { write: "ask" } };
    askApproval.mockImplementation(async () => {
      state.policy = { default: "allow", tools: { write: "deny" } };
      return "allow";
    });
    const { mountId } = await open();
    await expect(call(mountId, "write")).rejects.toThrow("not allowed");
    expect(transported).not.toHaveBeenCalled();
  });

  it("rejects a schema change during approval", async () => {
    const { state, open, call, askApproval, transported } = fixture();
    state.policy = { default: "allow", tools: { write: "ask" } };
    askApproval.mockImplementation(async () => {
      state.tools = [
        SOURCE,
        READ,
        {
          ...WRITE,
          inputSchema: {
            type: "object",
            properties: { name: { type: "number" } },
          },
        },
      ];
      return "allow";
    });
    const { mountId } = await open();
    await expect(call(mountId, "write")).rejects.toThrow("Invalid arguments");
    expect(transported).not.toHaveBeenCalled();
  });

  it.each(["denied", "ask", "removed", "schema"])(
    "suppresses a pending target result when that tool is %s while the source view stays allowed",
    async (change) => {
      const { state, open, views, call, transported, callTool } = fixture();
      const { mountId } = await open();
      let finish: (() => void) | undefined;
      transported.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { content: [{ type: "text", text: "PRIVATE_RESPONSE" }] };
      });
      const pending = call(mountId);
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(transported).toHaveBeenCalledOnce());
      if (change === "denied")
        state.policy = { default: "allow", tools: { read: "deny" } };
      if (change === "ask")
        state.policy = { default: "allow", tools: { read: "ask" } };
      if (change === "removed") state.tools = [SOURCE, WRITE];
      if (change === "schema")
        state.tools = [
          SOURCE,
          {
            ...READ,
            inputSchema: {
              type: "object",
              properties: { name: { type: "number" } },
            },
          },
          WRITE,
        ];
      await expect(views.document(mountId)).resolves.toBeDefined();
      finish?.();
      await rejected;
      expect(callTool).toHaveBeenCalledOnce();
    },
  );

  it("does not deliver a completed call after the owning view closes", async () => {
    const { open, views, call, transported } = fixture();
    const { mountId } = await open();
    transported.mockImplementation(async () => {
      views.close({ ownerId: 1, mountId });
      return { content: [{ type: "text", text: "old" }] };
    });
    await expect(call(mountId)).rejects.toThrow("no longer available");
  });
});
