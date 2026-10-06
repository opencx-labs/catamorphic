// TEMPORARY visual verification (not committed): the desktop against a real
// Work server, through the screens added for remote development.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

const root = path.resolve(import.meta.dirname, "../../..");
const shots = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir();
let app: AppHandle;
let server: ChildProcess;
let proxy: http.Server;
let serverBase = "";
let publicUrl = "";
let operatorBase = "";
let projectId = "";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "work-dev-env-"));
const shot = (name: string) => app.screenshot(path.join(shots, `dev-env-${name}.png`));

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) => $$(selector).find((el) => !el.closest('[inert]') && el.textContent.trim().includes(text));
  const dock = () => {
    const candidates = $$('section[data-chat-local-id]').filter(el => !el.closest('[inert]') && el.getBoundingClientRect().width > 0 && el.querySelector('[data-composer-input]'));
    return candidates.find(el => el.dataset.floatingChat === 'true') ?? candidates[0];
  };
  ${setReactValueJs}
`;
const run = <T>(body: string) => app.eval<T>(`(async () => { ${helpers}\n${body} })()`);
const wait = <T>(body: string, opts?: { timeoutMs?: number; label?: string }) =>
  app.waitFor<T>(`(async () => { ${helpers}\n${body} })()`, opts);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function json(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${response.status} ${text}`);
  return body;
}

