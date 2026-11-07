import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_APPS_DIR,
  PROJECT_WORKSPACE_ROOT,
} from "@catamorphic/workflow/project-layout";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { assertIsolatedDesktopTestHost } from "../../../scripts/desktop-test-environment.js";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  removeE2eDirectory,
} from "./harness.js";
import { electronLaunchArgs } from "./harness-args.js";
import { addSidebarSections } from "./sidebar-config.js";

const requireFromTest = createRequire(import.meta.url);
const APP_NAME = "security-probe";
const LEGACY_VALUES = {
  "review-comment:security:new": "An unsent review draft from the file origin",
  "catamorphic.draft:security-project:main": JSON.stringify({
    "notes.md": "An unsaved document draft",
  }),
  "catamorphic:sidebar:security-migration:left": JSON.stringify({
    width: 377,
    selected: "notes",
  }),
};
const UPDATED_VALUES = {
  "review-comment:security:new": "Edited after moving to the internal origin",
  "catamorphic.draft:security-project:main": JSON.stringify({
    "notes.md": "Edited in the new origin",
  }),
  "catamorphic:sidebar:security-migration:left": JSON.stringify({
    width: 415,
    selected: "files",
  }),
};

let app: AppHandle | undefined;
let directory: string;
let userDataDir: string;
let projectId: string;
let apiUrl: string;
let profileId: string;
let sourceUrl: string;
let fixtureServer: http.Server | undefined;
let fixtureUrl: string;
const frames = new Set<FrameHandle>();

function running(): AppHandle {
  if (!app) throw new Error("The security test app is not running");
  return app;
}

/** Uses Chromium's real file-origin storage, never edits its LevelDB files. */
async function legacyStorage(
  input: { seed?: Record<string, string> } = {},
): Promise<Record<string, string | null>> {
  assertIsolatedDesktopTestHost();
  const binary: unknown = requireFromTest("electron");
  if (typeof binary !== "string")
    throw new Error("Electron did not resolve to a binary");
  const marker = `WORK_LEGACY_STORAGE_${randomUUID()}:`;
  const file = path.join(directory, "legacy-storage.cjs");
  const readKeys = [...Object.keys(LEGACY_VALUES), "__work_origin_migrated_v1"];
  const expression = `(() => {
    for (const [key, value] of Object.entries(${JSON.stringify(input.seed ?? {})})) localStorage.setItem(key, value);
    return Object.fromEntries(${JSON.stringify(readKeys)}.map(key => [key, localStorage.getItem(key)]));
  })()`;
  const legacyHtml = path.join(directory, "legacy.html");
  fs.writeFileSync(
    legacyHtml,
    "<!doctype html><title>Legacy storage fixture</title>",
  );
  fs.writeFileSync(
    file,
    `
const {app, BrowserWindow} = require('electron');
app.setPath('userData', ${JSON.stringify(userDataDir)});
app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try {
    await window.loadFile(${JSON.stringify(legacyHtml)});
    const values = await window.webContents.executeJavaScript(${JSON.stringify(expression)});
    process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(values) + '\\n');
    window.close();
    app.quit();
  } catch (error) {
    process.stderr.write(String(error) + '\\n');
    app.exit(1);
  }
});
`,
  );
  // Match the main harness's isolated-host flags, substituting only the fixture entry point.
  const switches = electronLaunchArgs({
    cdpPort: 0,
    ci: process.env.CI,
    platform: process.platform,
    useMockKeychain: true,
    sandboxedRenderers: true,
  }).slice(1);
  const child = spawn(binary, [file, ...switches], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Legacy storage fixture timed out: ${errors}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else
        reject(
          new Error(
            `Legacy storage fixture exited ${code ?? signal}: ${errors}`,
          ),
        );
    });
  });
  const result = output.split("\n").find((line) => line.startsWith(marker));
  if (!result)
    throw new Error(
      `Legacy storage fixture returned no storage snapshot: ${errors}`,
    );
  const value: unknown = JSON.parse(result.slice(marker.length));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid legacy storage snapshot");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (item !== null && typeof item !== "string")
        throw new Error("Invalid legacy storage value");
      return [key, item];
    }),
  );
}

const storedValues = () =>
  running().eval<Record<string, string | null>>(
    `Object.fromEntries(${JSON.stringify(Object.keys(LEGACY_VALUES))}.map(key => [key, localStorage.getItem(key)]))`,
  );

