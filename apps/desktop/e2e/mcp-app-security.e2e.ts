import http from "node:http";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { type AppHandle, type FrameHandle, launchApp } from "./harness.js";

const RESOURCE = "ui://mcp-security/view.html";
const FIXTURE = "mcp-security-native-fixture";
const INPUT = { seed: "original chat input" };
const RESULT = { content: [{ type: "text", text: "original chat result" }] };
const LATE_RESULT = "private-late-response-for-replaced-document";
const HTML = `<!doctype html><html><head><title>MCP security fixture</title></head><body>
<main style="font:16px system-ui;padding:28px;max-width:620px">
<h1>MCP security fixture</h1><p id="initialized">Waiting for the host</p>
<p>Input: <output id="input">Waiting</output></p><p>Result: <output id="result">Waiting</output></p>
<button id="allowed">Call allowed tool</button><button id="denied">Call denied tool</button><button id="slow">Start delayed tool</button>
<pre id="allowed-result"></pre><pre id="denied-result"></pre><pre id="slow-result"></pre>
</main><script>
const documentId=crypto.randomUUID();
window.probe={documentId,messages:[],clicks:[],initialized:false,input:null,result:null};
const report=(kind,data)=>parent.postMessage({fixture:${JSON.stringify(FIXTURE)},kind,documentId,data},'*');
const send=(id,method,params)=>parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
addEventListener('message',event=>{
  const data=event.data;
  if(event.source!==parent || data?.jsonrpc!=='2.0') return;
  probe.messages.push({data,origin:event.origin,viaPort:!event.isTrusted});
  report('received',data);
  if(data.id==='initialize' && data.result){probe.initialized=true;document.querySelector('#initialized').textContent='Host initialized';}
  if(data.method==='ui/notifications/tool-input'){probe.input=data.params.arguments;document.querySelector('#input').textContent=JSON.stringify(probe.input);}
  if(data.method==='ui/notifications/tool-result'){probe.result=data.params.result;document.querySelector('#result').textContent=JSON.stringify(probe.result);}
  if(['allowed','denied','slow'].includes(data.id)) document.querySelector('#'+data.id+'-result').textContent=JSON.stringify(data.result??data.error);
});
document.querySelector('#allowed').onclick=()=>send('allowed','tools/call',{name:'allowed',arguments:{value:'clicked'}});
document.querySelector('#denied').onclick=()=>send('denied','tools/call',{name:'denied',arguments:{}});
document.querySelector('#slow').onclick=()=>send('slow','tools/call',{name:'slow',arguments:{}});
for(const button of document.querySelectorAll('button')) button.addEventListener('click',event=>probe.clicks.push({id:button.id,trusted:event.isTrusted}));
report('started');
send('initialize','ui/initialize',{protocolVersion:'2026-01-26',appCapabilities:{},appInfo:{name:'security-fixture',version:'1'}});
if(new URL(location.href).searchParams.has('replacement')) send('replacement-call','tools/call',{name:'allowed',arguments:{value:'replacement'}});
</script></body></html>`;

const tools = [
  {
    name: "view",
    description: "Show the fixture",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: RESOURCE } },
  },
  {
    name: "allowed",
    description: "An allowed read",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "denied",
    description: "A denied read",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slow",
    description: "A delayed read",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
];

let app: AppHandle | undefined;
let guest: FrameHandle | undefined;
let fixtureServer: http.Server | undefined;
let toolKey: string;
let projectId: string;
let localId: string;
let finishSlow: ((result: CallToolResult) => void) | undefined;
const executions: { name: string; arguments: unknown }[] = [];
const fixtureErrors: string[] = [];

function running(): AppHandle {
  if (!app) throw new Error("The MCP security app is not running");
  return app;
}
function mounted(): FrameHandle {
  if (!guest) throw new Error("The MCP security frame is not mounted");
  return guest;
}
function completeSlow(): void {
  finishSlow?.({ content: [{ type: "text", text: LATE_RESULT }] });
  finishSlow = undefined;
}

async function serve(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcp = new Server(
    { name: "native-mcp-security", version: "1" },
    { capabilities: { tools: {}, resources: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: RESOURCE,
        name: "MCP security fixture",
        mimeType: "text/html;profile=mcp-app",
      },
    ],
  }));
  mcp.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== RESOURCE) throw new Error("Unknown fixture resource");
    return {
      contents: [
        {
          uri: RESOURCE,
          mimeType: "text/html;profile=mcp-app",
          text: HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    };
  });
  mcp.setRequestHandler(
    CallToolRequestSchema,
    async ({ params }): Promise<CallToolResult> => {
      executions.push({ name: params.name, arguments: params.arguments });
      if (params.name === "slow")
        return new Promise<CallToolResult>((resolve) => {
          finishSlow = resolve;
        });
      if (params.name === "allowed")
        return {
          content: [{ type: "text", text: "allowed-response:clicked" }],
          structuredContent: { accepted: params.arguments?.value },
        };
      if (params.name === "denied")
        return { content: [{ type: "text", text: "DENIED TOOL EXECUTED" }] };
      return { content: [{ type: "text", text: "fixture source result" }] };
    },
  );
  response.once("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  let body = "";
  for await (const chunk of request) body += chunk;
  await transport.handleRequest(
    request,
    response,
    body ? JSON.parse(body) : undefined,
  );
}

