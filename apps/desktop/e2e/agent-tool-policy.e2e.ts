import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Agent-level tool access (ADR 0054): Settings → edit agent shows a row per
 * assigned connection (tools from the cached roster, each with the effective
 * answer after the connection's ceiling) plus "Project workflows"; the
 * agent can narrow (Ask/Off), never widen; Save persists `toolPolicies`.
 * The connection is the fake OAuth MCP sidecar (one tool, "hello").
 */

let app: AppHandle;
let fake: ChildProcess;
let base = "";

beforeAll(async () => {
  const script = path.resolve(
    import.meta.dirname,
    "../../../packages/mcp/src/__tests__/fake-oauth-server.ts",
  );
  fake = spawn("bun", [script], { stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fake server did not start")),
      30_000,
    );
    fake.stdout?.on("data", (chunk: Buffer) => {
      const match = /PORT (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    fake.once("exit", () => reject(new Error("fake server exited")));
  });
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fake?.kill("SIGTERM");
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const field = () => $('[data-testid="agent-tool-policy"]');
  const rowFor = (key) => field()?.querySelector('[data-testid="agent-policy-row"][data-key="' + key + '"]');
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
const SHOTS =
  "/private/tmp/claude-501/-Users-tabaza-Desktop-catamorphic/415f6510-da48-4924-8082-6f94d52a0c92/scratchpad";

let connectionId = "";

describe("agent tool access", () => {
  it("boots, creates a project, an authorized 'fake' connection with a probed roster", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'policy-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = byText('button', 'Create');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace",
    });
    // A connection with a bearer the fake accepts, so a probe lists tools.
    const created = await app.eval<{ id: string }>(
      `window.catamorphicDesktop.connectionsCreate({ name: 'fake', transport: 'http', url: ${JSON.stringify(`${base}/mcp`)}, headers: { Authorization: 'Bearer access-token-1' } })`,
    );
    connectionId = created.id;
    const probe = await app.eval<{ ok: boolean; toolCount?: number }>(
      `window.catamorphicDesktop.connectionsProbe(${JSON.stringify(connectionId)})`,
    );
    expect(probe.ok).toBe(true);
    expect(probe.toolCount).toBe(1);
  }, 180_000);

  it("Settings → edit agent shows Tool access with the connection's tools and Project workflows", async () => {
    await run(`byText('button', 'Settings').click(); return true;`);
    await runWait(`return !!$('[aria-label^="Edit "]');`, {
      timeoutMs: 30_000,
      label: "settings agents",
    });
    await run(`$('[aria-label^="Edit "]').click(); return true;`);
    await runWait(
      `return !!field() && !!rowFor(${JSON.stringify(connectionId)}) && !!rowFor('catamorphic');`,
      {
        timeoutMs: 30_000,
        label: "tool access field",
      },
    );
    // Expand the connection: "hello" (no annotations) → connection ceiling
    // is Ask (auto), so the effective answer reads Ask while inheriting.
    await run(
      `rowFor(${JSON.stringify(connectionId)}).querySelector('button[aria-expanded]').click(); return true;`,
    );
    await runWait(
      `const li = rowFor(${JSON.stringify(connectionId)})?.querySelector('li[data-tool="hello"]');
       return !!li && li.dataset.effective === 'ask';`,
      { label: "hello listed with effective Ask" },
    );
    await app.screenshot(`${SHOTS}/agent-tool-policy.png`);
    // Narrow it: Off. Effective → deny.
    await run(
      `rowFor(${JSON.stringify(connectionId)}).querySelector('li[data-tool="hello"] button[data-value="deny"]').click(); return true;`,
    );
    await runWait(
      `return rowFor(${JSON.stringify(connectionId)})?.querySelector('li[data-tool="hello"]')?.dataset.effective === 'deny' &&
              rowFor(${JSON.stringify(connectionId)}).textContent.includes('Narrowed');`,
      { label: "hello → Off, row narrowed" },
    );
    // Workflows: default Ask for this agent.
    await run(
      `rowFor('catamorphic').querySelector('[data-testid="agent-policy-default-catamorphic"] button[data-value="ask"]').click(); return true;`,
    );
    await runWait(
      `return $('[data-testid="agent-tool-policy-summary"]')?.textContent.includes('Narrowed on 2');`,
      {
        label: "summary counts two narrowed",
      },
    );
    // The e2e default agent is key-based with no key saved: Save wants one.
    await run(`
      const key = $('form input[type="password"], form input[placeholder*="sk-"]');
      if (key) setReactValue(key, 'sk-e2e-not-real');
      return true;
    `);
    await runWait(
      `const b = byText('form button[type="submit"]', 'Save'); return !!b && !b.disabled;`,
      { label: "save enabled" },
    );
    await run(
      `byText('form button[type="submit"]', 'Save').click(); return true;`,
    );
    await runWait(`return !field();`, {
      timeoutMs: 30_000,
      label: "form closed after save",
    });
    const agents = await app.eval<{
      agents: Array<{ toolPolicies: Record<string, unknown> }>;
    }>(`window.catamorphicDesktop.agentsList()`);
    const policies = agents.agents[0]?.toolPolicies;
    expect(policies?.[connectionId]).toEqual({ tools: { hello: "deny" } });
    expect(policies?.catamorphic).toEqual({ default: "ask" });
  }, 120_000);
});
