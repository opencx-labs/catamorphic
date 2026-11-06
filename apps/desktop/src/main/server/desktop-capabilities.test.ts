import type {
  AgentCapability,
  AgentCapabilityContext,
  AgentCapabilityInvocation,
} from "@catamorphic/core";
import type { McpToolInfo } from "@catamorphic/mcp";
import type { McpToolPolicy } from "@catamorphic/sandbox";
import { describe, expect, it, vi } from "vitest";
import { desktopCapabilitySource } from "./desktop-capabilities.js";

vi.mock("electron", () => ({ safeStorage: {} }));

const READ: McpToolInfo = {
  name: "read",
  description: "Read private data",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const WRITE: McpToolInfo = {
  name: "write",
  description: "Write data",
  inputSchema: { type: "object" },
};
const context: AgentCapabilityContext = {
  identity: { tenantId: "tenant", externalUserId: "person" },
  projectId: "project",
  sessionId: "session",
  allocationId: "allocation",
};
const invocation: AgentCapabilityInvocation = {
  ...context,
  requestId: "request",
  progress: async () => {},
};

function fixture() {
  const policy: McpToolPolicy = { default: "allow" };
  const state = {
    binding: {
      endpoint: "https://server-a.test/mcp",
      account: "account-a",
      epoch: 0,
    },
    token: "access-a",
    policy,
    readOnly: false,
    tools: [READ, WRITE],
  };
  const identity = () => JSON.stringify(state.binding);
  const askApproval = vi.fn(async (): Promise<"allow" | "deny"> => "allow");
  const transported = vi.fn(async () => ({
    content: [{ type: "text", text: "result" }],
    structuredContent: { name: "Ada" },
  }));
  const callTool = vi.fn(
    async (
      _profile: string,
      _key: string,
      name: string,
      _args: Record<string, unknown>,
      authorization?: {
        connectionId: string;
        connectionIdentity?: string;
        beforeCall(tool: McpToolInfo, roster: McpToolInfo[]): Promise<void>;
      },
    ) => {
      if (
        authorization?.connectionId !== "connection" ||
        authorization.connectionIdentity !== identity()
      )
        throw new Error("Connection changed");
      const tool = state.tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error("Unknown tool");
      await authorization.beforeCall(tool, state.tools);
      return transported();
    },
  );
  const tools = vi.fn(
    async (
      _profile: string,
      _server: string,
      _id?: string,
      expectedIdentity?: string,
    ) => {
      if (expectedIdentity && expectedIdentity !== identity())
        throw new Error("Connection changed");
      return state.tools;
    },
  );
  const toolContextForSession = vi.fn(async () => ({
    agentId: "agent",
    readOnly: state.readOnly,
  }));
  const source = desktopCapabilitySource({
    core: () =>
      ({
        agentSessions: {
          askApproval,
          toolContextForSession,
        },
      }) as never,
    agents: {
      defaultAgentId: () => "agent",
      capabilitySurface: () => ({
        revision: "surface",
        profileId: "profile",
        readOnly: false,
        tools: [],
        connectorsMounted: false,
        mcp: {
          connectionIds: { probe: "connection" },
          policies: { probe: [state.policy] },
        },
      }),
    } as never,
    mcpApps: { connectionIdentity: identity, tools, callTool } as never,
    workingDirectory: async () => undefined,
  });
  const discover = async (name: string) => {
    const definitions = await source(context, { name });
    const tool = definitions.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing capability ${name}`);
    return tool;
  };
  const invoke = async (tool: AgentCapability) => {
    const prepared = tool.prepare({});
    await prepared.beforeInvoke?.(invocation);
    return prepared.execute(invocation);
  };
  return {
    state,
    source,
    discover,
    invoke,
    askApproval,
    transported,
    callTool,
    tools,
    toolContextForSession,
  };
}

function replace(state: ReturnType<typeof fixture>["state"], change: string) {
  if (change === "endpoint")
    state.binding.endpoint = "https://server-b.test/mcp";
  if (change === "account") state.binding.account = "account-b";
  if (change === "aba") state.binding.epoch += 2;
}

describe("connection identity in the capability catalog", () => {
  it("forwards an allowed call with a stable connection identity and no second approval", async () => {
    const { discover, invoke, askApproval, transported, callTool } = fixture();
    const tool = await discover("connections.probe.read");
    await expect(invoke(tool)).resolves.toEqual({ name: "Ada" });
    expect(callTool).toHaveBeenCalledWith(
      "profile",
      "probe/read",
      "read",
      {},
      expect.objectContaining({
        connectionId: "connection",
        connectionIdentity: expect.any(String),
        beforeCall: expect.any(Function),
      }),
    );
    expect(transported).toHaveBeenCalledOnce();
    expect(askApproval).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "account", "aba"])(
    "changes definition and consent revisions and rejects stale tools after %s replacement",
    async (change) => {
      const { state, discover, invoke, transported } = fixture();
      state.policy = { default: "allow", tools: { write: "ask" } };
      const original = await discover("connections.probe.write");
      const catalog = await discover("connections.probe");
      replace(state, change);
      const fresh = await discover("connections.probe.write");
      const freshCatalog = await discover("connections.probe");
      expect(fresh.revision).not.toBe(original.revision);
      expect(fresh.consent).not.toBe(original.consent);
      expect(freshCatalog.revision).not.toBe(catalog.revision);
      await expect(original.authorize(context)).resolves.toBe(false);
      await expect(invoke(original)).rejects.toThrow("connection changed");
      await expect(catalog.prepare({}).execute(invocation)).rejects.toThrow(
        "connection changed",
      );
      expect(transported).not.toHaveBeenCalled();
    },
  );

  it.each(["endpoint", "account", "aba"])(
    "does not dispatch to a replacement %s after approval",
    async (change) => {
      const { state, discover, invoke, askApproval, transported } = fixture();
      state.policy = { default: "allow", tools: { write: "ask" } };
      askApproval.mockImplementation(async () => {
        replace(state, change);
        return "allow";
      });
      const original = await discover("connections.probe.write");
      await expect(invoke(original)).rejects.toThrow("connection changed");
      expect(transported).not.toHaveBeenCalled();
    },
  );

  it.each(["endpoint", "account", "aba"])(
    "suppresses a completed private result after %s replacement",
    async (change) => {
      const { state, discover, invoke, transported } = fixture();
      const original = await discover("connections.probe.read");
      let finish: (() => void) | undefined;
      transported.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          content: [{ type: "text", text: "PRIVATE_RESPONSE" }],
          structuredContent: { name: "PRIVATE_RESPONSE" },
        };
      });
      const pending = invoke(original);
      const rejected = expect(pending).rejects.toThrow("Connection changed");
      await vi.waitFor(() => expect(transported).toHaveBeenCalledOnce());
      replace(state, change);
      finish?.();
      await rejected;
    },
  );

  it("rejects an Allow to Ask policy change between approval and execute entry", async () => {
    const { state, discover, transported, callTool, askApproval } = fixture();
    const original = await discover("connections.probe.write");
    const prepared = original.prepare({});
    await prepared.beforeInvoke?.(invocation);
    state.policy = { default: "allow", tools: { write: "ask" } };
    await expect(prepared.execute(invocation)).rejects.toThrow(
      "Tool access changed",
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(transported).not.toHaveBeenCalled();
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("does not adopt a new Ask policy while execute's first live lookup waits", async () => {
    const {
      state,
      discover,
      transported,
      callTool,
      askApproval,
      toolContextForSession,
    } = fixture();
    const original = await discover("connections.probe.write");
    const prepared = original.prepare({});
    await prepared.beforeInvoke?.(invocation);
    let release: (() => void) | undefined;
    const pendingLookup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    toolContextForSession.mockImplementationOnce(async () => {
      entered = true;
      await pendingLookup;
      return { agentId: "agent", readOnly: state.readOnly };
    });
    const pending = prepared.execute(invocation);
    const rejected = expect(pending).rejects.toThrow("Tool access changed");
    await vi.waitFor(() => expect(entered).toBe(true));
    state.policy = { default: "allow", tools: { write: "ask" } };
    release?.();
    await rejected;
    expect(callTool).not.toHaveBeenCalled();
    expect(transported).not.toHaveBeenCalled();
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("preserves a legitimate Always Allow answer against the definition snapshot", async () => {
    const { state, discover, invoke, askApproval, transported } = fixture();
    state.policy = { default: "allow", tools: { write: "ask" } };
    const original = await discover("connections.probe.write");
    askApproval.mockImplementation(async () => {
      state.policy = { default: "allow", tools: { write: "allow" } };
      return "allow";
    });
    await expect(invoke(original)).resolves.toEqual({ name: "Ada" });
    expect(transported).toHaveBeenCalledOnce();
  });

  it("keeps consent and definitions usable across routine token renewal", async () => {
    const { state, discover, invoke, askApproval, transported } = fixture();
    state.policy = { default: "allow", tools: { write: "ask" } };
    const original = await discover("connections.probe.write");
    state.token = "renewed-a";
    const renewed = await discover("connections.probe.write");
    expect(renewed.revision).toBe(original.revision);
    expect(renewed.consent).toBe(original.consent);
    askApproval.mockImplementation(async () => {
      state.token = "renewed-again-a";
      return "allow";
    });
    await expect(invoke(original)).resolves.toEqual({ name: "Ada" });
    expect(transported).toHaveBeenCalledOnce();
  });

  it.each(["denied", "removed", "schema"])(
    "suppresses the result when the actual target is %s during a call",
    async (change) => {
      const { state, discover, invoke, transported } = fixture();
      const original = await discover("connections.probe.read");
      transported.mockImplementation(async () => {
        if (change === "denied") state.policy = { tools: { read: "deny" } };
        if (change === "removed") state.tools = [WRITE];
        if (change === "schema")
          state.tools = [
            { ...READ, inputSchema: { type: "object", required: ["new"] } },
            WRITE,
          ];
        return {
          content: [{ type: "text", text: "PRIVATE_RESPONSE" }],
          structuredContent: { name: "PRIVATE_RESPONSE" },
        };
      });
      await expect(invoke(original)).rejects.toThrow();
    },
  );
});