const fixtureCode = `
document.getElementById('root').innerHTML = '<main style="font:16px system-ui;padding:32px"><h1>Security probe</h1><p>This project app runs in its own document.</p><button id="probe-button">Check app interaction</button><output id="probe-result" style="display:block;margin-top:16px">Ready</output></main>';
document.getElementById('probe-button').addEventListener('click', (event) => {
  const output = document.getElementById('probe-result');
  output.dataset.clicks = String(Number(output.dataset.clicks ?? '0') + 1);
  output.dataset.trusted = String(event.isTrusted);
  output.textContent = 'The isolated app is interactive';
});
`;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-electron-security-"));
  userDataDir = path.join(directory, "user-data");
  fs.mkdirSync(userDataDir);
  expect(await legacyStorage({ seed: LEGACY_VALUES })).toEqual({
    ...LEGACY_VALUES,
    __work_origin_migrated_v1: null,
  });
  app = await launchApp({ userDataDir, sandboxedRenderers: true });
  const handle = running();
  await handle.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const projectRoot = path.join(directory, "security-project");
  const project = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Electron security", rootPath: projectRoot })})`,
  );
  projectId = project.id;
  const appRoot = path.join(projectRoot, PROJECT_APPS_DIR, APP_NAME);
  fs.mkdirSync(appRoot, { recursive: true });
  // The fixture has no registry dependencies or network install steps.
  fs.writeFileSync(
    path.join(projectRoot, PROJECT_WORKSPACE_ROOT, "package.json"),
    JSON.stringify({
      name: "security-fixture",
      private: true,
      workspaces: ["apps/*"],
    }),
  );
  fs.writeFileSync(
    path.join(appRoot, "package.json"),
    JSON.stringify({
      name: APP_NAME,
      private: true,
      type: "module",
      scripts: { build: "bun build.mjs" },
    }),
  );
  fs.writeFileSync(path.join(appRoot, "probe.js"), fixtureCode);
  fs.writeFileSync(
    path.join(appRoot, "build.mjs"),
    `import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.copyFileSync('probe.js','dist/app.js');`,
  );
  profileId = await handle.eval<string>(
    "window.catamorphicDesktop.windowProfile()",
  );
  const server = await handle.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  apiUrl = server.url;
  // This is a normal preview build through the API and the fake-agent's local sandbox.
  const built = await fetch(
    `${apiUrl}/api/projects/${projectId}/apps/${APP_NAME}/builds`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "preview" }),
    },
  );
  if (built.status !== 201)
    throw new Error(
      `Could not build security fixture: ${built.status} ${await built.text()}`,
    );
  const version = z
    .object({ status: z.string(), error: z.string().nullable().optional() })
    .parse(await built.json());
  if (version.status !== "ready")
    throw new Error(
      `Security fixture build failed: ${version.error ?? version.status}`,
    );
  sourceUrl = `${apiUrl}/api/projects/${projectId}/apps/${APP_NAME}/guest?channel=dev`;
  await handle.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(projectId)}})`,
  );
  await handle.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(projectId)}`,
  );
  await handle.waitFor("!!document.querySelector('[data-workspace-ready]')");
  fixtureServer = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/echo") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          token: request.headers["x-work-desktop-token"] ?? null,
        }),
      );
    } else
      response.end(
        "<!doctype html><title>Untrusted local page</title><p>Local attacker fixture</p>",
      );
  });
  await new Promise<void>((resolve) =>
    fixtureServer?.listen(0, "127.0.0.1", resolve),
  );
  const address = fixtureServer.address();
  if (!address || typeof address === "string")
    throw new Error("No attacker fixture port");
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async (context) => {
  for (const frame of frames) frame.close();
  frames.clear();
  if (context.task.result?.state === "fail" && app) {
    const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? directory;
    await app
      .screenshot(path.join(artifacts, "electron-security-failure.png"))
      .catch(() => {});
    console.error(app.getOutput());
  }
});
afterAll(async () => {
  await app?.stop({ preserveUserData: true });
  app = undefined;
  await new Promise<void>((resolve, reject) => {
    if (!fixtureServer) return resolve();
    fixtureServer.close((error) => (error ? reject(error) : resolve()));
  });
  if (directory) removeE2eDirectory(directory);
});

