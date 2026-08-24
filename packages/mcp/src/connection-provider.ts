import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import { connectMcpServer } from "./client.js";
import type { McpOAuthClientHint } from "./marketplace.js";
import {
  bearerHeaders,
  beginMcpAuthorization,
  completeMcpAuthorization,
  type McpOAuthState,
  refreshMcpTokens,
} from "./oauth.js";

export interface McpConnectionCredential {
  headers?: Record<string, string>;
  oauth?: McpOAuthState;
}

class McpAuthorizationExpiredError extends Error {
  readonly code = "connection_authorization_expired";

  constructor() {
    super("MCP authorization has expired");
    this.name = "McpAuthorizationExpiredError";
  }
}

type HostMcpServerConfig =
  | Omit<Extract<AgentMcpServerConfig, { url: string }>, "headers">
  | Omit<Extract<AgentMcpServerConfig, { command: string }>, "env">;

/**
 * Host-side connection driver for one configured MCP endpoint. The endpoint is
 * host policy; vault material contains only authorization state and is opened
 * for the duration of list/call.
 */
export function defineMcpConnectionProvider(args: {
  kind: string;
  displayName: string;
  server: HostMcpServerConfig;
  oauth?: { client?: McpOAuthClientHint };
}) {
  const serverConfig = args.server;
  return {
    kind: args.kind,
    displayName: args.displayName,
    ...(serverConfig.transport !== "stdio"
      ? {
          async beginAuthorization(input: {
            redirectUri: string;
            state: string;
          }) {
            const begun = await beginMcpAuthorization(serverConfig, {
              redirectUri: input.redirectUri,
              state: input.state,
              client: args.oauth?.client,
            });
            return {
              challenge: { kind: "url" as const, url: begun.url },
              privateState: begun.privateState,
            };
          },
          async completeAuthorization(input: {
            callback: Readonly<Record<string, string>>;
            privateState?: Uint8Array;
          }) {
            if (!input.privateState) {
              throw new Error("MCP OAuth state is missing");
            }
            const oauth = await completeMcpAuthorization(serverConfig, {
              privateState: input.privateState,
              callback: input.callback,
            });
            return authorizationResult(serverConfig, { oauth });
          },
          async refresh(input: { material: Uint8Array }) {
            const credential = decodeCredential(input.material);
            const memory = memoryCredentialStore(credential.oauth);
            if (
              !(await refreshMcpTokens(serverConfig, memory, { force: true }))
            ) {
              throw new Error("MCP token refresh failed");
            }
            return authorizationResult(serverConfig, {
              ...credential,
              oauth: memory.load(),
            });
          },
        }
      : {}),
    async listActions(input: {
      material: Uint8Array;
      capabilities: readonly string[];
    }) {
      const server = await connectWithCredentialOrExpire(
        serverConfig,
        input.material,
      );
      try {
        return server.tools
          .filter((tool) => input.capabilities.includes(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          }));
      } finally {
        await server.close().catch(() => {});
      }
    },
    async invoke(input: {
      material: Uint8Array;
      action: string;
      input: unknown;
      capabilities: readonly string[];
    }): Promise<unknown> {
      if (!input.capabilities.includes(input.action)) {
        throw new Error(
          `MCP tool '${input.action}' is outside the connection grant`,
        );
      }
      const server = await connectWithCredentialOrExpire(
        serverConfig,
        input.material,
      );
      try {
        const callArgs =
          typeof input.input === "object" &&
          input.input !== null &&
          !Array.isArray(input.input)
            ? (input.input as Record<string, unknown>)
            : {};
        const result = await server.callToolRaw(input.action, callArgs);
        return JSON.parse(JSON.stringify(result));
      } finally {
        await server.close().catch(() => {});
      }
    },
  };
}

async function connectWithCredential(
  serverConfig: HostMcpServerConfig,
  material: Uint8Array,
) {
  const credential = decodeCredential(material);
  return connectMcpServer({
    ...serverConfig,
    ...(serverConfig.transport === "stdio"
      ? {}
      : {
          headers: {
            ...credential.headers,
            ...bearerHeaders(credential.oauth),
          },
        }),
  } as AgentMcpServerConfig);
}

async function connectWithCredentialOrExpire(
  serverConfig: HostMcpServerConfig,
  material: Uint8Array,
) {
  try {
    return await connectWithCredential(serverConfig, material);
  } catch (error) {
    if (looksLikeAuthorizationFailure(error)) {
      throw new McpAuthorizationExpiredError();
    }
    throw error;
  }
}

function looksLikeAuthorizationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("status" in error && (error.status === 401 || error.status === 403)) {
    return true;
  }
  return /\b(401|403|unauthori[sz]ed|forbidden|invalid[_ -]?token)\b/i.test(
    error.message,
  );
}

function decodeCredential(material: Uint8Array): McpConnectionCredential {
  return JSON.parse(
    new TextDecoder().decode(material),
  ) as McpConnectionCredential;
}

function memoryCredentialStore(initial: McpOAuthState | undefined) {
  let value = structuredClone(initial ?? {});
  return {
    load: () => structuredClone(value),
    save: (state: McpOAuthState) => {
      value = structuredClone(state);
    },
  };
}

async function authorizationResult(
  serverConfig: HostMcpServerConfig,
  credential: McpConnectionCredential,
) {
  const material = new TextEncoder().encode(JSON.stringify(credential));
  const server = await connectWithCredential(serverConfig, material);
  try {
    const expiresIn = credential.oauth?.tokens?.expires_in;
    return {
      material,
      account: {
        endpoint:
          serverConfig.transport === "stdio" ? "stdio" : serverConfig.url,
      },
      scopes: credential.oauth?.tokens?.scope?.split(" ").filter(Boolean),
      capabilities: server.tools.map((tool) => tool.name),
      ...(expiresIn
        ? {
            expiresAt: new Date(
              (credential.oauth?.tokensObtainedAt ?? Date.now()) +
                expiresIn * 1000,
            ),
          }
        : {}),
    };
  } finally {
    await server.close().catch(() => {});
  }
}
