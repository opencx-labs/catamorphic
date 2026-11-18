import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, { type ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
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
import {
  type AppHandle,
  createProjectWorkspace,
  type FrameHandle,
  launchApp,
} from "./harness.js";

const RESOURCE = "ui://mcp-security/view.html";
const FIXTURE = "mcp-security-native-fixture";
const INPUT = { seed: "original chat input" };
const RESULT = { content: [{ type: "text", text: "original chat result" }] };
const LATE_RESULT = "private-late-response-for-replaced-document";
const HTML = (
  gateUrl: string,
) => `<!doctype html><html><head><title>MCP security fixture</title></head><body>
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
const replacement=new URL(location.href).searchParams.has('replacement');
if(replacement){
  const gate=document.createElement('img');gate.loading='eager';gate.width=1;gate.height=1;
  gate.src=${JSON.stringify(gateUrl)};document.body.append(gate);
}
report('started');
send('initialize','ui/initialize',{protocolVersion:'2026-01-26',appCapabilities:{},appInfo:{name:'security-fixture',version:'1'}});
if(replacement) send('replacement-call','tools/call',{name:'allowed',arguments:{value:'replacement'}});
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
let gateServer: https.Server | undefined;
let gateCertificates: string | undefined;
let gateOrigin: string;
let gateResponse: ServerResponse | undefined;
let gateDeadline: ReturnType<typeof setTimeout> | undefined;
let gateExpired = false;
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

function releaseReplacementLoad(): void {
  clearTimeout(gateDeadline);
  const response = gateResponse;
  gateResponse = undefined;
  if (!response || response.destroyed) return;
  response.writeHead(200, { "content-type": "image/svg+xml" });
  response.end(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  );
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
          text: HTML(`${gateOrigin}/replacement.svg`),
          _meta: {
            ui: { prefersBorder: true, csp: { resourceDomains: [gateOrigin] } },
          },
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

/**
 * Where a native click lands on an MCP app button: its center in window
 * coordinates once the app view has stopped moving and nothing covers it.
 * The view can still be settling (opening, resizing) right after its
 * document initializes; a point read then sends the click past the button.
 */
async function settledGuestPoint(
  id: string,
): Promise<{ x: number; y: number }> {
  const deadline = performance.now() + 15_000;
  let previous = "";
  let last: unknown;
  while (performance.now() < deadline) {
    const inner = await mounted().eval<{ x: number; y: number } | false>(
      `(() => {
      const element=document.getElementById(${JSON.stringify(id)});if(!element)return false;
      const rect=element.getBoundingClientRect();const point={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      return rect.width>0&&rect.height>0&&element.contains(document.elementFromPoint(point.x,point.y))&&point;
    })()`,
    );
    last = inner
      ? await running().eval<{ x: number; y: number } | false>(`(() => {
      const frame=document.querySelector('iframe[title^="mcp-app-"]');if(!frame)return false;
      const moving=document.getAnimations().some(animation=>{
        const target=animation.effect?.target;
        return animation.effect?.getTiming().iterations!==Infinity&&
          (animation.pending||animation.playState==='running')&&
          target instanceof Element&&target.contains(frame);
      });
      const rect=frame.getBoundingClientRect();
      const point={x:rect.x+frame.clientLeft+${inner.x},y:rect.y+frame.clientTop+${inner.y}};
      return !moving&&document.elementFromPoint(point.x,point.y)===frame&&point;
    })()`)
      : false;
    const reading = JSON.stringify(last);
    // Two equal readings a poll apart: the button is where it will stay.
    if (last && reading === previous) return last as { x: number; y: number };
    previous = reading;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${id} MCP app button never settled under the pointer; last: ${JSON.stringify(last)}`,
  );
}

async function clickGuest(id: string): Promise<void> {
  const point = await settledGuestPoint(id);
  const before = await mounted().eval<number>("probe.clicks.length");
  await running().clickPointer(point);
  await mounted().waitFor(`probe.clicks.length > ${before}`, {
    label: `${id} MCP app received the native click at ${JSON.stringify(point)}`,
  });
  expect(await mounted().eval(`probe.clicks.slice(${before})`)).toEqual([
    { id, trusted: true },
  ]);
}