it("boots the internal shell with its isolated bridge, no renderer Node, and a working API", async () => {
  const state = await running().eval(`(async () => {
    const server = await window.catamorphicDesktop.getServerState();
    const response = await fetch(server.url + '/api/projects');
    const data = await response.json();
    return { protocol:location.protocol, host:location.host, path:location.pathname,
      node:typeof require, process:typeof process, module:typeof module,
      bridge:typeof window.catamorphicDesktop.getServerState, serverKeys:Object.keys(server),
      status:response.status, found:data.items.some(project => project.id === ${JSON.stringify(projectId)}) };
  })()`);
  expect(state).toEqual({
    protocol: "work-internal:",
    host: "shell",
    path: "/index.html",
    node: "undefined",
    process: "undefined",
    module: "undefined",
    bridge: "function",
    serverKeys: ["url", "hasCodingAgent"],
    status: 200,
    found: true,
  });
});

it("starts internal-origin storage separately from old file-origin drafts and settings", async () => {
  expect(await storedValues()).toEqual(
    Object.fromEntries(Object.keys(LEGACY_VALUES).map((key) => [key, null])),
  );
  expect(
    await running().eval("localStorage.getItem('__work_origin_migrated_v1')"),
  ).toBeNull();
});

it("admits only exact guest-document API paths from the native shell", async () => {
  const result = await running().eval<{
    granted: string;
    rejected: boolean[];
  }>(`(async () => {
    const api = window.catamorphicDesktop;
    const targets = ${JSON.stringify([
      `${apiUrl}/api/projects`,
      `${apiUrl}/api/projects/${projectId}/files/private`,
      `${apiUrl}/api/projects/${projectId}/apps/${APP_NAME}/guest/extra`,
      `${apiUrl}/api/projects/${projectId}/apps/${APP_NAME}/presentation`,
      `${fixtureUrl}/api/projects/${projectId}/apps/${APP_NAME}/guest`,
      `work-internal://shell/index.html`,
    ])};
    const rejected = [];
    for (const url of targets) {
      try { await api.appGuestDocument({mountId:'test-mount',url}); rejected.push(false); }
      catch { rejected.push(true); }
    }
    const granted = await api.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(sourceUrl)}});
    return {granted, rejected};
  })()`);
  expect(result.granted).toMatch(/^work-guest:\/\/p-[a-f0-9-]+\/document$/);
  expect(result.rejected).toEqual([true, true, true, true, true, true]);
  await running().eval(
    `window.catamorphicDesktop.appGuestClose({url:${JSON.stringify(result.granted)}})`,
  );
  const reopened = await running().eval<string>(
    `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(sourceUrl)}})`,
  );
  expect(reopened).not.toBe(result.granted);
  await running().eval(
    `window.catamorphicDesktop.appGuestClose({url:${JSON.stringify(reopened)}})`,
  );
});

it("renders an interactive project app without exposing the shell bridge or broad API", async () => {
  const handle = running();
  await addSidebarSections(handle, [{ id: "apps", source: "work:apps" }]);
  await handle.reload();
  await handle.waitFor(
    `document.querySelector('[data-workspace-visible="true"][data-project-runtime="${projectId}"] [data-workspace-ready]') !== null`,
  );
  await handle.eval(
    `document.querySelector('[data-workspace-visible="true"] button[aria-label="Expand sidebar"]')?.click(); true`,
  );
  await handle.waitFor(
    `(() => { const button = [...document.querySelectorAll('[data-workspace-visible="true"] [data-sidebar-widget="apps"] button')].find(button => button.textContent.includes(${JSON.stringify(APP_NAME)})); if (!button?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; button.click(); return true; })()`,
    { label: "open security app from its real sidebar" },
  );
  const guestUrl = await handle.waitFor<string>(
    `document.querySelector('iframe[src^="work-guest:"]')?.getAttribute('src')`,
    { label: "native guest document mounted" },
  );
  const guest = await handle.connectToFrame(guestUrl);
  frames.add(guest);
  await guest.waitFor("!!document.querySelector('#probe-button')", {
    label: "security probe rendered",
  });
  expect(
    await guest.eval(`(async () => {
    let parentBridge = false;
    try { parentBridge = !!parent.catamorphicDesktop; } catch {}
    let apiStatus = 'blocked';
    try { apiStatus = (await fetch(${JSON.stringify(`${apiUrl}/api/projects`)})).status; } catch {}
    return { bridge:typeof window.catamorphicDesktop, node:typeof require,
      nodeVersion:typeof process?.versions?.node, nativeBinding:typeof process?.binding,
      parentBridge, apiStatus };
  })()`),
  ).toEqual({
    bridge: "undefined",
    node: "undefined",
    nodeVersion: "undefined",
    nativeBinding: "undefined",
    parentBridge: false,
    apiStatus: "blocked",
  });
  // The app remains useful inside that boundary, driven by the OS pointer.
  const point = await guest.eval<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('#probe-button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
  const offset = await handle.eval<{ x: number; y: number }>(
    `(() => { const r=document.querySelector('iframe[src^="work-guest:"]').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
  );
  await handle.clickPointer({
    x: point.x + offset.x,
    y: point.y + offset.y,
  });
  await guest.waitFor(
    "document.querySelector('#probe-result')?.textContent === 'The isolated app is interactive'",
  );
  expect(
    await guest.eval(
      "(() => {const {clicks,trusted}=document.querySelector('#probe-result').dataset;return {clicks,trusted};})()",
    ),
  ).toEqual({ clicks: "1", trusted: "true" });
  const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? directory;
  await handle.screenshot(path.join(artifacts, "electron-security-app.png"));
});

