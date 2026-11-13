import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectionProvider } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

/**
 * A member's own agent connects the member's account (ADR 0316): the
 * project MCP offers a link, only a browser signed in as that member
 * redeems it, and only that browser completes the provider's callback.
 */

const PASSWORD = "correct horse battery staple";
let dataDir: string;
let server: WorkServer;
let projectId: string;
const tokens: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** An upstream service with OAuth, as a host's own provider code. */
const tracker: ConnectionProvider = {
  kind: "tracker",
  displayName: "Tracker",
  beginAuthorization: async ({ state }) => ({
    challenge: {
      kind: "url",
      url: `https://tracker.test/authorize?state=${state}`,
    },
  }),
  completeAuthorization: async ({ callback }) => ({
    material: new TextEncoder().encode(`token-${callback.code}`),
    capabilities: ["issues.list"],
  }),
  listActions: async () => [
    { name: "issues.list", inputSchema: { type: "object" } },
  ],
  invoke: async ({ action, context, material }) => ({
    action,
    actingFor: context.externalUserId,
    principal: context.principal.kind,
    stored: new TextDecoder().decode(material),
  }),
};

const ROLE = {
  version: 1,
  name: "Member",
  permissions: [],
  agents: [],
  workflows: [],
  apps: [],
  environments: ["default"],
  documents: [],
  connections: [{ environment: "default", alias: "tracker" }],
};

const operatorSecret = () =>
  fs.readFileSync(path.join(dataDir, "operator-secret"), "utf8").trim();

let rpcId = 0;
async function mcp(token: string, method: string, params = {}) {
  const response = await server.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/mcp`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  expect(response.statusCode).toBe(200);
  return response.json().result;
}

const toolNames = async (token: string): Promise<string[]> =>
  (await mcp(token, "tools/list")).tools.map(
    (entry: { name: string }) => entry.name,
  );

function cookieOf(header: string | string[] | undefined): string {
  return (Array.isArray(header) ? header : [header ?? ""])
    .map((value) => value.split(";")[0])
    .join("; ");
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-connect-"));
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      publicBases: ["https://work.local:4700"],
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      hooks: { connectionProviders: [tracker] },
    }),
  );
  const operator = (url: string, body: unknown) =>
    server.operatorApp.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${operatorSecret()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const project = await operator("/_work/operator/projects", {
    name: "tools",
    roles: [{ slug: "member", definition: ROLE }],
    admission: {
      mode: "invitation_only",
      defaultRole: "member",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    "work-setup-agent",
    {
      message: "Offer the tracker to each member's own account",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            default: {
              workloads: ["agent", "workflow"],
              connections: {
                tracker: { provider: "tracker", principal: "member" },
              },
            },
          },
        }),
      },
    },
  );
  for (const username of ["ada", "bob"]) {
    const user = await operator("/_work/operator/users", {
      username,
      name: username,
      password: PASSWORD,
      memberships: [{ projectId, roles: ["member"] }],
    });
    expect(user.statusCode).toBe(201);
    // Sign-ins are rate limited per address: Bob needs only a browser.
    if (username === "ada") {
      tokens[username] = await oauthAccessToken({
        app: server.app,
        username,
        password: PASSWORD,
      });
    }
    const login = await server.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    cookies[username] = cookieOf(login.headers["set-cookie"]);
  }
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("connecting a member's own account from their agent (ADR 0316)", () => {
  it("offers a link only the member's own signed-in browser can complete", async () => {
    const ada = tokens.ada ?? "";
    expect(await toolNames(ada)).toContain("tracker__connect");
    const offered = await mcp(ada, "tools/call", {
      name: "tracker__connect",
      arguments: {},
    });
    const { url } = JSON.parse(offered.content[0].text);
    const link = new URL(url);
    expect(link.origin).toBe("https://work.local:4700");

    // Signed out: sign in first, then come back.
    const anonymous = await server.app.inject(link.pathname);
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toContain("/login?next=");

    // Someone else's browser opens nothing, and spends nothing.
    const forwarded = await server.app.inject({
      url: link.pathname,
      headers: { cookie: cookies.bob ?? "" },
    });
    expect(forwarded.statusCode).toBe(410);

    const opened = await server.app.inject({
      url: link.pathname,
      headers: { cookie: cookies.ada ?? "" },
    });
    expect(opened.statusCode).toBe(303);
    const upstream = new URL(String(opened.headers.location));
    expect(upstream.origin).toBe("https://tracker.test");
    const state = upstream.searchParams.get("state") ?? "";
    const binding = cookieOf(opened.headers["set-cookie"]);
    expect(binding).toMatch(/^catamorphic_connect=/);

    // The provider's consent page, forwarded to another browser, completes
    // nothing there.
    const callback = `/api/connection-authorizations/callback?state=${encodeURIComponent(state)}&code=granted`;
    const elsewhere = await server.app.inject({
      url: callback,
      headers: { cookie: cookies.bob ?? "" },
    });
    expect(elsewhere.statusCode).not.toBe(200);
    const completed = await server.app.inject({
      url: callback,
      headers: { cookie: `${cookies.ada}; ${binding}` },
    });
    expect(completed.statusCode).toBe(200);

    // Used once.
    const again = await server.app.inject({
      url: link.pathname,
      headers: { cookie: cookies.ada ?? "" },
    });
    expect(again.statusCode).toBe(410);
  });

  it("then serves the member's tools, acting for them with their own account", async () => {
    const ada = tokens.ada ?? "";
    expect(await toolNames(ada)).toContain("tracker__issues_list");
    const called = await mcp(ada, "tools/call", {
      name: "tracker__issues_list",
      arguments: {},
    });
    expect(called.isError).not.toBe(true);
    expect(JSON.parse(called.content[0].text)).toMatchObject({
      action: "issues.list",
      principal: "member",
      stored: "token-granted",
    });
  });
});