async function clickGuest(id: string): Promise<void> {
  const point = await mounted().waitFor<{ x: number; y: number }>(
    `(() => {
    const element=document.getElementById(${JSON.stringify(id)});if(!element)return false;
    const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`,
    { label: `${id} MCP app button ready` },
  );
  const offset = await running().eval<{ x: number; y: number }>(`(() => {
    const rect=document.querySelector('iframe[title^="mcp-app-"]').getBoundingClientRect();return {x:rect.x,y:rect.y};
  })()`);
  const before = await mounted().eval<number>("probe.clicks.length");
  await running().clickPointer({
    x: point.x + offset.x,
    y: point.y + offset.y,
  });
  await mounted().waitFor(`probe.clicks.length > ${before}`, {
    label: `${id} MCP app received the native click`,
  });
  expect(await mounted().eval(`probe.clicks.slice(${before})`)).toEqual([
    { id, trusted: true },
  ]);
}

beforeAll(async () => {
  fixtureServer = http.createServer((request, response) => {
    void serve(request, response).catch((cause: unknown) => {
      fixtureErrors.push(String(cause));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    fixtureServer?.listen(0, "127.0.0.1", resolve),
  );
  const address = fixtureServer.address();
  if (!address || typeof address === "string")
    throw new Error("No MCP fixture port");
  app = await launchApp({ sandboxedRenderers: true });
  const handle = running();
  await handle.waitFor("!!document.querySelector('[data-sidebar=\"left\"]')");
  const project = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "MCP app security", rootPath: path.join(handle.userDataDir, "mcp-security-project") })})`,
  );
  projectId = project.id;
  const connection = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.connectionsCreate(${JSON.stringify({ name: "MCP Security", transport: "http", url: `http://127.0.0.1:${address.port}/mcp` })})`,
  );
  await handle.eval(
    `window.catamorphicDesktop.connectionsSetPolicy(${JSON.stringify(connection.id)},{default:'deny',tools:{view:'allow',allowed:'allow',slow:'allow',denied:'deny'}})`,
  );
  toolKey = await handle.waitFor<string>(
    `window.catamorphicDesktop.mcpAppsUiTools().then(tools=>Object.entries(tools).find(([,uri])=>uri===${JSON.stringify(RESOURCE)})?.[0])`,
    { label: "local connector exposes its real UI resource" },
  );
  const agentId = await handle.eval<string>(
    "window.catamorphicDesktop.agentsList().then(roster=>roster.defaultAgentId)",
  );
  const api = await handle.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  const response = await fetch(
    `${api.url}/api/projects/${projectId}/agent/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "MCP fixture chat",
        source: "desktop",
        agentId,
      }),
    },
  );
  expect(response.status).toBe(201);
  const session: unknown = await response.json();
  if (
    !session ||
    typeof session !== "object" ||
    !("id" in session) ||
    typeof session.id !== "string"
  )
    throw new Error("No fixture session id");
  await handle.reload();
  await handle.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await handle.eval(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))",
  );
  localId = await handle.waitFor<string>(
    "document.querySelector('[data-chat-local-id]:not([inert])')?.dataset.chatLocalId",
    { label: "native fixture chat registered" },
  );
  await handle.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(snapshot=>snapshot.chats.some(chat=>chat.entry.localId===${JSON.stringify(localId)} && chat.projectId===${JSON.stringify(projectId)}))`,
    { label: "fixture chat published to the native dock registry" },
  );
  await handle.eval(
    `window.catamorphicDesktop.dockCommand(${JSON.stringify({ projectId, localId, event: { kind: "session", sessionId: session.id } })})`,
  );
  await handle.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(snapshot=>snapshot.chats.some(chat=>chat.entry.localId===${JSON.stringify(localId)} && chat.entry.sessionId===${JSON.stringify(session.id)}))`,
    { label: "UI chat bound to the real session" },
  );
  await handle.eval(`(() => {
    window.__mcpFixtureMessages=[];
    window.__stopMcpFixtureMessages=event=>{if(event.data?.fixture===${JSON.stringify(FIXTURE)})window.__mcpFixtureMessages.push(event.data)};
    addEventListener('message',window.__stopMcpFixtureMessages);return true;
  })()`);
  // The normal dock command invokes ChatRegistration's actual onOpenMcpApp callback.
  await handle.eval(
    `window.catamorphicDesktop.dockCommand(${JSON.stringify({ projectId, localId, event: { kind: "mcpApp", mode: "tab", view: { toolKey, toolUseId: "native-security-source-call", title: "MCP security fixture", toolInput: INPUT, toolResult: RESULT } } })})`,
  );
  const url = await handle.waitFor<string>(
    "document.querySelector('iframe[title^=\"mcp-app-\"]')?.src",
    { label: "actual McpAppScreen mounted its native guest" },
  );
  expect(url).toMatch(/^work-guest:\/\/mcp\//);
  guest = await handle.connectToFrame(url);
});

afterEach(async (context) => {
  if (context.task.result?.state === "fail" && app) {
    const root = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir;
    await app
      .screenshot(path.join(root, "mcp-app-security-failure.png"))
      .catch(() => {});
    console.error(app.getOutput(), fixtureErrors);
  }
});
afterAll(async () => {
  completeSlow();
  guest?.close();
  await app?.stop();
  app = undefined;
  fixtureServer?.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    fixtureServer
      ? fixtureServer.close((error) => (error ? reject(error) : resolve()))
      : resolve(),
  );
});

it("initializes the real opaque-origin MCP app and seeds it through its document MessagePort", async () => {
  await mounted().waitFor(
    "window.probe?.initialized && window.probe.input && window.probe.result",
    { label: "real Origin API accepts the initialized MCP document" },
  );
  expect(
    await mounted().eval("({input:probe.input,result:probe.result})"),
  ).toEqual({ input: INPUT, result: RESULT });
  expect(
    await mounted().eval(
      "({origin:window.origin,bridge:typeof window.catamorphicDesktop,node:typeof require})",
    ),
  ).toEqual({ origin: "null", bridge: "undefined", node: "undefined" });
  expect(
    await mounted().eval(
      "probe.messages.every(message=>message.viaPort && message.origin==='work-internal://shell')",
    ),
  ).toBe(true);
  expect(
    await mounted().eval(
      "probe.messages.some(message=>message.data.id==='initialize' && typeof message.data.result?.hostContext?.theme==='string')",
    ),
  ).toBe(true);
});

it("returns a clicked allowed call over the port and refuses a denied tool before execution", async () => {
  await clickGuest("allowed");
  await mounted().waitFor(
    "document.querySelector('#allowed-result')?.textContent.includes('allowed-response:clicked')",
    { label: "allowed MCP result returned through the live bridge" },
  );
  expect(executions.filter((call) => call.name === "allowed")).toEqual([
    { name: "allowed", arguments: { value: "clicked" } },
  ]);
  await clickGuest("denied");
  await mounted().waitFor(
    "document.querySelector('#denied-result')?.textContent.includes('not allowed')",
    { label: "denied MCP tool has a bridge error response" },
  );
  expect(executions.filter((call) => call.name === "denied")).toEqual([]);
  expect(
    await mounted().eval(
      "probe.messages.filter(message=>['allowed','denied'].includes(message.data.id)).every(message=>message.viaPort)",
    ),
  ).toBe(true);
  const root =
    process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? running().userDataDir;
  await running().screenshot(path.join(root, "mcp-app-security.png"));
});

it("revokes a reloaded iframe and never delivers its old in-flight result to the replacement document", async () => {
  const original = await mounted().eval<string>("probe.documentId");
  await clickGuest("slow");
  await expect
    .poll(() => executions.filter((call) => call.name === "slow").length)
    .toBe(1);
  await running().eval(
    "(() => {const frame=document.querySelector('iframe[title^=\"mcp-app-\"]');const url=new URL(frame.src);url.searchParams.set('replacement','1');frame.src=url.href;return true})()",
  );
  await running().waitFor(
    "document.body.innerText.includes('This app navigated away')",
    { label: "MCP app reload revoked its mounted document" },
  );
  await running().waitFor(
    `window.__mcpFixtureMessages.some(message=>message.kind==='started' && message.documentId!==${JSON.stringify(original)})`,
    { label: "a replacement opaque-origin document started" },
  );
  completeSlow();
  await expect
    .poll(() => running().getOutput())
    .toContain("This app view is no longer available");
  expect(
    await running().eval(
      `JSON.stringify(window.__mcpFixtureMessages).includes(${JSON.stringify(LATE_RESULT)})`,
    ),
  ).toBe(false);
  expect(executions.filter((call) => call.name === "allowed")).toEqual([
    { name: "allowed", arguments: { value: "clicked" } },
  ]);
  expect(
    await running().eval(
      `window.__mcpFixtureMessages.filter(message=>message.kind==='received' && message.documentId!==${JSON.stringify(original)})`,
    ),
  ).toEqual([]);
});