it("refuses broad API and native bridge access from an ordinary hostile subframe", async () => {
  const handle = running();
  // Exercise native admission independently of the shell's additional frame-src CSP.
  await handle.cdp("Page.setBypassCSP", { enabled: true });
  await handle.reload();
  try {
    await handle.eval(
      `(() => { const frame=document.createElement('iframe'); frame.id='security-attacker'; frame.src=${JSON.stringify(`${fixtureUrl}/attacker`)}; document.body.append(frame); return true; })()`,
    );
    const attacker = await handle.connectToFrame(`${fixtureUrl}/attacker`);
    frames.add(attacker);
    const result = await attacker.eval<{
      bridge: string;
      node: string;
      parentBridge: boolean;
      status: number | string;
      echoed: unknown;
    }>(`(async () => {
      let parentBridge=false;
      try { parentBridge=!!parent.catamorphicDesktop; } catch {}
      let status='blocked';
      try { status=(await fetch(${JSON.stringify(`${apiUrl}/api/projects`)})).status; } catch {}
      return {bridge:typeof window.catamorphicDesktop,node:typeof require,parentBridge,status,
        echoed:await fetch('/echo').then(response=>response.json())};
    })()`);
    expect(result.bridge).toBe("undefined");
    expect(result.node).toBe("undefined");
    expect(result.parentBridge).toBe(false);
    expect([403, "blocked"]).toContain(result.status);
    expect(result.echoed).toEqual({ token: null });
  } finally {
    await handle.eval(
      "document.querySelector('#security-attacker')?.remove(); true",
    );
    await handle.cdp("Page.setBypassCSP", { enabled: false });
    await handle.reload();
  }
});

it("revokes document grants when their shell owner reloads or switches profile", async () => {
  const handle = running();
  const grant = await handle.eval<string>(
    `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(`${sourceUrl}&theme=owner-reload`)}})`,
  );
  await handle.eval(`window.securityBeforeReload = true;
    setTimeout(() => location.reload(), 0); true;`);
  await handle.waitFor(
    `!window.securityBeforeReload && window.catamorphicDesktop?.getServerState().then(state => !!state.url)`,
    { label: "ordinary shell reload completes" },
  );
  const reloaded = await handle.eval<string>(
    `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(`${sourceUrl}&theme=owner-reload`)}})`,
  );
  expect(reloaded).not.toBe(grant);
  const next = await handle.eval<string>(
    `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(sourceUrl)}})`,
  );
  const other = await handle.eval<{ id: string }>(
    "window.catamorphicDesktop.profilesCreate('Other security profile')",
  );
  try {
    await handle.eval(
      `window.catamorphicDesktop.windowSetProfile(${JSON.stringify(other.id)})`,
    );
    expect(
      await handle.eval(
        `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(sourceUrl)}}).then(()=>false,()=>true)`,
      ),
    ).toBe(true);
  } finally {
    await handle.eval(
      `window.catamorphicDesktop.windowSetProfile(${JSON.stringify(profileId)})`,
    );
  }
  const restored = await handle.eval<string>(
    `window.catamorphicDesktop.appGuestDocument({mountId:'test-mount',url:${JSON.stringify(sourceUrl)}})`,
  );
  expect(restored).not.toBe(next);
});

