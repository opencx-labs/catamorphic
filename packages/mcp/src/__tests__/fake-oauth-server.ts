import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * An in-process OAuth-protected MCP server for tests: `/mcp` answers 401
 * with a WWW-Authenticate challenge until it sees one of the fake bearer
 * tokens; RFC 9728 / RFC 8414 metadata, dynamic client registration, an
 * `/authorize` that consents instantly (302 back with a code), and a
 * `/token` endpoint that grants + refreshes. Runnable standalone
 * (`bun fake-oauth-server.ts` prints `PORT <n>`) so the desktop e2e can
 * point a connection at it.
 */

export const FAKE_ACCESS_TOKEN = "access-token-1";
export const FAKE_REFRESHED_TOKEN = "access-token-2";

export interface FakeOAuthMcp {
  base: string;
  tokenRequests: URLSearchParams[];
  registrations: unknown[];
  close(): void;
}

const readBody = (request: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });

// Stateless streamable HTTP: one Server + transport per request.
function makeMcp(): Server {
  const mcp = new Server(
    { name: "fake", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "hello",
        description: "Say hi",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `hi ${request.params.arguments?.name}` }],
  }));
  return mcp;
}

export async function startFakeOAuthMcp(): Promise<FakeOAuthMcp> {
  let base = "";
  const tokenRequests: URLSearchParams[] = [];
  const registrations: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const json = (status: number, body: unknown, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["mcp:tools"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:tools"],
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      registrations.push(body);
      return json(201, {
        client_id: "client-1",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: body.grant_types,
        response_types: body.response_types,
      });
    }
    if (url.pathname === "/authorize") {
      // Instant consent: bounce straight back with a code.
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "code-1");
      const state = url.searchParams.get("state");
      if (state) redirect.searchParams.set("state", state);
      redirect.searchParams.set("iss", base);
      response.writeHead(302, { location: String(redirect) }).end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await readBody(request));
      tokenRequests.push(params);
      const grant = params.get("grant_type");
      if (grant === "authorization_code" && params.get("code") === "code-1") {
        return json(200, {
          access_token: FAKE_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
          scope: "mcp:tools",
        });
      }
      if (
        grant === "refresh_token" &&
        params.get("refresh_token") === "refresh-1"
      ) {
        return json(200, {
          access_token: FAKE_REFRESHED_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
        });
      }
      return json(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      const auth = request.headers.authorization;
      if (
        auth !== `Bearer ${FAKE_ACCESS_TOKEN}` &&
        auth !== `Bearer ${FAKE_REFRESHED_TOKEN}`
      ) {
        return json(
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
          },
        );
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcp = makeMcp();
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      const body =
        request.method === "POST"
          ? JSON.parse(await readBody(request))
          : undefined;
      await transport.handleRequest(request, response, body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    tokenRequests,
    registrations,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

if (import.meta.main) {
  const fake = await startFakeOAuthMcp();
  console.log(`PORT ${new URL(fake.base).port}`);
  process.on("SIGTERM", () => {
    fake.close();
    process.exit(0);
  });
}
