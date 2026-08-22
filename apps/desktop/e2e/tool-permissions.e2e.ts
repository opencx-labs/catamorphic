import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Tool permissions end to end: an agent reaching for an MCP tool whose
 * policy says "ask" raises the consent modal in the front window; "Always
 * allow" answers the call AND writes an allow rule onto the connection's
 * policy (visible in the connectors modal's Permissions editor); Deny
 * answers deny. Driven through the e2e fake agent's "permission:" prompt,
 * which calls the real host prompt (bridge → renderer → modal).
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
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
  const composer = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'))
      ?.querySelector('[data-composer-input]');
  const send = (text) => { const ta = composer(); setReactValue(ta, text); ta.closest('form').requestSubmit(); };
  const timeline = () => $$('[role="log"]').map((el) => el.textContent).join('\\n');
  const modal = () => $('[data-testid="tool-permission-modal"]');
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("tool permissions", () => {
  it("boots, creates a project, a 'fake' connection, and a chat", async () => {
    await run(`window.focus(); return true;`);
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'perm-e2e'); return true;`,
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
    await app.eval(
      `window.catamorphicDesktop.connectionsCreate({ name: 'fake', transport: 'http', url: 'http://127.0.0.1:1/mcp' })`,
    );
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "floating chat" });
  }, 180_000);

  it("an 'ask' tool raises the consent modal; Always allow answers and writes the rule", async () => {
    await run(`send('permission: fake/post_message'); return true;`);
    await runWait(
      `const m = modal(); return !!m && m.textContent.includes('post_message') && m.textContent.includes('fake');`,
      { timeoutMs: 30_000, label: "consent modal" },
    );
    await run(
      `modal().querySelector('button[aria-expanded]').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="tool-permission-args"]');`, {
      label: "arguments shown",
    });
    await run(
      `$('[data-testid="tool-permission-always"]').click(); return true;`,
    );
    await runWait(
      `return timeline().includes('permission decision: allow (always)');`,
      {
        timeoutMs: 30_000,
        label: "agent got allow (always)",
      },
    );
    const connections = await app.eval<
      Array<{ name: string; toolPolicy?: { tools?: Record<string, string> } }>
    >(`window.catamorphicDesktop.connectionsList()`);
    expect(
      connections.find((c) => c.name === "fake")?.toolPolicy?.tools,
    ).toEqual({ post_message: "allow" });
  }, 60_000);

  it("a remote client answers over HTTP; the modal withdraws", async () => {
    await run(`send('permission: fake/upload_file'); return true;`);
    await runWait(
      `return !!modal() && modal().textContent.includes('upload_file');`,
      { timeoutMs: 30_000, label: "third consent modal" },
    );
    // Act as the companion app: find the pending ask through the embedded
    // server's permissions route and allow it. The broker races the modal,
    // so the answer must both unblock the tool call AND withdraw the card.
    const answered = await app.eval<{ ok: boolean; detail: string }>(`
      (async () => {
        const state = await window.catamorphicDesktop.getServerState();
        const base = state.url + "/api";
        const projects = await fetch(base + "/projects").then(r => r.json());
        for (const project of projects.items) {
          const sessions = await fetch(
            base + "/projects/" + project.id + "/agent/sessions",
          ).then(r => r.json());
          for (const session of sessions.items) {
            const url = base + "/projects/" + project.id +
              "/agent/sessions/" + session.id + "/permissions";
            const pending = await fetch(url).then(r => r.ok ? r.json() : { permissions: [] });
            const ask = pending.permissions.find(p => p.request.tool === "upload_file");
            if (!ask) continue;
            const posted = await fetch(url + "/" + ask.id, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ decision: "allow" }),
            });
            return { ok: posted.ok, detail: "answered " + ask.id };
          }
        }
        return { ok: false, detail: "no pending ask found over HTTP" };
      })()
    `);
    expect(answered).toMatchObject({ ok: true });
    await runWait(
      `return !modal() && timeline().includes('permission decision: allow');`,
      { timeoutMs: 30_000, label: "modal withdrawn, agent got allow" },
    );
  }, 60_000);

  it("Deny answers deny; the modal closes", async () => {
    await run(`send('permission: fake/delete_channel'); return true;`);
    await runWait(
      `return !!modal() && modal().textContent.includes('delete_channel');`,
      {
        timeoutMs: 30_000,
        label: "second consent modal",
      },
    );
    await run(
      `$('[data-testid="tool-permission-deny"]').click(); return true;`,
    );
    await runWait(
      `return !modal() && timeline().includes('permission decision: deny');`,
      {
        timeoutMs: 30_000,
        label: "agent got deny",
      },
    );
  }, 60_000);
});