it("keeps shell navigation inside Work and opens requested web pages as browser content", async () => {
  const handle = running();
  const before = await handle.eval<string>("location.href");
  const target = `${fixtureUrl}/navigation-target`;
  await handle.eval(`(() => {
    window.__securityNavigation = null;
    window.__stopSecurityNavigation = window.catamorphicDesktop.onBrowserOpenUrl(url => {window.__securityNavigation=url});
    location.assign(${JSON.stringify(target)});
    return true;
  })()`);
  await handle.waitFor(
    `window.__securityNavigation === ${JSON.stringify(target)}`,
    { label: "native shell navigation redirected into browser content" },
  );
  expect(await handle.eval("location.href")).toBe(before);
  expect(
    await handle.eval("typeof window.catamorphicDesktop.getServerState"),
  ).toBe("function");
  await handle.eval("window.__stopSecurityNavigation(); true");
});

it("preserves unsent review drafts and sidebar edits after restart without altering the legacy source", async () => {
  const handle = running();
  await handle.eval(
    `(() => { for (const [key,value] of Object.entries(${JSON.stringify(UPDATED_VALUES)})) localStorage.setItem(key,value); return true; })()`,
  );
  await handle.stop({ preserveUserData: true });
  app = undefined;
  expect(await legacyStorage()).toEqual({
    ...LEGACY_VALUES,
    __work_origin_migrated_v1: null,
  });
  app = await launchApp({ userDataDir, sandboxedRenderers: true });
  expect(await storedValues()).toEqual(UPDATED_VALUES);
});

it("keeps newer internal-origin drafts on a later restart", async () => {
  const second = running();
  await second.stop({ preserveUserData: true });
  app = undefined;
  app = await launchApp({ userDataDir, sandboxedRenderers: true });
  expect(await storedValues()).toEqual(UPDATED_VALUES);
});

