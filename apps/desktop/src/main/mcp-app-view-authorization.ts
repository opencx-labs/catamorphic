import { randomBytes } from "node:crypto";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { type McpToolInfo, uiResourceUri } from "@catamorphic/mcp";
import { resolveToolPermissionAcross } from "@catamorphic/sandbox";
import { z } from "zod";
import type { McpAppsService, McpAppView } from "./mcp-apps.js";
import {
  connectorToolPermitted,
  decideHostToolCall,
} from "./server/agent-mcp-policy.js";
import type { DesktopAgentRegistry } from "./server/agent-registry.js";

/** The caller context is read again after any permission wait. */
export async function liveConnectorContext(input: {
  core: CatamorphicCore;
  agents: DesktopAgentRegistry;
  identity: Identity;
  projectId: string;
  sessionId: string;
  server: string;
}) {
  const session = await input.core.agentSessions?.toolContextForSession({
    identity: input.identity,
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  if (!session) throw new Error("The original chat is unavailable");
  const agentId =
    session.agentId ?? input.agents.defaultAgentId(input.projectId);
  const surface = agentId ? input.agents.capabilitySurface(agentId) : undefined;
  const connectionId = surface?.mcp.connectionIds[input.server];
  if (!surface || !connectionId || surface.mcp.nativeServers?.[input.server])
    throw new Error("This chat has no such connector");
  const merged = [
    ...(surface.mcp.policies[input.server] ?? []),
    ...(session.toolPolicies?.[input.server] ?? []),
  ];
  return {
    agentId,
    profileId: surface.profileId,
    connectionId,
    mounted: surface.connectorsMounted,
    readOnly: surface.readOnly || session.readOnly,
    layers: merged.length ? merged : undefined,
  };
}

export type LiveConnectorContext = Awaited<
  ReturnType<typeof liveConnectorContext>
> & { connectionIdentity?: string };

export function assertConnectorTool(input: {
  context: LiveConnectorContext;
  tool: McpToolInfo;
  args: Record<string, unknown>;
}): void {
  if (!connectorToolPermitted({ ...input.context, tool: input.tool }))
    throw new Error(`Tool is not allowed: ${input.tool.name}`);
  // Use the same JSON Schema conversion as the capability catalog. Invalid
  // or unsupported schemas fail closed, rather than weakening validation.
  if (!z.fromJSONSchema(input.tool.inputSchema).safeParse(input.args).success)
    throw new Error(`Invalid arguments for ${input.tool.name}`);
}

export function connectorCallSnapshot(
  context: LiveConnectorContext,
  tool: McpToolInfo,
) {
  return {
    call: JSON.stringify({
      agentId: context.agentId,
      profileId: context.profileId,
      connectionId: context.connectionId,
      connectionIdentity: context.connectionIdentity,
      readOnly: context.readOnly,
      layers: context.layers,
      schema: tool.inputSchema,
      annotations: tool.annotations,
    }),
    scope: JSON.stringify({
      agentId: context.agentId,
      profileId: context.profileId,
      connectionId: context.connectionId,
      connectionIdentity: context.connectionIdentity,
      mounted: context.mounted,
      readOnly: context.readOnly,
    }),
    tool: JSON.stringify(tool),
  };
}

/** A policy or schema edit while approval is pending requires a new call. */
export function assertConnectorCallUnchanged(input: {
  before: ReturnType<typeof connectorCallSnapshot>;
  after: LiveConnectorContext;
  currentTool: McpToolInfo;
}): void {
  const after = connectorCallSnapshot(input.after, input.currentTool);
  if (input.before.call === after.call) return;
  // "Always allow" may have updated the connection policy as part of
  // answering this very request. It is safe only if all current layers allow.
  if (
    input.before.scope === after.scope &&
    input.before.tool === after.tool &&
    resolveToolPermissionAcross(
      input.after.layers,
      input.currentTool.name,
      input.currentTool.annotations,
    ) === "allow"
  )
    return;
  throw new Error("Tool access changed while the call was pending. Try again.");
}

export const McpAppOpenSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  toolKey: z.string().min(3),
  toolUseId: z.string().min(1),
});
export type McpAppOpen = z.infer<typeof McpAppOpenSchema>;

