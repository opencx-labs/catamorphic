import { createHmac, randomBytes } from "node:crypto";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type ElicitHandler,
  type McpToolInfo,
  mcpConnectionLost,
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
  connectionId: string;
  connectionIdentity: string;
  resourceUri: string;
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
  private readonly closing = new Set<Promise<void>>();
  private readonly identityKey = randomBytes(32);
  private readonly poolIdentities = new Map<string, string>();
  private readonly pool = new Map<string, Promise<ConnectedMcpServer>>();
  private readonly watchedProfiles = new Map<string, () => void>();

  constructor(
    private readonly deps: {
      connectionsFor(profileId: string): ConnectionsStore;
      /** Answers elicitation from these servers (form/URL, MRTR). */
      onElicit?: ElicitHandler;
    },
  ) {}

  /** Opaque endpoint/account identity; policies and cached rosters are separate. */
  connectionIdentity(
    profileId: string,
    serverKey: string,
    connectionId?: string,
  ): string {
    const connection = this.keyed(profileId).get(serverKey);
    if (!connection || (connectionId && connection.id !== connectionId))
      throw new Error("The tool connection changed");
    return this.identity(profileId, connection);
  }

  private identity(profileId: string, connection: McpConnection): string {
    const config = toAgentMcpServer(connection);
    if (!config) throw new Error(`Connection ${connection.name} is incomplete`);
    const oauth = connection.oauth;
    const stableConfig =
      config.transport !== "stdio" && oauth?.tokens?.access_token
        ? {
            ...config,
            headers: Object.fromEntries(
              Object.entries(config.headers ?? {}).filter(
                ([key]) => key.toLowerCase() !== "authorization",
              ),
            ),
          }
        : config;
    return this.digest({
      profileId,
      id: connection.id,
      securityRevision: this.deps
        .connectionsFor(profileId)
        .securityRevision(connection.id),
      config: stableConfig,
      headers: connection.headers,
      env: connection.env,
      oauthClient: connection.oauthClient,
      oauth: oauth
        ? {
            clientInformation: oauth.clientInformation,
            discovery: oauth.discovery,
            authorized: Boolean(oauth.tokens?.access_token),
          }
        : undefined,
      inheritedEnv:
        connection.transport === "stdio"
          ? Object.fromEntries(
              (connection.envVars ?? []).map((key) => [key, process.env[key]]),
            )
          : undefined,
    });
  }

  /** The pool reconnects on token rotation without revoking the mounted account. */
  private transportIdentity(
    profileId: string,
    connection: McpConnection,
  ): string {
    return this.digest({
      profileId,
      id: connection.id,
      accountIdentity: this.identity(profileId, connection),
      config: toAgentMcpServer(connection),
    });
  }

  private digest(value: unknown): string {
    const snapshot = JSON.stringify(value, (_key, entry: unknown) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
          )
        : entry,
    );
    return createHmac("sha256", this.identityKey)
      .update(snapshot)
      .digest("base64url");
  }

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

  /**
   * The connection's tools on the authenticated host client, listed once
   * more on a fresh connection when the first attempt fails.
   */
  async tools(
    profileId: string,
    serverKey: string,
    connectionId?: string,
    connectionIdentity?: string,
  ) {
    const connection = this.keyed(profileId).get(serverKey);
    if (!connection || (connectionId && connection.id !== connectionId))
      throw new Error(`No connection for ${serverKey}`);
    const resolvedId = connection.id;
    const identity = connectionIdentity ?? this.identity(profileId, connection);
    const fetch = async () => {
      const current = this.keyed(profileId).get(serverKey);
      if (
        !current ||
        current.id !== resolvedId ||
        this.identity(profileId, current) !== identity
      )
        throw new Error("The tool connection changed");
      const pending = this.connect(profileId, current);
      try {
        const server = await pending;
        const tools = server.refreshTools
          ? await server.refreshTools()
          : server.tools;
        this.assertCurrent(
          profileId,
          `${serverKey}/_`,
          resolvedId,
          pending,
          identity,
        );
        return tools;
      } catch (error) {
        // Listing is safe to retry, but the failed client must be retired
        // before another attempt. Tool mutations are never replayed here.
        this.drop(`${profileId}:${resolvedId}`, pending);
        throw error;
      }
    };
    try {
      return await fetch();
    } catch {
      return fetch();
    }
  }

  /** Fetch the `ui://` template behind a tool key. */
  async view(
    profileId: string,
    toolKey: string,
    connectionId?: string,
  ): Promise<McpAppView> {
    const { connection, toolName } = this.resolve(profileId, toolKey);
    if (connectionId && connection.id !== connectionId)
      throw new Error("The app connection changed");
    const identity = this.identity(profileId, connection);
    const pending = this.connect(profileId, connection);
    const server = await pending;
    this.assertCurrent(profileId, toolKey, connection.id, pending, identity);
    const tools = server.refreshTools
      ? await server.refreshTools()
      : server.tools;
    this.assertCurrent(profileId, toolKey, connection.id, pending, identity);
    const tool = tools.find((entry) => entry.name === toolName);
    const uri = tool ? uiResourceUri(tool) : undefined;
    if (!uri) throw new Error(`Tool ${toolKey} declares no app view`);
    const resource = await server.readResource(uri);
    this.assertCurrent(profileId, toolKey, connection.id, pending, identity);
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
      connectionId: connection.id,
      connectionIdentity: identity,
      resourceUri: uri,
      html,
      csp: {
        connectDomains: onlyHttps(ui?.csp?.connectDomains),
        resourceDomains: onlyHttps(ui?.csp?.resourceDomains),
      },
      prefersBorder: ui?.prefersBorder !== false,
    };
  }

  /**
   * A tool call on the host's own connection: from an embedded view, the
   * capability catalog or a mounted connector (ADR 0225). Scoped to the
   * SAME server as `viewToolKey`, so an embedded app can never reach
   * another connection's tools. A call that finds the connection gone
   * drops that client, so the next one connects afresh; errors the server
   * sent leave it in use.
   */
  async callTool(
    profileId: string,
    viewToolKey: string,
    toolName: string,
    args: Record<string, unknown>,
    authorization?: {
      connectionId: string;
      connectionIdentity?: string;
      beforeCall: (tool: McpToolInfo, tools: McpToolInfo[]) => Promise<void>;
    },
  ): Promise<Record<string, unknown>> {
    const { connection } = this.resolve(profileId, viewToolKey);
    const identity = this.identity(profileId, connection);
    if (
      authorization &&
      (authorization.connectionId !== connection.id ||
        (authorization.connectionIdentity &&
          authorization.connectionIdentity !== identity))
    )
      throw new Error("The tool connection changed");
    const pending = this.connect(profileId, connection);
    const server = await pending;
    try {
      if (authorization) {
        const tools = server.refreshTools
          ? await server.refreshTools()
          : server.tools;
        const tool = tools.find((entry) => entry.name === toolName);
        if (!tool) throw new Error(`Unknown tool: ${toolName}`);
        await authorization.beforeCall(tool, tools);
        this.assertCurrent(
          profileId,
          viewToolKey,
          connection.id,
          pending,
          identity,
        );
      }
      const result = await server.callToolRaw(toolName, args);
      if (authorization)
        this.assertCurrent(
          profileId,
          viewToolKey,
          connection.id,
          pending,
          identity,
        );
      return result;
    } catch (error) {
      if (mcpConnectionLost(error))
        this.drop(`${profileId}:${connection.id}`, pending);
      throw error;
    }
  }

  private assertCurrent(
    profileId: string,
    toolKey: string,
    connectionId: string,
    pending: Promise<ConnectedMcpServer>,
    identity: string,
  ): void {
    const connection = this.resolve(profileId, toolKey).connection;
    if (
      connection.id !== connectionId ||
      this.identity(profileId, connection) !== identity ||
      this.pool.get(`${profileId}:${connectionId}`) !== pending
    )
      throw new Error("The tool connection changed");
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
      // Connection edits invalidate this profile's pooled clients; the
      // next use reconnects with fresh config.
      this.watchedProfiles.set(
        profileId,
        store.onChanged(() => {
          void this.invalidateProfile(profileId);
        }),
      );
    }
    return connectionServerKeys(store.list());
  }

  private connect(
    profileId: string,
    connection: McpConnection,
  ): Promise<ConnectedMcpServer> {
    const key = `${profileId}:${connection.id}`;
    const identity = this.transportIdentity(profileId, connection);
    const existing = this.pool.get(key);
    if (existing && this.poolIdentities.get(key) === identity) return existing;
    if (existing) this.drop(key, existing);
    const config = toAgentMcpServer(connection);
    if (!config) {
      return Promise.reject(
        new Error(`Connection ${connection.name} is incomplete`),
      );
    }
    const pending = connectMcpServer(
      config,
      this.deps.onElicit ? { onElicit: this.deps.onElicit } : undefined,
    ).catch((error) => {
      // Failed connects must not poison the pool.
      if (this.pool.get(key) === pending) {
        this.pool.delete(key);
        this.poolIdentities.delete(key);
      }
      throw error;
    });
    this.pool.set(key, pending);
    this.poolIdentities.set(key, identity);
    return pending;
  }

  /**
   * Retire the client one call used, unless another call has already
   * replaced it: concurrent calls on a dead connection drop it once.
   */
  private drop(key: string, pending: Promise<ConnectedMcpServer>): void {
    if (this.pool.get(key) !== pending) return;
    this.pool.delete(key);
    this.poolIdentities.delete(key);
    const closed: Promise<void> = pending
      .then((server) => server.close())
      .catch(() => {})
      .finally(() => this.closing.delete(closed));
    this.closing.add(closed);
  }

  async releaseProfile(profileId: string): Promise<void> {
    this.watchedProfiles.get(profileId)?.();
    this.watchedProfiles.delete(profileId);
    await this.invalidateProfile(profileId);
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.watchedProfiles.keys()].map((profileId) =>
        this.releaseProfile(profileId),
      ),
    );
    await Promise.all(this.closing);
  }

  private async invalidateProfile(profileId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, pending] of [...this.pool]) {
      if (!key.startsWith(`${profileId}:`)) continue;
      this.pool.delete(key);
      this.poolIdentities.delete(key);
      const closed = pending
        .then((server) => server.close())
        .catch(() => {})
        .finally(() => this.closing.delete(closed));
      this.closing.add(closed);
      closing.push(closed);
    }
    await Promise.all(closing);
  }
}

