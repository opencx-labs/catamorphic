import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  removeE2eDirectory,
  setReactValueJs,
  terminate,
} from "./harness.js";

/**
 * Remote development end to end (ADRs 0205, 0207, 0208): a member connects
 * the desktop to a real Work server, sets their own value of a project
 * secret, chats with an agent whose workspace has the Environment's secrets
 * and setup, then opens a terminal in that workspace, starts a server there
 * and previews it in a browser tab. The server runs chats as local
 * processes and accepts personal credentials, so a member's own chat is
 * theirs alone and receives secrets.
 */

const SERVER_DIR = path.resolve(import.meta.dirname, "../../server");
const ARTIFACTS = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir();
const OWN_KEY = "ck-bob-own-0123456789";
const SHARED_DSN = "https://shared-dsn@example.ingest/1";
const PASSWORD = (username: string) => `${username}-e2e-password-123`;

let app: AppHandle;
let server: ChildProcess | undefined;
let proxy: http.Server | undefined;
let dataDir = "";
let serverBase = "";
let operatorBase = "";
let publicUrl = "";
let projectId = "";

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => !el.closest('[inert]') && el.textContent.trim().includes(text));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const composer = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'))
      ?.querySelector('[data-composer-input]');
  const timeline = () => $$('[role="log"]').map((el) => el.textContent).join('\\n');
  const palette = () => $$('textarea[aria-label="Search commands, pages, and more"]')
    .find((el) => !el.closest('[inert]') && el.getBoundingClientRect().width > 0);
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
const shot = (name: string) =>
  app.screenshot(path.join(ARTIFACTS, `remote-development-${name}.png`));

/** Run a command from the palette by its label. */
async function command(label: string): Promise<void> {
  await runWait(`return !palette();`, { label: "no palette open" });
  await run(`pressKey('p', { metaKey: true }); return true;`);
  await runWait(`return document.activeElement === palette();`, {
    label: "palette open",
  });
  await run(`setReactValue(palette(), ${JSON.stringify(label)}); return true;`);
  await runWait(
    `return !!palette().closest('[role="dialog"]').querySelector('[role="option"][aria-selected="true"]')?.textContent.includes(${JSON.stringify(label)});`,
    { label: `palette selects ${label}` },
  );
  await app.press("Enter");
}

/** Type a line into the focused chat terminal and run it. */
async function type(line: string): Promise<void> {
  await run(`$('textarea[aria-label="Terminal input"]').focus(); return true;`);
  await app.insertText(line);
  await app.press("Enter");
}

/** Wait until the chat terminal has printed this text. */
function terminalShows(text: string): Promise<unknown> {
  return runWait(
    `return window.catamorphicDesktop.terminalBuffer(window.__terminalIds[0]).then((b) => !!b?.buffer.includes(${JSON.stringify(text)}));`,
    { timeoutMs: 30_000, label: `terminal shows ${text}` },
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${url}: ${response.status} ${text}`,
    );
  return (text ? JSON.parse(text) : {}) as T;
}

function operator<T>(method: string, route: string, body?: unknown) {
  const secret = fs
    .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
    .trim();
  return json<T>(`${operatorBase}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A browser session for a local user, signed in on the server itself. */
async function sessionCookie(username: string): Promise<string> {
  const response = await fetch(`${serverBase}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify({ username, password: PASSWORD(username) }),
  });
  if (!response.ok)
    throw new Error(`sign-in ${response.status} ${await response.text()}`);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** An access token for a local user, by the authorization code flow. */
async function accessToken(username: string): Promise<string> {
  const cookie = await sessionCookie(username);
  const redirectUri = "http://127.0.0.1:49152/callback";
  const client = await json<{ client_id: string }>(
    `${serverBase}/api/auth/mcp/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        client_name: "remote-development-e2e",
      }),
    },
  );
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "e2e",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await fetch(
    `${serverBase}/api/auth/mcp/authorize?${authorize}`,
    { headers: { cookie }, redirect: "manual" },
  );
  const code =
    new URL(
      authorized.headers.get("location") ?? "http://invalid",
    ).searchParams.get("code") ?? "";
  const token = await json<{ access_token: string }>(
    `${serverBase}/api/auth/mcp/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    },
  );
  return token.access_token;
}

/** Call a tool on the project's MCP endpoint as a member. */
async function projectTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const body = await json<{
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  }>(`${serverBase}/api/projects/${projectId}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  if (body.result?.isError) throw new Error(`${name}: ${text}`);
  return text;
}

