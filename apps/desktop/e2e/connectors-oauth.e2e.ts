import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * OAuth for a remote connection, end to end inside the app: a connection
 * whose server answers 401 shows "Needs authorization" + Authorize on
 * Test; Authorize steps the modal aside, opens the consent page as a
 * browser tab, the loopback callback lands the tokens, the tab closes,
 * the modal returns and the probe reports tools. The server is the fake
 * from packages/mcp (instant consent), spawned as a sidecar.
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
      () => reject(new Error("fake OAuth server did not start")),
      30_000,
    );
    fake.stdout?.on("data", (chunk: Buffer) => {
      const match = /PORT (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    fake.once("exit", () => reject(new Error("fake OAuth server exited")));
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
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const modal = () => {
    const search = $('[data-testid="connectors-search"]');
    const dialog = search?.closest('[role="dialog"]');
    return dialog && !dialog.closest('[inert]') && !dialog.closest('[aria-hidden="true"]') ? dialog : null;
  };
  const row = () => modal()?.querySelector('[data-testid="connection-row"]');
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("connector OAuth", () => {
  it("boots, creates a project, and adds a connection to the protected server", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'oauth-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = byText('button', 'Create');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
    const created = await app.eval<{ id: string; authorized: boolean }>(
      `window.catamorphicDesktop.connectionsCreate({ name: 'Fake OAuth', transport: 'http', url: ${JSON.stringify(`${base}/mcp`)} })`,
    );
    expect(created.authorized).toBe(false);
  }, 180_000);

  it("Test on the connection reports it needs authorization and offers Authorize", async () => {
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      label: "palette",
    });
    await run(
      `setReactValue($('textarea[placeholder*="Search or ask"]'), 'manage connectors'); return true;`,
    );
    await runWait(
      `if (!byText('button', 'Manage connectors')) return false;
       $('textarea[placeholder*="Search or ask"]').dispatchEvent(
         new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
      { label: "run Manage connectors" },
    );
    await runWait(
      `return !!modal() && !!row() && row().textContent.includes('Fake OAuth');`,
      {
        timeoutMs: 30_000,
        label: "connectors modal with the connection",
      },
    );
    await run(
      `byText('[data-testid="connection-row"] button', 'Test').click(); return true;`,
    );
    await runWait(
      `return !!row() && row().textContent.includes('Needs authorization') &&
              !!row().querySelector('[data-testid="connection-authorize"]');`,
      { timeoutMs: 30_000, label: "needs authorization + Authorize" },
    );
  }, 60_000);

  it("Authorize opens the consent tab, lands tokens, closes the tab, and the probe finds tools", async () => {
    await run(
      `row().querySelector('[data-testid="connection-authorize"]').click(); return true;`,
    );
    // The modal steps aside, the consent page opens as a browser tab, the
    // fake consents instantly (302 to the loopback callback), the tab
    // closes and the modal returns — too fast to catch mid-flight on a
    // poll, so assert the resting state: tokens could only have landed
    // via that tab's navigation.
    await runWait(
      `return !!modal() && !$('input[aria-label="Address and search bar"]');`,
      {
        timeoutMs: 60_000,
        label: "callback served: tab closed, modal back",
      },
    );
    await runWait(`return !!row() && row().textContent.includes('1 tools');`, {
      timeoutMs: 30_000,
      label: "probe after auth reports tools",
    });
    const connections = await app.eval<
      Array<{ name: string; authorized: boolean }>
    >(`window.catamorphicDesktop.connectionsList()`);
    expect(connections.find((c) => c.name === "Fake OAuth")?.authorized).toBe(
      true,
    );
  }, 120_000);

  it("Permissions lists the probed tools and saves per-tool rules on the connection", async () => {
    await run(
      `row().querySelector('[data-testid="connection-permissions"]').click(); return true;`,
    );
    await runWait(
      `const item = row()?.querySelector('[data-testid="tool-policy-tools"] li[data-tool="hello"]');
       return !!item && item.dataset.effective === 'ask';`,
      { label: "hello tool listed, auto → ask (no annotations)" },
    );
    await app.screenshot(
      "/private/tmp/claude-501/-Users-tabaza-Desktop-catamorphic/415f6510-da48-4924-8082-6f94d52a0c92/scratchpad/tool-policy-editor.png",
    );
    // Turn it off.
    await run(`
      row().querySelector('[data-testid="tool-policy-tools"] li[data-tool="hello"] button[data-value="deny"]').click();
      return true;
    `);
    await runWait(
      `return row()?.querySelector('li[data-tool="hello"]')?.dataset.effective === 'deny';`,
      { label: "hello → off" },
    );
    let list = await app.eval<
      Array<{ name: string; toolPolicy?: { tools?: Record<string, string> } }>
    >(`window.catamorphicDesktop.connectionsList()`);
    expect(
      list.find((c) => c.name === "Fake OAuth")?.toolPolicy?.tools,
    ).toEqual({ hello: "deny" });
    // Back to default, then a connection-wide Allow default.
    await run(
      `row().querySelector('li[data-tool="hello"] button[data-value="default"]').click(); return true;`,
    );
    await run(
      `row().querySelector('[data-testid="tool-policy-default"] button[data-value="allow"]').click(); return true;`,
    );
    await runWait(
      `return row()?.querySelector('li[data-tool="hello"]')?.dataset.effective === 'allow';`,
      { label: "default allow → hello allowed" },
    );
    list = await app.eval(`window.catamorphicDesktop.connectionsList()`);
    expect(list.find((c) => c.name === "Fake OAuth")?.toolPolicy).toEqual({
      default: "allow",
    });
  });
});