it("keeps Settings available when a saved key cannot unlock and replaces it without decrypting the old key", async () => {
  const handle = running();
  const name = "Synthetic key recovery";
  const syntheticKey = "e2e-synthetic-key-never-a-provider-credential";
  const replacementKey = "e2e-replacement-key-never-a-provider-credential";
  const agent = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.agentsCreate(${JSON.stringify({ name, harness: "ai-sdk", provider: "openai", auth: "api-key", apiKey: syntheticKey, model: "fake-model-a", effort: "low" })})`,
  );
  await handle.stop({ preserveUserData: true });
  app = undefined;
  const file = path.join(userDataDir, "profiles", profileId, "agents.json");
  const schema = z
    .object({
      agents: z.array(
        z
          .object({ id: z.string(), apiKeyEncrypted: z.string().optional() })
          .passthrough(),
      ),
    })
    .passthrough();
  const stored = schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const fixture = stored.agents.find((entry) => entry.id === agent.id);
  if (!fixture?.apiKeyEncrypted)
    throw new Error("The synthetic test key was not encrypted");
  expect(fs.readFileSync(file, "utf8")).not.toContain(syntheticKey);
  const corrupt = Buffer.from(
    "synthetic invalid OS credential ciphertext",
  ).toString("base64");
  fixture.apiKeyEncrypted = corrupt;
  fs.writeFileSync(file, JSON.stringify(stored));

  app = await launchApp({ userDataDir, sandboxedRenderers: true });
  const recovered = running();
  const roster = await recovered.eval<{
    agents: Array<{
      id: string;
      name: string;
      hasApiKey: boolean;
      credentialError?: string;
    }>;
  }>("window.catamorphicDesktop.agentsList()");
  const broken = roster.agents.find((entry) => entry.id === agent.id);
  expect(broken?.name).toBe(name);
  expect(broken?.hasApiKey).toBe(true);
  expect(broken?.credentialError).toContain("could not unlock");
  expect(broken?.credentialError).toContain("Settings");
  // This route reads the actual sealed key before the E2E model-list stub.
  // A corrupt key must never be silently replaced with missing credentials.
  const denied = await recovered.eval<{ models: unknown[]; error?: string }>(
    `window.catamorphicDesktop.agentModels(${JSON.stringify(agent.id)})`,
  );
  expect(denied.models).toEqual([]);
  expect(denied.error).toContain("could not unlock");

  await recovered.waitFor(
    "!!document.querySelector('[aria-label=\"Settings\"]')",
  );
  await recovered.eval(
    "document.querySelector('[aria-label=\"Settings\"]').click(); true",
  );
  await recovered.waitFor(
    "!!document.querySelector('nav[aria-label=\"Settings categories\"]')",
  );
  await recovered.eval(
    "[...document.querySelectorAll('nav[aria-label=\"Settings categories\"] button')].find(button=>button.textContent.trim()==='Agents').click(); true",
  );
  await recovered.waitFor(
    `!!document.querySelector('[aria-label="Edit ${name}"]') && [...document.querySelectorAll('[role="alert"]')].some(alert=>alert.textContent.includes('could not unlock'))`,
    { label: "Settings retains the locked agent and recovery guidance" },
  );
  const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? directory;
  await recovered.screenshot(
    path.join(artifacts, "electron-security-credential-error.png"),
  );
  await recovered.eval(
    `document.querySelector('[aria-label="Edit ${name}"]').click(); true`,
  );
  await recovered.waitFor(
    "!!document.querySelector('[data-testid=\"configure-agent-modal\"]')",
  );
  await recovered.eval(
    "document.querySelector('[data-testid=\"agent-tab-auth\"]').click(); true",
  );
  await recovered.waitFor(
    '!!document.querySelector(\'[data-testid="configure-agent-modal"] input[type="password"]\')',
  );
  await recovered.waitFor(
    `(() => {
    const dialog=document.querySelector('[data-testid="configure-agent-modal"]')?.closest('[role="dialog"]');
    const container=dialog?.parentElement;
    return !!container && getComputedStyle(container).opacity==='1' && getComputedStyle(dialog).opacity==='1' &&
      !container.getAnimations({subtree:true}).some(animation=>animation.playState==='running');
  })()`,
    { label: "credential repair dialog finished opening and changing tabs" },
  );
  await recovered.screenshot(
    path.join(artifacts, "electron-security-credential-repair.png"),
  );
  await recovered.eval(
    'document.querySelector(\'[data-testid="configure-agent-modal"] input[type="password"]\').focus(); true',
  );
  await recovered.insertText(replacementKey);
  await recovered.waitFor(
    `document.querySelector('[data-testid="configure-agent-modal"] input[type="password"]').value === ${JSON.stringify(replacementKey)}`,
  );
  await recovered.press("Enter");
  await recovered.waitFor(
    "!document.querySelector('[data-testid=\"configure-agent-modal\"]')",
    { label: "replacement key saved through Settings" },
  );
  await recovered.waitFor(
    `window.catamorphicDesktop.agentsList().then(roster=>{const agent=roster.agents.find(entry=>entry.id===${JSON.stringify(agent.id)});return agent?.hasApiKey && !agent.credentialError})`,
    { label: "credential error cleared after replacing the key" },
  );
  const models = await recovered.eval<{ models: unknown[]; error?: string }>(
    `window.catamorphicDesktop.agentModels(${JSON.stringify(agent.id)})`,
  );
  expect(models.error).toBeUndefined();
  expect(models.models.length).toBeGreaterThan(0);
  const savedText = fs.readFileSync(file, "utf8");
  expect(savedText).not.toContain(syntheticKey);
  expect(savedText).not.toContain(replacementKey);
  const repaired = schema
    .parse(JSON.parse(savedText))
    .agents.find((entry) => entry.id === agent.id);
  expect(repaired?.apiKeyEncrypted).toBeTruthy();
  expect(repaired?.apiKeyEncrypted).not.toBe(corrupt);
});

it("can reconnect an OpenRouter account without unlocking its old key", async () => {
  const handle = running();
  const agent = await handle.eval<{ id: string }>(
    `window.catamorphicDesktop.agentsCreate(${JSON.stringify({ name: "Synthetic account recovery", harness: "ai-sdk", provider: "openrouter", auth: "account", apiKey: "e2e-synthetic-account-key", model: "fake-model-a" })})`,
  );
  await handle.stop({ preserveUserData: true });
  app = undefined;
  const file = path.join(userDataDir, "profiles", profileId, "agents.json");
  const stored = z
    .object({ agents: z.array(z.object({ id: z.string() }).passthrough()) })
    .passthrough()
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const fixture = stored.agents.find((entry) => entry.id === agent.id);
  if (!fixture) throw new Error("The synthetic account was not saved");
  fixture.apiKeyEncrypted = Buffer.from(
    "invalid synthetic account key",
  ).toString("base64");
  fs.writeFileSync(file, JSON.stringify(stored));
  app = await launchApp({ userDataDir, sandboxedRenderers: true });
  const recovered = running();
  expect(
    await recovered.eval(
      `window.catamorphicDesktop.agentLoginStatus(${JSON.stringify(agent.id)})`,
    ),
  ).toBe(false);
  expect(
    await recovered.eval(
      `window.catamorphicDesktop.agentAuthHealth(${JSON.stringify(agent.id)})`,
    ),
  ).toEqual({ health: "missing", reauth: true });
  // The existing fake sign-in replaces the key just as PKCE completion does.
  // Its start must depend on account metadata, never on the sealed old key.
  expect(
    await recovered.eval(
      `window.catamorphicDesktop.agentLogin(${JSON.stringify(agent.id)})`,
    ),
  ).toEqual({ started: true });
  await recovered.waitFor(
    `window.catamorphicDesktop.agentsList().then(roster=>!roster.agents.find(agent=>agent.id===${JSON.stringify(agent.id)})?.credentialError)`,
    { label: "OpenRouter sign-in replaced the unreadable key" },
  );
  expect(
    await recovered.eval(
      `window.catamorphicDesktop.agentLoginStatus(${JSON.stringify(agent.id)})`,
    ),
  ).toBe(true);
});

it("renders a scoped project PDF in Chromium's actual PDF viewer", async () => {
  const handle = running();
  const filePath = "security-proof.pdf";
  const stream = "BT /F1 20 Tf 30 110 Td (Scoped PDF renderer proof) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(
    path.join(directory, "security-project", filePath),
    pdf,
    "ascii",
  );
  const documentUrl = await handle.eval<string>(
    `window.catamorphicDesktop.pdfGuestDocument(${JSON.stringify({ projectId, filePath })})`,
  );
  expect(documentUrl).toMatch(/^work-guest:\/\/pdf-[a-f0-9-]+\/document$/);
  const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? directory;
  try {
    // Exercise the editor's public document capability and iframe contract.
    // A normal file: link opens PDF files as browser tabs instead.
    await handle.eval(`(() => {
      const frame=document.createElement('iframe');frame.id='security-pdf-renderer';
      frame.title=${JSON.stringify(filePath)};frame.src=${JSON.stringify(documentUrl)};
      frame.style.cssText='position:fixed;left:260px;top:40px;width:calc(100% - 260px);height:calc(100% - 40px);border:0;z-index:30';
      document.body.append(frame);return true;
    })()`);
    await expect
      .poll(
        async () => {
          const targets = z
            .object({
              targetInfos: z.array(
                z.object({ type: z.string(), url: z.string() }),
              ),
            })
            .parse(await handle.cdp("Target.getTargets"));
          return targets.targetInfos.some(
            (target) =>
              target.type === "iframe" &&
              target.url.startsWith("chrome-extension://"),
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const viewer = await handle.connectToFrame("chrome-extension://");
    frames.add(viewer);
    await viewer.waitFor(
      `(() => {
    const root=document.querySelector('pdf-viewer')?.shadowRoot;
    const toolbar=root?.querySelector('viewer-toolbar');
    return toolbar?.docLength===1;
  })()`,
      { label: "Chromium PDF viewer decoded the one-page project document" },
    );
    expect(await viewer.eval("typeof window.catamorphicDesktop")).toBe(
      "undefined",
    );
    await handle.screenshot(path.join(artifacts, "electron-security-pdf.png"));
  } catch (cause) {
    await handle.screenshot(
      path.join(artifacts, "electron-security-pdf-failure.png"),
    );
    throw cause;
  } finally {
    await handle.eval(
      "document.querySelector('#security-pdf-renderer')?.remove();true",
    );
    await handle.eval(
      `window.catamorphicDesktop.appGuestClose({url:${JSON.stringify(documentUrl)}})`,
    );
  }
});