/**
 * The server's public origin. It forwards everything, and signs bob in
 * when the desktop's browser tab opens the authorization page, as he would
 * by typing his password there.
 */
function startProxy(port: number, target: number): Promise<void> {
  proxy = http.createServer((req, res) => {
    const forward = (cookie?: string) => {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: target,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${target}`,
            ...(cookie ? { cookie } : {}),
          },
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    };
    const url = new URL(req.url ?? "/", publicUrl);
    if (url.pathname === "/api/auth/mcp/authorize" && !req.headers.cookie) {
      sessionCookie("bob").then(forward, () => res.destroy());
      return;
    }
    forward();
  });
  return new Promise((resolve) => {
    proxy?.listen(port, "127.0.0.1", () => resolve());
  });
}

describe("remote development on a Work server", () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-development-"));
    const [serverPort, operatorPort, proxyPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    serverBase = `http://127.0.0.1:${serverPort}`;
    operatorBase = `http://127.0.0.1:${operatorPort}`;
    publicUrl = `http://127.0.0.1:${proxyPort}`;
    const log = fs.openSync(
      path.join(ARTIFACTS, "remote-development-server.log"),
      "w",
    );
    server = spawn("bun", ["src/index.ts"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        // The standalone PGlite host; shared Postgres is covered elsewhere.
        DATABASE_URL: "",
        PORT: String(serverPort),
        WORK_OPERATOR_PORT: String(operatorPort),
        WORK_PUBLIC_URL: publicUrl,
        WORK_DATA_DIR: dataDir,
        WORK_MDNS: "off",
        WORK_FAKE_AGENT: "1",
        WORK_SANDBOX: "local-process",
        // A member's own chat is theirs alone here (ADR 0184), so it
        // receives the Environment's secrets (ADR 0205).
        WORK_PERSONAL_CREDENTIALS: "accept",
      },
      stdio: ["ignore", log, log],
    });
    await startProxy(proxyPort, serverPort);
    const deadline = Date.now() + 90_000;
    while (!(await fetch(`${serverBase}/healthz`).catch(() => null))?.ok) {
      if (Date.now() > deadline || server.exitCode !== null)
        throw new Error("The Work server did not start; see its log");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const role = (name: string, permissions: string[]) => ({
      version: 1,
      name,
      permissions,
      agents: ["*"],
      workflows: ["*"],
      apps: ["*"],
      environments: ["dev"],
    });
    const created = await operator<{ project: { id: string } }>(
      "POST",
      "/_work/operator/projects",
      {
        name: "Acme",
        roles: [
          { slug: "manager", definition: role("Manager", ["*"]) },
          {
            slug: "developer",
            definition: role("Developer", ["program:read", "sessions:read"]),
          },
        ],
        admission: {
          mode: "invitation_only",
          defaultRole: "developer",
          approvedDomains: [],
        },
      },
    );
    projectId = created.project.id;
    for (const [username, roles] of [
      ["ada", ["manager"]],
      ["bob", ["developer"]],
    ] as const) {
      await operator("POST", "/_work/operator/users", {
        username,
        name: username === "ada" ? "Ada" : "Bob",
        password: PASSWORD(username),
        email: `${username}@example.com`,
        memberships: [{ projectId, roles }],
      });
    }
    const ada = await accessToken("ada");
    await projectTool(ada, "program_write", {
      changes: [
        {
          path: ".work/project.json",
          content: `${JSON.stringify(
            {
              secrets: {
                CLICKHOUSE_API_KEY: {
                  description: "Your own key for the logs cluster",
                },
                SENTRY_DSN: { description: "Where errors go in development" },
              },
              environments: {
                dev: {
                  description: "Remote development",
                  workloads: ["agent", "workflow"],
                  personalCredentials: true,
                  secrets: ["CLICKHOUSE_API_KEY", "SENTRY_DSN"],
                  setup:
                    'echo "project setup saw a key of $(printf %s "$CLICKHOUSE_API_KEY" | wc -c | tr -d " ")" > "$HOME/.project-setup"',
                },
              },
              defaultEnvironment: "dev",
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    const deployed = await projectTool(ada, "program_deploy", {
      message: "Remote development",
    });
    expect(deployed).not.toContain("blocked");
    await json(`${serverBase}/api/projects/${projectId}/secrets/SENTRY_DSN`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ada}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: SHARED_DSN }),
    });
    app = await launchApp();
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    if (server) await terminate(server);
    await new Promise<void>((resolve) =>
      proxy ? proxy.close(() => resolve()) : resolve(),
    );
    if (dataDir) removeE2eDirectory(dataDir);
  });

  it("connects bob to the project from a link", async () => {
    await runWait(`return !!$('[data-testid="empty-connect-remote"]');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(
      `$('[data-testid="empty-connect-remote"]').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="remote-link-input"]');`, {
      label: "connect modal",
    });
    const link = `work://connect?server=${encodeURIComponent(`${publicUrl}/api`)}&project=${projectId}&name=Acme`;
    await run(
      `setReactValue($('[data-testid="remote-link-input"]'), ${JSON.stringify(link)}); return true;`,
    );
    await runWait(
      `const button = $('[data-testid="remote-connect-submit"]'); if (!button || button.disabled) return false; button.click(); return true;`,
      { label: "connect" },
    );
    await runWait(`return !!$('[data-testid="remote-secrets"]');`, {
      timeoutMs: 90_000,
      label: "connected project",
    });
  });

  it("sets his own value of a secret, never shown again", async () => {
    await run(`$('[data-testid="remote-secrets"]').click(); return true;`);
    await runWait(
      `return $$('[data-testid="remote-secret"]').length === 2 && !!$('[aria-label="Set Your value of CLICKHOUSE_API_KEY"]');`,
      { label: "declared secrets" },
    );
    // A developer manages no shared values: only his own row.
    expect(
      await run<boolean>(
        `return !!$('[aria-label="Set Shared value of SENTRY_DSN"], [aria-label="Replace Shared value of SENTRY_DSN"]');`,
      ),
    ).toBe(false);
    await run(
      `$('[aria-label="Set Your value of CLICKHOUSE_API_KEY"]').click(); return true;`,
    );
    const field = `$('[aria-label="New value of CLICKHOUSE_API_KEY for Your value"]')`;
    await runWait(`return !!${field};`, { label: "value field" });
    await run(
      `setReactValue(${field}, ${JSON.stringify(OWN_KEY)}); return true;`,
    );
    await run(`${field}.closest('form').requestSubmit(); return true;`);
    await runWait(
      `return !!$('[aria-label="Replace Your value of CLICKHOUSE_API_KEY"]');`,
      { label: "own value saved" },
    );
    expect(await run<string>(`return document.body.innerText;`)).not.toContain(
      OWN_KEY,
    );
    await shot("secrets");
    await run(
      `byText('[role="dialog"] button, dialog button', 'Done').click(); return true;`,
    );
    await runWait(`return !$('[data-testid="remote-secret"]');`, {
      label: "secrets closed",
    });
  });

  it("sends his own setup to the server", async () => {
    const projectDir = path.join(app.userDataDir, "Work", "acme");
    fs.mkdirSync(path.join(projectDir, ".work", "personal"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectDir, ".work", "personal", "environment.json"),
      `${JSON.stringify({ setup: 'echo "personal setup ran" > "$HOME/.personal-setup"' })}\n`,
    );
    await run(`$('[data-testid="remote-environment"]').click(); return true;`);
    await runWait(
      `return $('[data-testid="remote-environment-setup"]')?.textContent.includes('personal setup ran');`,
      { label: "setup listed" },
    );
    await runWait(
      `const button = byText('button', 'Send now'); if (!button || button.disabled) return false; button.click(); return true;`,
      { label: "send now" },
    );
    await runWait(
      `return $('[data-testid="remote-environment-setup"]')?.textContent.includes('On the server');`,
      { timeoutMs: 30_000, label: "setup on the server" },
    );
    await shot("environment");
    await run(
      `byText('[role="dialog"] button, dialog button', 'Done').click(); return true;`,
    );
    await runWait(`return !$('[data-testid="remote-environment-setup"]');`, {
      label: "environment closed",
    });
  });

  it("chats in a workspace with the secrets and both setups", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "composer" });
    const message = [
      "run printenv CLICKHOUSE_API_KEY",
      "run printenv SENTRY_DSN",
      'run cat "$HOME/.project-setup" "$HOME/.personal-setup"',
    ].join(" ;; ");
    await run(
      `const input = composer(); setReactValue(input, ${JSON.stringify(message)}); input.closest('form').requestSubmit(); return true;`,
    );
    await runWait(`return timeline().includes('personal setup ran');`, {
      timeoutMs: 120_000,
      label: "agent answer",
    });
    const text = await run<string>(`return timeline();`);
    // The turn's output names the values; it never shows them.
    expect(text).toContain("[secret CLICKHOUSE_API_KEY]");
    expect(text).toContain("[secret SENTRY_DSN]");
    expect(text).not.toContain(OWN_KEY);
    expect(text).not.toContain(SHARED_DSN);
    expect(text).toContain(`project setup saw a key of ${OWN_KEY.length}`);
    await shot("chat");
  });

  it("opens a terminal in the chat's workspace", async () => {
    await run(
      `window.__terminalIds = []; window.catamorphicDesktop.onTerminalData(({ sessionId }) => { if (!window.__terminalIds.includes(sessionId)) window.__terminalIds.push(sessionId); }); return true;`,
    );
    await command("Open terminal in this chat's workspace");
    await runWait(
      `return window.__terminalIds.length === 1 && !!$('textarea[aria-label="Terminal input"]');`,
      { timeoutMs: 60_000, label: "remote shell" },
    );
    // Output, not the typed line: the command's text never contains it.
    await type(
      'echo "terminal key $(printf %s "$CLICKHOUSE_API_KEY" | wc -c | tr -d " ") $(cat "$HOME/.personal-setup")"',
    );
    await terminalShows(`terminal key ${OWN_KEY.length} personal setup ran`);
    await shot("terminal");
  });

  it("previews a server started in that terminal", async () => {
    const port = await freePort();
    const marker = `Preview of bob's workspace on ${port}`;
    // Started as a person would, then waited for until it answers.
    await type(
      `mkdir -p "$HOME/site" && printf '<h1>%s</h1>' "${marker}" > "$HOME/site/index.html" && (cd "$HOME/site" && python3 -m http.server ${port} --bind 127.0.0.1 > /dev/null 2>&1 &) && until python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/')" 2> /dev/null; do sleep 0.2; done && echo "serving $((${port} + 1))"`,
    );
    await terminalShows(`serving ${port + 1}`);
    await command("Open preview of this chat's workspace");
    await runWait(`return !!$('input[placeholder="3000"]');`, {
      label: "port dialog",
    });
    await run(
      `setReactValue($('input[placeholder="3000"]'), ${JSON.stringify(String(port))}); return true;`,
    );
    await shot("preview-port");
    await runWait(
      `const button = byText('button', 'Open preview'); if (!button || button.disabled) return false; button.click(); return true;`,
      { label: "open preview" },
    );
    await runWait(`return !$('input[placeholder="3000"]');`, {
      timeoutMs: 30_000,
      label: "preview opened",
    });
    const src = await runWait<string>(
      `return $$('webview').map((view) => view.getAttribute('src') ?? '').find((src) => /^http:\\/\\/p-[^.]+\\.localhost:\\d+\\//.test(src)) ?? false;`,
      { timeoutMs: 30_000, label: "preview tab" },
    );
    const page = await app.connectToFrame(new URL(src).host);
    try {
      await page.waitFor(
        `document.body?.innerText.includes(${JSON.stringify(marker)})`,
        { timeoutMs: 30_000, label: "preview page" },
      );
    } finally {
      page.close();
    }
    await shot("preview");
  });
});