/** Domains for CSP inclusion: https origins/hosts only, nothing clever. */
function onlyHttps(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) return [];
  return domains.flatMap((domain) => {
    if (typeof domain !== "string") return [];
    const match =
      /^(?:https:\/\/)?((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?)$/i.exec(
        domain,
      );
    if (!match) return [];
    return [`https://${match[1]}`];
  });
}

/**
 * The view's CSP, from the resource's declared domain lists. Defaults are
 * the spec's: no network, inline script/style only, data/blob images.
 * Declared domains widen exactly the directives the spec maps them to.
 */
export function mcpAppViewCsp(view: McpAppView): string {
  const resource = view.csp.resourceDomains.join(" ");
  const connect = view.csp.connectDomains.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${resource ? ` ${resource}` : ""}`,
    `style-src 'unsafe-inline'${resource ? ` ${resource}` : ""}`,
    `img-src data: blob:${resource ? ` ${resource}` : ""}`,
    `font-src data:${resource ? ` ${resource}` : ""}`,
    connect ? `connect-src ${connect}` : "connect-src 'none'",
  ].join("; ");
}

/**
 * The served view document: the template with its CSP embedded as a meta
 * tag (the serving route repeats it as a response header). Served from a
 * real URL rather than `srcdoc` because local-scheme documents inherit the
 * shell's CSP, whose strict `script-src` would block the view's inline
 * scripts.
 */
export function mcpAppViewDocument(view: McpAppView): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${mcpAppViewCsp(view)}">`;
  const html = view.html;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return `${html.slice(0, at)}${meta}${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype?.[0].length ?? 0;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}
