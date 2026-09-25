import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

/**
 * A member's own agent on the project MCP (ADR 0166), end to end over the
 * Work server's real OAuth: an engineer drafts, checks, and deploys a
 * workflow that becomes a tool and shares a customer document; a customer
 * success manager sees only what their role grants.
 */

let dataDir: string;
let server: WorkServer;
let projectId: string;
let engineer: string;
let csm: string;

const ENGINEER_ROLE = {
  version: 1,
  name: "Engineer",
  permissions: ["program:*", "publications:*"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["default"],
  documents: [{ path: "store/**", access: "write" }],
};

const CSM_ROLE = {
  version: 1,
  name: "Customer success",
  permissions: ["publications:read", "publications:write"],
  agents: ["assistant"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["default"],
  documents: [{ path: "store/customers/**", access: "write" }],
};

const GREET = `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

/** @displayname Greet */
export const greet = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "Greet someone by name" })],
  steps: [
    /** @displayname Say hello */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ name: string }>) => ({
        greeting: \`Hello, \${input.name}\`,
      }),
    }),
  ],
}));
`;

const operatorSecret = () =>
  fs.readFileSync(path.join(dataDir, "operator-secret"), "utf8").trim();

let rpcId = 0;
async function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await server.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/mcp`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await mcp(token, "tools/call", { name, arguments: args });
  const text: string = result.content[0].text;
  if (result.isError === true) return { isError: true, value: text };
  return { isError: false, value: JSON.parse(text) };
}

const toolNames = async (token: string) =>
  (await mcp(token, "tools/list")).tools.map(
    (entry: { name: string }) => entry.name,
  );

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-mcp-"));
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      publicBases: ["http://work.local:4700"],
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
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
    name: "brain",
    roles: [
      { slug: "engineer", definition: ENGINEER_ROLE },
      { slug: "csm", definition: CSM_ROLE },
    ],
    admission: {
      mode: "invitation_only",
      defaultRole: "csm",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
  for (const [username, role] of [
    ["engineer", "engineer"],
    ["csm", "csm"],
  ] as const) {
    const user = await operator("/_work/operator/users", {
      username,
      name: username,
      password: "correct horse battery staple",
      memberships: [{ projectId, roles: [role] }],
    });
    expect(user.statusCode).toBe(201);
  }
  const signIn = (username: string) =>
    oauthAccessToken({
      app: server.app,
      username,
      password: "correct horse battery staple",
    });
  engineer = await signIn("engineer");
  csm = await signIn("csm");
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("project MCP for members' own agents", () => {
  it("names the server and orients the client for the caller's roles", async () => {
    const engineerInit = await mcp(engineer, "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(engineerInit.serverInfo).toMatchObject({
      name: "work",
      title: "Work",
    });
    expect(engineerInit.instructions).toContain("program_deploy");
    expect(engineerInit.instructions).toContain("share_create");

    const csmInit = await mcp(csm, "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(csmInit.instructions).not.toContain("program_write");
    expect(csmInit.instructions).toContain("propose_change");

    const outsider = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/users",
      headers: {
        authorization: `Bearer ${operatorSecret()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        username: "outsider",
        name: "Outsider",
        password: "correct horse battery staple",
        memberships: [],
      }),
    });
    expect(outsider.statusCode).toBe(201);
    const outsiderToken = await oauthAccessToken({
      app: server.app,
      username: "outsider",
      password: "correct horse battery staple",
    });
    const refused = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/mcp`,
      headers: {
        authorization: `Bearer ${outsiderToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(refused.statusCode).toBe(404);

    const get = await server.app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/mcp`,
      headers: { authorization: `Bearer ${engineer}` },
    });
    expect(get.statusCode).toBe(405);
  });

  it("an engineer drafts, checks, and deploys a workflow that becomes a tool", async () => {
    expect(await toolNames(engineer)).toEqual(
      expect.arrayContaining([
        "project_overview",
        "program_files",
        "program_write",
        "program_check",
        "program_deploy",
        "workflow_run",
        "run_details",
        "share_create",
      ]),
    );

    await tool(engineer, "program_write", {
      changes: [
        {
          path: ".catamorphic/workflows/greet.ts",
          content: GREET.replace('"ai.tool-call"', '"ai.tool-cal"'),
        },
      ],
    });
    const blocked = await tool(engineer, "program_deploy", {
      message: "Add greet",
    });
    expect(blocked.value.status).toBe("blocked");
    expect(JSON.stringify(blocked.value.findings)).toContain("ai.tool-cal");

    await tool(engineer, "program_write", {
      changes: [{ path: ".catamorphic/workflows/greet.ts", content: GREET }],
    });
    const check = await tool(engineer, "program_check");
    expect(check.value).toMatchObject({ ok: true });
    const draft = await tool(engineer, "program_files");
    expect(draft.value.changed).toContain(".catamorphic/workflows/greet.ts");

    const deployed = await tool(engineer, "program_deploy", {
      message: "Add greet",
    });
    expect(deployed.isError).toBe(false);
    expect(deployed.value.status).toBe("deployed");

    // MCP clients validate structured content as an object: arrays ride
    // the text channel only.
    const skills = await mcp(engineer, "tools/call", {
      name: "list_skills",
      arguments: {},
    });
    expect(skills.structuredContent).toBeUndefined();
    expect(JSON.parse(skills.content[0].text)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "writing-workflows" }),
      ]),
    );

    const overview = await tool(engineer, "project_overview");
    expect(overview.value.project.name).toBe("brain");
    expect(overview.value.you.roles).toEqual([
      expect.objectContaining({ name: "Engineer" }),
    ]);
    expect(
      overview.value.workflows.map((entry: { name: string }) => entry.name),
    ).toContain("greet");
    expect(await toolNames(engineer)).toContain("greet");
  }, 60_000);

  it("an engineer shares a customer document; a CSM works within their role", async () => {
    const written = await tool(engineer, "documents_write", {
      path: "store/customers/acme/status.md",
      text: "# Acme pilot\n\nOn track.",
    });
    expect(written).toMatchObject({ isError: false });
    const share = await tool(engineer, "share_create", {
      kind: "document",
      target: "store/customers/acme/status.md",
      audience: { emails: ["dana@acme.example"] },
    });
    expect(share).toMatchObject({ isError: false });
    expect(share.value.url).toContain("/s/");

    const names = await toolNames(csm);
    expect(names).toEqual(
      expect.arrayContaining(["project_overview", "share_create", "greet"]),
    );
    expect(names).not.toContain("program_write");
    expect(names).not.toContain("program_deploy");

    const outside = await tool(csm, "documents_read", {
      path: ".catamorphic/workflows/greet.ts",
    });
    expect(outside.isError).toBe(true);
    const folder = await tool(csm, "share_create", {
      kind: "folder",
      target: "store/customers/acme",
      audience: { domains: ["acme.example"] },
    });
    expect(folder).toMatchObject({ isError: false });
    const listed = await tool(csm, "shares_list");
    expect(listed.value.shares).toHaveLength(2);
    const revoked = await tool(csm, "share_revoke", {
      shareId: folder.value.id,
    });
    expect(revoked.isError).toBe(false);
  }, 60_000);
});
