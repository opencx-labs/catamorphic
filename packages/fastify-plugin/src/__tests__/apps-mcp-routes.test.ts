import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const APP_ID = "c3d4e5f6-a7b8-4890-acde-123456789012";
const VERSION_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const MCP_URL = `/api/projects/${PROJECT_ID}/apps-mcp`;

const HEADERS = {
  "x-catamorphic-tenant-id": "tenant-1",
  "x-external-user-id": "user-1",
  "content-type": "application/json",
};

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Core stub with one published app allowing two workflows. */
function fakeCore() {
  const runs = new Map<string, { status: string; result?: unknown }>();
  return {
    runs: {
      triggerProduction: vi.fn(async (args: { workflowName: string }) => {
        const id = `run-${args.workflowName}`;
        runs.set(id, {
          status: "completed",
          result: { ok: args.workflowName },
        });
        return { id };
      }),
      get: vi.fn(async (args: { runId: string }) => {
        const run = runs.get(args.runId);
        if (!run) throw new Error("missing run");
        return { id: args.runId, status: run.status, result: run.result };
      }),
    },
    apps: {
      list: vi.fn(async () => [
        {
          name: "ops-dashboard",
          id: APP_ID,
          activeVersionId: VERSION_ID,
          publishedAt: "2026-08-01T00:00:00.000Z",
        },
      ]),
      viewState: vi.fn(async () => ({
        state: "ready",
        appId: APP_ID,
        versionId: VERSION_ID,
        code: "console.log('app');",
        css: "body{color:red}",
        workflowShapes: {},
        allowedWorkflows: ["listOrders", "reconcile"],
      })),
    },
  };
}

async function rpc(
  app: ReturnType<typeof createApp>,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "POST",
    url: MCP_URL,
    headers: HEADERS,
    payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
  });
  return response.json() as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

describe("apps MCP endpoint", () => {
  it("answers initialize with the legacy handshake and capabilities", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result?.protocolVersion).toBe("2025-06-18");
    expect(result?.capabilities).toEqual({
      tools: { listChanged: false },
      resources: {},
    });
  });

  it("accepts notifications with a 202 and no body", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: MCP_URL,
      headers: HEADERS,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(response.statusCode).toBe(202);
  });

  it("lists one tool per allowed workflow with MCP Apps ui metadata", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["listOrders", "reconcile", "catamorphic_poll_run"]);
    expect((tools[0]?._meta as { ui?: { resourceUri?: string } })?.ui).toEqual({
      resourceUri: "ui://apps/ops-dashboard",
      visibility: ["model", "app"],
    });
  });

  it("serves the app bundle as a ui:// resource with the standard mimeType", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "resources/read", {
      uri: "ui://apps/ops-dashboard",
    });
    const content = (
      result?.contents as Array<Record<string, unknown>> | undefined
    )?.[0];
    expect(content?.mimeType).toBe("text/html;profile=mcp-app");
    expect(String(content?.text)).toContain("console.log('app');");
    expect(String(content?.text)).toContain("Content-Security-Policy");
  });

  it("executes a workflow tool under the app audience and returns output", async () => {
    const core = fakeCore();
    const app = createApp({ core: core as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "listOrders",
      arguments: { input: { status: "open" } },
    });
    expect(result?.structuredContent).toEqual({ ok: "listOrders" });
    expect(core.runs.triggerProduction).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: "listOrders",
        input: { status: "open" },
        identity: expect.objectContaining({
          appAudience: { appId: APP_ID, appVersionId: VERSION_ID },
        }),
      }),
    );
  });

  it("mode start returns the runId; poll tool reads the run", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const start = await rpc(app, "tools/call", {
      name: "reconcile",
      arguments: { input: {}, mode: "start" },
    });
    expect(start.result?.structuredContent).toEqual({ runId: "run-reconcile" });

    const poll = await rpc(app, "tools/call", {
      name: "catamorphic_poll_run",
      arguments: { runId: "run-reconcile" },
    });
    expect(poll.result?.structuredContent).toMatchObject({
      runId: "run-reconcile",
      status: "completed",
      output: { ok: "reconcile" },
    });
  });

  it("answers unknown tools with an isError result, unknown methods with -32601", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const call = await rpc(app, "tools/call", {
      name: "not_allowed",
      arguments: {},
    });
    expect(call.result?.isError).toBe(true);
    const unknown = await rpc(app, "no/such/method");
    expect(unknown.error?.code).toBe(-32601);
  });
});