const operator = (method: string, route: string, body?: unknown) =>
  json(`${operatorBase}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${fs.readFileSync(path.join(data, "operator-secret"), "utf8").trim()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A session cookie for a local user, signed in on the server itself. */
async function sessionCookie(username: string): Promise<string> {
  const login = await fetch(`${serverBase}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify({ username, password: `${username}-e2e-password-123` }),
  });
  if (!login.ok) throw new Error(`sign-in ${login.status} ${await login.text()}`);
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function accessToken(username: string): Promise<string> {
  const cookie = await sessionCookie(username);
  const redirectUri = "http://127.0.0.1:49152/callback";
  const client = await json(`${serverBase}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], client_name: "e2e" }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await fetch(`${serverBase}/api/auth/mcp/authorize?${authorize}`, { headers: { cookie }, redirect: "manual" });
  const code = new URL(authorized.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await json(`${serverBase}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
  });
  return token.access_token;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const body = await json(`${serverBase}/api/projects/${projectId}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  if (body.result?.isError) throw new Error(`${name}: ${text}`);
  return text;
}

/**
 * The public origin: forwards everything to the server, and signs bob in
 * when the desktop's browser tab asks to authorize, as he would by typing.
 */
function startProxy(port: number, target: number): Promise<void> {
  proxy = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", publicUrl);
    const headers = { ...req.headers, host: `127.0.0.1:${target}` };
    if (url.pathname === "/api/auth/mcp/authorize" && !req.headers.cookie) {
      headers.cookie = await sessionCookie("bob");
    }
    const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) => proxy.listen(port, "127.0.0.1", () => resolve()));
}

describe("remote development from the desktop (ADRs 0205, 0207, 0208)", () => {
  beforeAll(async () => {
    const serverPort = await freePort();
    const operatorPort = await freePort();
    const proxyPort = await freePort();
    serverBase = `http://127.0.0.1:${serverPort}`;
    operatorBase = `http://127.0.0.1:${operatorPort}`;
    publicUrl = `http://127.0.0.1:${proxyPort}`;
    const log = fs.openSync(path.join(shots, "dev-env-server.log"), "w");
    server = spawn("bun", ["apps/server/src/index.ts"], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WORK_DATA_DIR: data,
        PORT: String(serverPort),
        WORK_OPERATOR_PORT: String(operatorPort),
        WORK_PUBLIC_URL: publicUrl,
        WORK_MDNS: "off",
        WORK_FAKE_AGENT: "1",
        WORK_SANDBOX: "local-process",
        WORK_PERSONAL_CREDENTIALS: "accept",
      },
      stdio: ["ignore", log, log],
    });
    await startProxy(proxyPort, serverPort);
    for (let i = 0; i < 120; i++) {
      if ((await fetch(`${serverBase}/healthz`).catch(() => null))?.ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const role = (name: string, permissions: string[]) => ({ version: 1, name, permissions, agents: ["*"], workflows: ["*"], apps: ["*"], environments: ["dev", "default"] });
    const created = await operator("POST", "/_work/operator/projects", {
      name: "Acme",
      roles: [
        { slug: "manager", definition: role("Manager", ["*"]) },
        { slug: "developer", definition: role("Developer", ["program:read", "sessions:read"]) },
      ],
      admission: { mode: "invitation_only", defaultRole: "developer", approvedDomains: [] },
    });
    projectId = created.project.id;
    for (const [username, roles] of [["ada", ["manager"]], ["bob", ["developer"]]] as const)
      await operator("POST", "/_work/operator/users", {
        username,
        name: username === "ada" ? "Ada" : "Bob",
        password: `${username}-e2e-password-123`,
        email: `${username}@example.com`,
        memberships: [{ projectId, roles }],
      });
    const ada = await accessToken("ada");
    await mcp(ada, "program_write", {
      changes: [
        {
          path: ".work/project.json",
          content: JSON.stringify({
            secrets: {
              CLICKHOUSE_API_KEY: { description: "Your own ClickHouse key for the logs cluster" },
              SENTRY_DSN: { description: "Where errors go in development" },
            },
            environments: {
              dev: {
                description: "Remote development",
                workloads: ["agent", "workflow"],
                personalCredentials: true,
                secrets: ["CLICKHOUSE_API_KEY", "SENTRY_DSN"],
                setup: "echo \"workspace ready\" > ~/.setup-marker",
              },
            },
            defaultEnvironment: "dev",
          }),
        },
      ],
    });
    await mcp(ada, "program_deploy", { message: "Remote development" });
    await json(`${serverBase}/api/projects/${projectId}/secrets/SENTRY_DSN`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ada}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "https://shared-dsn@example.ingest/1" }),
    });
    app = await launchApp();
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    server?.kill("SIGTERM");
    await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
  });

  it("connects bob to the project", async () => {
    await wait(`return !!$('[data-testid="empty-connect-remote"]');`, { timeoutMs: 60_000, label: "empty state" });
    await run(`$('[data-testid="empty-connect-remote"]').click(); return true;`);
    await wait(`return !!$('[data-testid="remote-link-input"]');`);
    const link = `work://connect?server=${encodeURIComponent(`${publicUrl}/api`)}&project=${projectId}&name=Acme`;
    await run(`setReactValue($('[data-testid="remote-link-input"]'), ${JSON.stringify(link)}); return true;`);
    await wait(`const btn = $('[data-testid="remote-connect-submit"]'); if (btn && !btn.disabled) { btn.click(); return true; } return false;`);
    await wait(`return !!$('[data-testid="remote-secrets"]');`, { timeoutMs: 90_000, label: "remote nav" });
    await shot("01-connected");
  });

  it("sets his own ClickHouse key under Secrets", async () => {
    await run(`$('[data-testid="remote-secrets"]').click(); return true;`);
    await wait(`return $$('[data-testid="remote-secret"]').length === 2;`, { label: "secrets listed" });
    await shot("02-secrets");
    await run(`$('[aria-label="Set Your value of CLICKHOUSE_API_KEY"]').click(); return true;`);
    await wait(`return !!$('[aria-label="New value of CLICKHOUSE_API_KEY for Your value"]');`);
    await run(`setReactValue($('[aria-label="New value of CLICKHOUSE_API_KEY for Your value"]'), 'ck-bob-own-0123456789'); return true;`);
    await shot("03-secret-editing");
    await run(`$('[aria-label="New value of CLICKHOUSE_API_KEY for Your value"]').closest('form').requestSubmit(); return true;`);
    await wait(`return !!$('[aria-label="Replace Your value of CLICKHOUSE_API_KEY"]');`, { label: "own value saved" });
    await shot("04-secret-saved");
    await run(`byText('button', 'Close')?.click(); return true;`);
  });

  it("chats on the server with the secrets in its workspace", async () => {
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles: true })); return true;`);
    await wait(`return !!dock()?.querySelector('[data-composer-input]');`, { label: "composer" });
    await run(`const input = dock().querySelector('[data-composer-input]'); setReactValue(input, 'run printenv CLICKHOUSE_API_KEY ;; run printenv SENTRY_DSN ;; run cat ~/.setup-marker'); input.closest('form').requestSubmit(); return true;`);
    await wait(`return dock()?.textContent.includes('workspace ready');`, { timeoutMs: 120_000, label: "agent answer" });
    const text = await run<string>(`return dock().textContent;`);
    expect(text).toContain("[secret CLICKHOUSE_API_KEY]");
    expect(text).not.toContain("ck-bob-own");
    await shot("05-chat");
  });

  it("opens a terminal in the chat's workspace", async () => {
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles: true })); return true;`);
    await wait(`return !!$('textarea[aria-label="Search commands, pages, and more"]');`);
    await run(`setReactValue($('textarea[aria-label="Search commands, pages, and more"]'), "Open terminal in this chat's workspace"); return true;`);
    await wait(`return !!byText('[role="option"]', "Open terminal in this chat");`);
    await app.press("Enter");
    await wait(`return $$('[role="tab"], button').some(el => el.textContent.includes('Terminal'));`, { timeoutMs: 60_000, label: "terminal tab" });
    await new Promise((r) => setTimeout(r, 3000));
    await app.insertText('echo "terminal sees $CLICKHOUSE_API_KEY"');
    await app.press("Enter");
    await new Promise((r) => setTimeout(r, 3000));
    await shot("06-terminal");
  });

  it("previews a dev server running in the workspace", async () => {
    // Start the dev server from the terminal, as a person would.
    await app.insertText("bun -e \"Bun.serve({port:8123,fetch:()=>new Response('<h1 style=font-family:sans-serif>Preview of the dev server in bob workspace</h1>',{headers:{'content-type':'text/html'}})})\" &");
    await app.press("Enter");
    await new Promise((r) => setTimeout(r, 3000));
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey:/Mac/.test(navigator.platform), ctrlKey:!/Mac/.test(navigator.platform), bubbles: true })); return true;`);
    await wait(`return !!$('textarea[aria-label="Search commands, pages, and more"]');`);
    await run(`setReactValue($('textarea[aria-label="Search commands, pages, and more"]'), "Open preview of this chat's workspace"); return true;`);
    await wait(`return !!byText('[role="option"]', "Open preview of this chat");`);
    await app.press("Enter");
    await wait(`return !!$('input[placeholder="3000"]');`, { label: "port dialog" });
    await run(`setReactValue($('input[placeholder="3000"]'), '8123'); return true;`);
    await shot("07-preview-port");
    await run(`$('input[placeholder="3000"]').closest('form').requestSubmit(); return true;`);
    await wait(`return $$('webview').some(view => /127\\.0\\.0\\.1:\\d+\\//.test(view.src ?? ''));`, { timeoutMs: 60_000, label: "preview tab" });
    await new Promise((r) => setTimeout(r, 4000));
    await shot("08-preview");
  });

  it("shows bob's own environment", async () => {
    await run(`$('[data-testid="remote-environment"]')?.click(); return true;`);
    await new Promise((r) => setTimeout(r, 1500));
    await shot("09-remote-environment");
  });
});
