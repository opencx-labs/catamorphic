import { createHash } from "node:crypto";
import {
  AuthenticationRequiredError,
  type CatamorphicCore,
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
  ConnectionUnavailableError,
  type Identity,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import {
  type ForwardedToolDefinition,
  forwardedTool,
  forwardedToolResult,
  toolError,
  toolValue,
} from "./mcp-shared.js";

/**
 * A signed-in member's own agent uses the project's connections over the
 * project MCP (ADR 0316): each alias the member may use in the Environment
 * appears as native tools, `<alias>__<action>`, called through the broker
 * with the member's live authority. No Work session or Allocation is
 * involved, and no credential reaches the client. An alias acting with the
 * member's own account that they have not connected offers one
 * `<alias>__connect` tool, answering with a link to connect it.
 */
export interface ConnectionToolSurface {
  list(): Promise<Record<string, unknown>[]>;
  /** Undefined when `name` is not a connection tool. */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
}

/** Where a member redeems a connect link; supplied by the host. */
export type ConnectLink = (args: {
  token: string;
  projectId: string;
}) => string;

const CONNECT = "connect";
/** Clients cap tool names; Claude Code allows 64 after its own prefix. */
const MAX_TOOL_NAME = 64;
const ACTIONS_TTL_MS = 60_000;
/** Clients keep a stateless server's tool list until they reconnect. */
const RECONNECT =
  "Afterwards, reconnect this server in your client (in Claude Code, /mcp) to see its tools.";

interface Entry {
  alias: string;
  /** Absent for the connect tool. */
  action?: string;
  definition: Record<string, unknown>;
  mcp: boolean;
}

/**
 * Replica memory (a cache, ADR 0193): action lists per member, alias and
 * Environment, briefly, because listing reaches the upstream server.
 * Authority is never cached: every call resolves it again.
 */
const actionCaches = new WeakMap<
  CatamorphicCore,
  Map<string, { at: number; actions: readonly ForwardedToolDefinition[] }>
>();

export function connectionTools(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId: string;
  /** The Environment the endpoint serves; absent uses the project default. */
  environment?: string;
  connectLink?: ConnectLink;
}): ConnectionToolSurface {
  const { core, identity, projectId } = args;
  let loaded: Promise<{ environment: string; entries: Entry[] }> | undefined;
  const load = () => {
    loaded ??= (async () => {
      // A host without connections serves none, and reads no Environment.
      if (!core.connections || !core.connectionBroker)
        return { environment: "", entries: [] };
      const environment = args.environment ?? (await defaultEnvironment());
      return { environment, entries: await entries(environment) };
    })();
    return loaded;
  };
  const defaultEnvironment = async () =>
    (await core.projectEnvironments.list({ identity, projectId }))
      .defaultEnvironment ?? "default";

  const entries = async (environment: string): Promise<Entry[]> => {
    const connections = core.connections;
    const broker = core.connectionBroker;
    if (!connections || !broker) return [];
    const bindings = await connections
      .listBindings({ identity, projectId, environment })
      .catch(() => []);
    const result: Entry[] = [];
    for (const binding of bindings) {
      const authority =
        binding.principal === "member"
          ? binding.memberConnection
          : binding.serviceConnection;
      if (authority?.status !== "ready") {
        // Only a member can connect their own account; a missing service
        // account is an administrator's to authorize.
        if (binding.principal === "member") {
          result.push({
            alias: binding.alias,
            mcp: false,
            definition: forwardedTool({
              name: CONNECT,
              title: `Connect ${binding.alias}`,
              description: `Connect your own ${binding.alias} account so its tools appear here. Returns a link for the person to open in their browser, signed in to Work. ${RECONNECT}`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            }),
          });
        }
        continue;
      }
      const actions = await listActions(environment, binding.alias).catch(
        () => [],
      );
      const mcp = broker.servesMcp(binding.provider);
      for (const action of actions) {
        result.push({
          alias: binding.alias,
          action: action.name,
          mcp,
          definition: forwardedTool({
            ...action,
            name: action.name,
            description: `${binding.alias}: ${action.description ?? action.name}`,
            // Only an MCP server's own results match its output schema.
            ...(mcp ? {} : { outputSchema: undefined }),
          }),
        });
      }
    }
    return named(result);
  };

  const listActions = async (environment: string, alias: string) => {
    const key = JSON.stringify([
      identity.tenantId,
      identity.externalUserId,
      projectId,
      environment,
      alias,
    ]);
    let actionCache = actionCaches.get(core);
    if (!actionCache) {
      actionCache = new Map();
      actionCaches.set(core, actionCache);
    }
    const cached = actionCache.get(key);
    if (cached && Date.now() - cached.at < ACTIONS_TTL_MS)
      return cached.actions;
    const broker = core.connectionBroker;
    if (!broker) return [];
    const actions = await broker.listActions({
      identity,
      projectId,
      environment,
      alias,
    });
    if (actionCache.size > 1_000) actionCache.clear();
    actionCache.set(key, { at: Date.now(), actions });
    return actions;
  };

  const connectAnswer = async (environment: string, alias: string) => {
    const connections = core.connections;
    if (!connections) return toolError("Connections are not configured");
    if (!args.connectLink) {
      return toolError(`Connect your ${alias} account in Work. ${RECONNECT}`);
    }
    let offer: Awaited<ReturnType<typeof connections.offerConnection>>;
    try {
      offer = await connections.offerConnection({
        identity,
        projectId,
        environment,
        alias,
      });
    } catch {
      return toolError(
        `${alias} cannot be connected from here: it uses an account an administrator connects, or your roles do not include it.`,
      );
    }
    const url = args.connectLink({ token: offer.token, projectId });
    return toolValue({
      alias,
      url,
      expiresAt: offer.expiresAt.toISOString(),
      instructions: `Ask the person to open this link in their browser, signed in to Work as themselves, and connect their ${alias} account. It works once, for them only. ${RECONNECT}`,
    });
  };

  return {
    async list() {
      return (await load()).entries.map((entry) => entry.definition);
    },
    async call(name, callArgs) {
      const { environment, entries: known } = await load();
      const entry = known.find(
        (candidate) => candidate.definition.name === name,
      );
      if (!entry) return undefined;
      if (!entry.action) return connectAnswer(environment, entry.alias);
      const broker = core.connectionBroker;
      if (!broker) return toolError("Connections are not configured");
      try {
        const output = await broker.invoke({
          identity,
          projectId,
          environment,
          alias: entry.alias,
          action: entry.action,
          input: toJson(callArgs),
          caller: "member",
        });
        return entry.mcp ? forwardedToolResult(output) : toolValue(output);
      } catch (error) {
        if (error instanceof AuthenticationRequiredError) {
          return connectAnswer(environment, entry.alias);
        }
        // A refusal is information the agent can act on; other failures
        // stay opaque (no upstream detail, no credential in an error).
        if (
          error instanceof ConnectionActionDeniedError ||
          error instanceof ConnectionActionRefusedError ||
          error instanceof ConnectionUnavailableError
        ) {
          return toolError(error.message);
        }
        return toolError("Connection action failed");
      }
    },
  };
}

/**
 * Give each entry its tool name, `<alias>__<action>`, limited to the
 * characters and length MCP clients accept. Every name that would be too
 * long, ambiguous (an alias containing `__`), or shared by two entries gets
 * a digest of its own alias and action, so no entry's name depends on
 * which others are listed: a name a person approved keeps its meaning.
 */
function named(entries: Entry[]): Entry[] {
  const action = (entry: Entry) => entry.action ?? CONNECT;
  const base = (entry: Entry) =>
    `${entry.alias}__${action(entry).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(base(entry), (counts.get(base(entry)) ?? 0) + 1);
  return entries.map((entry) => {
    const plain = base(entry);
    const name =
      plain.length > MAX_TOOL_NAME ||
      entry.alias.includes("__") ||
      (counts.get(plain) ?? 0) > 1
        ? `${plain.slice(0, MAX_TOOL_NAME - 9)}_${createHash("sha256")
            .update(`${entry.alias}\u0000${action(entry)}`)
            .digest("hex")
            .slice(0, 8)}`
        : plain;
    return { ...entry, definition: { ...entry.definition, name } };
  });
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