interface Mount {
  id: string;
  ownerId: number;
  profileId: string;
  input: McpAppOpen;
  context: LiveConnectorContext;
  view: McpAppView;
  abort: AbortController;
  documentToken: string;
}

/** Host-owned, revocable authority for one rendered MCP document. */
export class McpAppViews {
  private readonly mounts = new Map<string, Mount>();
  private disposed = false;

  constructor(
    private readonly deps: {
      core(): CatamorphicCore;
      agents: DesktopAgentRegistry;
      identity: Identity;
      mcpApps: McpAppsService;
      /** Checks the host webContents still belongs to this profile. */
      ownerProfile(ownerId: number): string | undefined;
    },
  ) {}

  private async context(input: McpAppOpen) {
    const slash = input.toolKey.indexOf("/");
    if (slash <= 0 || slash === input.toolKey.length - 1)
      throw new Error("Invalid app tool key");
    return liveConnectorContext({
      ...this.deps,
      core: this.deps.core(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      server: input.toolKey.slice(0, slash),
    });
  }

  async open(input: { ownerId: number; profileId: string; app: McpAppOpen }) {
    if (this.disposed) throw new Error("This app view is no longer available");
    const app = McpAppOpenSchema.parse(input.app);
    if (this.deps.ownerProfile(input.ownerId) !== input.profileId)
      throw new Error("The app window is unavailable");
    const context = await this.context(app);
    if (context.profileId !== input.profileId)
      throw new Error("The app belongs to another profile");
    const view = await this.deps.mcpApps.view(
      input.profileId,
      app.toolKey,
      context.connectionId,
    );
    if (this.disposed) throw new Error("This app view is no longer available");
    const mount: Mount = {
      id: randomBytes(32).toString("base64url"),
      ownerId: input.ownerId,
      profileId: input.profileId,
      input: app,
      context,
      view,
      abort: new AbortController(),
      documentToken: randomBytes(32).toString("base64url"),
    };
    this.mounts.set(mount.id, mount);
    try {
      await this.authorize(mount);
      return { ...view, mountId: mount.id, documentToken: mount.documentToken };
    } catch (error) {
      this.revoke(mount);
      throw error;
    }
  }

  /** Called by the isolated guest-document route using only its opaque id. */
  async document(id: string): Promise<McpAppView> {
    const mount = this.mountFor(id);
    await this.authorize(mount);
    // This runs before the resource's own scripts. The renderer pins this
    // document's opaque origin, so a navigation retaining its WindowProxy
    // cannot inherit the old document's bridge authority.
    const ready = JSON.stringify({
      jsonrpc: "2.0",
      method: "work/view-ready",
      params: { token: mount.documentToken },
    });
    // Replies travel through a port belonging to this document. Posting to
    // its WindowProxy with "*" could disclose an in-flight result to a new
    // page before that navigation's load event reaches the renderer.
    const bootstrap = `<script>(()=>{const c=new MessageChannel();c.port1.onmessage=e=>window.dispatchEvent(new MessageEvent("message",{data:e.data.data,origin:e.data.origin,source:parent}));parent.postMessage(${ready},"*",[c.port2])})()</script>`;
    const head = /<head[^>]*>/i.exec(mount.view.html);
    const doctype = /^\s*<!doctype[^>]*>/i.exec(mount.view.html);
    const at = head ? head.index + head[0].length : (doctype?.[0].length ?? 0);
    return {
      ...mount.view,
      html: `${mount.view.html.slice(0, at)}${bootstrap}${mount.view.html.slice(at)}`,
    };
  }

  private mountFor(id: string, ownerId?: number): Mount {
    const mount = this.mounts.get(id);
    if (
      this.disposed ||
      !mount ||
      (ownerId !== undefined && mount.ownerId !== ownerId)
    )
      throw new Error("This app view is no longer available");
    if (this.deps.ownerProfile(mount.ownerId) !== mount.profileId) {
      this.revoke(mount);
      throw new Error("The app window changed");
    }
    mount.abort.signal.throwIfAborted();
    return mount;
  }

  private async authorize(mount: Mount, roster?: McpToolInfo[]) {
    // Fetch the roster before reading live policy so network waits cannot
    // leave an earlier permission decision at the transport boundary.
    const slash = mount.input.toolKey.indexOf("/");
    this.assertConnection(mount);
    const tools =
      roster ??
      (await this.deps.mcpApps.tools(
        mount.profileId,
        mount.input.toolKey.slice(0, slash),
        mount.view.connectionId,
        mount.view.connectionIdentity,
      ));
    const current = await this.context(mount.input);
    if (
      current.profileId !== mount.profileId ||
      current.connectionId !== mount.view.connectionId ||
      current.agentId !== mount.context.agentId
    ) {
      this.revoke(mount);
      throw new Error("The app connection or chat changed. Reopen the app.");
    }
    const source = tools.find(
      (tool) => tool.name === mount.input.toolKey.slice(slash + 1),
    );
    if (
      !source ||
      uiResourceUri(source) !== mount.view.resourceUri ||
      !connectorToolPermitted({ ...current, tool: source })
    ) {
      this.revoke(mount);
      throw new Error("This app view is no longer allowed");
    }
    this.assertConnection(mount);
    this.mountFor(mount.id, mount.ownerId);
    return { current, tools };
  }

  private assertConnection(mount: Mount): void {
    const serverKey = mount.input.toolKey.slice(
      0,
      mount.input.toolKey.indexOf("/"),
    );
    try {
      if (
        this.deps.mcpApps.connectionIdentity(
          mount.profileId,
          serverKey,
          mount.view.connectionId,
        ) === mount.view.connectionIdentity
      )
        return;
    } catch {
      /* Missing or unreadable configuration also revokes the mount. */
    }
    this.revoke(mount);
    throw new Error("The app connection changed. Reopen the app.");
  }

  async call(input: {
    ownerId: number;
    mountId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const mount = this.mountFor(input.mountId, input.ownerId);
    const { current: before, tools } = await this.authorize(mount);
    const tool = tools.find((entry) => entry.name === input.toolName);
    if (!tool) throw new Error(`Unknown tool: ${input.toolName}`);
    assertConnectorTool({ context: before, tool, args: input.args });
    const server = mount.input.toolKey.slice(
      0,
      mount.input.toolKey.indexOf("/"),
    );
    const snapshot = connectorCallSnapshot(before, tool);
    const verdict = await decideHostToolCall({
      core: this.deps.core(),
      sessionId: mount.input.sessionId,
      server,
      tool: tool.name,
      input: input.args,
      layers: before.layers,
      annotations: tool.annotations,
      signal: mount.abort.signal,
    });
    if (!verdict.allowed) throw new Error(verdict.message);
    const result = await this.deps.mcpApps.callTool(
      mount.profileId,
      mount.input.toolKey,
      tool.name,
      input.args,
      {
        connectionId: mount.view.connectionId,
        connectionIdentity: mount.view.connectionIdentity,
        beforeCall: async (currentTool, roster) => {
          const { current: after } = await this.authorize(mount, roster);
          assertConnectorTool({
            context: after,
            tool: currentTool,
            args: input.args,
          });
          assertConnectorCallUnchanged({
            before: snapshot,
            after,
            currentTool,
          });
        },
      },
    );
    // Closing/replacing a view cannot deliver an old response to a new document.
    this.mountFor(mount.id, input.ownerId);
    const { current: after, tools: currentTools } = await this.authorize(mount);
    const currentTool = currentTools.find(
      (entry) => entry.name === input.toolName,
    );
    if (!currentTool) throw new Error(`Unknown tool: ${input.toolName}`);
    assertConnectorTool({
      context: after,
      tool: currentTool,
      args: input.args,
    });
    assertConnectorCallUnchanged({ before: snapshot, after, currentTool });
    return result;
  }

  close(input: { ownerId: number; mountId: string }): void {
    const mount = this.mounts.get(input.mountId);
    if (mount?.ownerId === input.ownerId) this.revoke(mount);
  }

  closeOwner(ownerId: number): void {
    for (const mount of this.mounts.values()) {
      if (mount.ownerId === ownerId) this.revoke(mount);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const mount of this.mounts.values()) this.revoke(mount);
  }

  private revoke(mount: Mount): void {
    this.mounts.delete(mount.id);
    mount.abort.abort();
  }
}