beforeAll(async () => {
  // A replacement-only pending image keeps its real load event behind the
  // startup/call observations. Otherwise revocation can destroy that iframe
  // before its asynchronous postMessage reaches the parent.
  gateCertificates = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reload-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(gateCertificates, "key.pem"),
      "-out",
      path.join(gateCertificates, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=MCP reload fixture",
    ],
    { stdio: "ignore" },
  );
  gateServer = https.createServer(
    {
      key: fs.readFileSync(path.join(gateCertificates, "key.pem")),
      cert: fs.readFileSync(path.join(gateCertificates, "cert.pem")),
    },
    (_request, response) => {
      gateResponse = response;
      gateDeadline = setTimeout(() => {
        gateExpired = true;
        response.destroy();
      }, 15_000);
      gateDeadline.unref();
    },
  );
  await new Promise<void>((resolve) =>
    gateServer?.listen(0, "127.0.0.1", resolve),
  );
  const gateAddress = gateServer.address();
  if (!gateAddress || typeof gateAddress === "string")
    throw new Error("No reload gate port");
  gateOrigin = `https://127.0.0.1:${gateAddress.port}`;
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
  // The disposable loopback certificate is accepted only in this private
  // renderer, as in remote-image.e2e.ts; the fixture CSP names only its origin.
  await handle.cdp("Security.setIgnoreCertificateErrors", { ignore: true });
  await handle.waitFor("!!document.querySelector('[data-sidebar=\"left\"]')");
  const project = await createProjectWorkspace({
    app: handle,
    name: "MCP app security",
    rootPath: path.join(handle.userDataDir, "mcp-security-project"),
  });
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
    window.__mcpFixtureMessages=[];window.__mcpReplacementCalls=[];
    window.__stopMcpFixtureMessages=event=>{
      if(event.data?.fixture===${JSON.stringify(FIXTURE)})window.__mcpFixtureMessages.push(event.data);
      if(event.source===window.__mcpReplacementSource&&event.data?.id==='replacement-call')
        window.__mcpReplacementCalls.push(event.data);
    };
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
  releaseReplacementLoad();
  completeSlow();
  guest?.close();
  const failures: unknown[] = [];
  try {
    await app?.stop();
  } catch (error) {
    failures.push(error);
  }
  app = undefined;
  const close = (server: http.Server | https.Server | undefined) =>
    new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  for (const result of await Promise.allSettled([
    close(fixtureServer),
    close(gateServer),
  ]))
    if (result.status === "rejected") failures.push(result.reason);
  try {
    if (gateCertificates)
      fs.rmSync(gateCertificates, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "MCP fixture cleanup failed");
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
  try {
    await running().eval(
      "(() => {const frame=document.querySelector('iframe[title^=\"mcp-app-\"]');window.__mcpReplacementSource=frame.contentWindow;const url=new URL(frame.src);url.searchParams.set('replacement','1');frame.src=url.href;return true})()",
    );
    await expect
      .poll(
        () =>
          Boolean(
            gateResponse &&
              !gateResponse.destroyed &&
              !gateResponse.writableEnded,
          ) && !gateExpired,
        { timeout: 15_000 },
      )
      .toBe(true);
    await running().waitFor(
      `window.__mcpFixtureMessages.some(message=>message.kind==='started' && message.documentId!==${JSON.stringify(original)}) && window.__mcpReplacementCalls.length===1`,
      {
        label:
          "replacement document started and attempted its call before load revocation",
      },
    );
    expect(
      await running().eval(`(() => {
      const frame=document.querySelector('iframe[title^="mcp-app-"]');
      return !!frame && frame.contentWindow===window.__mcpReplacementSource &&
        new URL(frame.src).searchParams.get('replacement')==='1';
    })()`),
    ).toBe(true);
    expect(gateExpired).toBe(false);
    expect(gateResponse?.destroyed).toBe(false);
    expect(gateResponse?.writableEnded).toBe(false);
    expect(executions.filter((call) => call.name === "allowed")).toEqual([
      { name: "allowed", arguments: { value: "clicked" } },
    ]);
    releaseReplacementLoad();
    await running().waitFor(
      "document.body.innerText.includes('This app navigated away')",
      { label: "MCP app reload revoked its mounted document" },
    );
  } finally {
    releaseReplacementLoad();
  }
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
