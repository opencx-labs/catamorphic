import {
  type ConnectedMcpServer,
  connectMcpServer,
  uiResourceUri,
} from "@catamorphic/mcp";
import type { ConnectionsStore, McpConnection } from "./connections-store.js";
import { connectionServerKeys, toAgentMcpServer } from "./connections-store.js";

/**
 * Host side of MCP Apps (extension io.modelcontextprotocol/ui): the
 * desktop holds every connection's config, so it can — independently of
 * whichever harness made a tool call — list which tools declare a `ui://`
 * view, fetch and cache the HTML template, and route the embedded view's
 * own `tools/call` requests over the host's connection.
 *
 * Tool keys are `<serverKey>/<toolName>`, exactly the toolName the
 * harnesses put on tool_call events — the renderer joins chat events to
 * views with no extra mapping.
 */

export interface McpAppView {
  toolKey: string;
  /** The full document to render in the sandboxed iframe. */
  html: string;
  /**
   * CSP allowances the resource's `_meta.ui.csp` declared. The renderer
   * builds the iframe CSP from these; absent lists mean default-deny.
   */
  csp: { connectDomains: string[]; resourceDomains: string[] };
  prefersBorder: boolean;
}

export class McpAppsService {
  /** Live client connections, keyed by profile + connection id. */
  private readonly pool = new Map<string, Promise<ConnectedMcpServer>>();
  private readonly watchedProfiles = new Set<string>();

  constructor(
    private readonly deps: {
      connectionsFor(profileId: string): ConnectionsStore;
    },
  ) {}

  /** `"server/tool"` → ui resource uri, for every enabled connection. */
  async uiTools(profileId: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    await Promise.all(
      [...this.keyed(profileId)].map(async ([serverKey, connection]) => {
        try {
          const server = await this.connect(profileId, connection);
          for (const tool of server.tools) {
            const uri = uiResourceUri(tool);
            if (uri) map[`${serverKey}/${tool.name}`] = uri;
          }
        } catch {
          // A dead server simply contributes no app views.
        }
      }),
    );
    return map;
  }

  /** Fetch the `ui://` template behind a tool key. */
  async view(profileId: string, toolKey: string): Promise<McpAppView> {
    const { connection, toolName } = this.resolve(profileId, toolKey);
    const server = await this.connect(profileId, connection);
    const tool = server.tools.find((entry) => entry.name === toolName);
    const uri = tool ? uiResourceUri(tool) : undefined;
    if (!uri) throw new Error(`Tool ${toolKey} declares no app view`);
    const resource = await server.readResource(uri);
    const html =
      resource.text ??
      (resource.blob
        ? Buffer.from(resource.blob, "base64").toString("utf-8")
        : "");
    if (!html) throw new Error(`App view ${uri} is empty`);
    const ui =
      resource.meta && typeof resource.meta.ui === "object"
        ? (resource.meta.ui as {
            csp?: { connectDomains?: string[]; resourceDomains?: string[] };
            prefersBorder?: boolean;
          })
        : undefined;
    return {
      toolKey,
      html,
      csp: {
        connectDomains: onlyHttps(ui?.csp?.connectDomains),
        resourceDomains: onlyHttps(ui?.csp?.resourceDomains),
      },
      prefersBorder: ui?.prefersBorder !== false,
    };
  }

  /**
   * A view-initiated tool call, on the host's own connection. Scoped to
   * the SAME server the view came from — an embedded app can never reach
   * another connection's tools.
   */
  async callTool(
    profileId: string,
    viewToolKey: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { connection } = this.resolve(profileId, viewToolKey);
    const server = await this.connect(profileId, connection);
    return server.callToolRaw(toolName, args);
  }

  private resolve(
    profileId: string,
    toolKey: string,
  ): { connection: McpConnection; toolName: string } {
    const slash = toolKey.indexOf("/");
    if (slash <= 0) throw new Error(`Malformed tool key: ${toolKey}`);
    const serverKey = toolKey.slice(0, slash);
    const toolName = toolKey.slice(slash + 1);
    const connection = this.keyed(profileId).get(serverKey);
    if (!connection) throw new Error(`No connection for ${serverKey}`);
    return { connection, toolName };
  }

  private keyed(profileId: string): Map<string, McpConnection> {
    const store = this.deps.connectionsFor(profileId);
    if (!this.watchedProfiles.has(profileId)) {
      this.watchedProfiles.add(profileId);
      // Connection edits invalidate this profile's pooled clients; the
      // next use reconnects with fresh config.
      store.onChanged(() => this.invalidateProfile(profileId));
    }
    return connectionServerKeys(store.list());
  }

  private connect(
    profileId: string,
    connection: McpConnection,
  ): Promise<ConnectedMcpServer> {
    const key = `${profileId}:${connection.id}`;
    const existing = this.pool.get(key);
    if (existing) return existing;
    const config = toAgentMcpServer(connection);
    if (!config) {
      return Promise.reject(
        new Error(`Connection ${connection.name} is incomplete`),
      );
    }
    const pending = connectMcpServer(config).catch((error) => {
      // Failed connects must not poison the pool.
      this.pool.delete(key);
      throw error;
    });
    this.pool.set(key, pending);
    return pending;
  }

  private invalidateProfile(profileId: string): void {
    for (const [key, pending] of [...this.pool]) {
      if (!key.startsWith(`${profileId}:`)) continue;
      this.pool.delete(key);
      void pending.then((server) => server.close()).catch(() => {});
    }
  }
}

/** Domains for CSP inclusion: https origins/hosts only, nothing clever. */
function onlyHttps(domains: string[] | undefined): string[] {
  return (domains ?? []).filter(
    (domain) =>
      typeof domain === "string" &&
      /^(?:https:\/\/)?[a-z0-9.*-]+(?::\d+)?$/i.test(domain),
  );
}
