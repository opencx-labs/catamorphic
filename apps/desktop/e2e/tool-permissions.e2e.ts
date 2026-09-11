import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/** Session consent is a durable question. Navigation and reload must preserve it. */

let app: AppHandle;
let projectId: string;

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
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
  const composer = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'))
      ?.querySelector('[data-composer-input]');
  const send = (text) => { const ta = composer(); setReactValue(ta, text); ta.closest('form').requestSubmit(); };
  const timeline = () => $$('[role="log"]').map((el) => el.textContent).join('\\n');
  const modal = () => $('section[aria-label="The agent has a question"]');
  const answer = label => { byText('section[aria-label="The agent has a question"] button', label).click(); };
  const submitAnswer = () => byText('section[aria-label="The agent has a question"] button', 'Submit').click();
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
    projectId = await app.eval<string>(
      `(async()=>{ const {url}=await window.catamorphicDesktop.getServerState(); const projects=await fetch(url+'/api/projects').then(r=>r.json()); return projects.items.find(p=>p.name==='perm-e2e').id; })()`,
    );
    await app.eval(
      `window.catamorphicDesktop.connectionsCreate({ name: 'fake', transport: 'http', url: 'http://127.0.0.1:1/mcp' })`,
    );
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!composer();`, { label: "floating chat" });
  }, 180_000);

  it("an approval survives tab switches and renderer reload; Always allow writes the rule", async () => {
    await run(`send('permission: fake/post_message'); return true;`);
    await runWait(
      `const m = modal(); return !!m && m.textContent.includes('post message') && m.textContent.includes('fake');`,
      { timeoutMs: 30_000, label: "consent modal" },
    );
    expect(
      await run(`return !!$('[data-testid="tool-permission-modal"]');`),
    ).toBe(false);
    await run(`$('[aria-label="Open as tab"]').click(); return true;`);
    await runWait(`return !!$('[data-point-key^="chat:"]');`);
    const chatKey = await run<string>(
      `return $('[data-point-key^="chat:"]').dataset.pointKey;`,
    );
    await run(
      `byText('[data-point-key] button', 'New Tab').click(); return true;`,
    );
    await run(
      `$('[data-point-key="'+${JSON.stringify(chatKey)}+'"]').querySelector('button').click(); return true;`,
    );
    await runWait(`return !!modal();`);
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(projectId)}).then(state => state?.chats?.some(chat => 'chat:'+chat.localId===${JSON.stringify(chatKey)} && chat.mode==='tab'))`,
      { label: "chat tab persisted before reload" },
    );
    await app.eval("location.reload()");
    await runWait(
      `return !!modal() && modal().textContent.includes('post message');`,
      { timeoutMs: 60000, label: "pending consent restored" },
    );
    await runWait(
      `return !!$('[data-point-key="'+${JSON.stringify(chatKey)}+'"]');`,
      { label: "chat tab restored" },
    );
    await app.eval(`window.catamorphicDesktop.devWindow('setSize',1300,1000)`);
    await app.waitFor(
      `!document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)`,
    );
    expect(
      await run(
        `return $('[data-point-key="'+${JSON.stringify(chatKey)}+'"]').querySelectorAll('.animate-spin').length;`,
      ),
    ).toBe(0);
    expect(
      await run(
        `return $('[data-testid="session-inspector-trigger"]').getAttribute('aria-label');`,
      ),
    ).toContain("Waiting for your answer");
    expect(
      await run(
        `return !!$('[data-testid="session-inspector-trigger"] .animate-spin');`,
      ),
    ).toBe(false);
    await app.screenshot("/tmp/catamorphic-durable-consent.png");
    await run(`answer('Always allow'); return true;`);
    await runWait(
      `const button = byText('section[aria-label="The agent has a question"] button', 'Submit'); return !!button && !button.disabled;`,
    );
    await run(`submitAnswer(); return true;`);
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

  it("another client answers the durable question; the originating chat resumes", async () => {
    await run(`send('permission: fake/upload_file'); return true;`);
    await runWait(
      `return !!modal() && modal().textContent.includes('upload file');`,
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
              "/agent/sessions/" + session.id;
            const pending = await fetch(url).then(r => r.ok ? r.json() : { questions: [] });
            const ask = pending.questions?.find(p => p.questions?.[0]?.question.includes("upload file"));
            if (!ask) continue;
            const posted = await fetch(url + "/questions/" + encodeURIComponent(ask.requestId) + "/answer", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ answer: "Allow once" }),
            });
            return { ok: posted.ok, detail: "answered " + ask.requestId };
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
      `return !!modal() && modal().textContent.includes('delete channel');`,
      {
        timeoutMs: 30_000,
        label: "second consent modal",
      },
    );
    await run(`answer('Deny'); return true;`);
    await runWait(
      `const button = byText('section[aria-label="The agent has a question"] button', 'Submit'); return !!button && !button.disabled;`,
    );
    await run(`submitAnswer(); return true;`);
    await runWait(
      `return !modal() && timeline().includes('permission decision: deny');`,
      {
        timeoutMs: 30_000,
        label: "agent got deny",
      },
    );
  }, 60_000);
});

it("queues concurrent native elicitation requests and settles each independently", async () => {
  await run(`send('elicitation: queue');`);
  await runWait(
    `return $('[data-testid="elicitation-modal"]')?.textContent.includes('First app');`,
  );
  await app.screenshot("/tmp/codex-elicitation.png");
  await run(`$('[data-testid="elicitation-modal"] form').requestSubmit();`);
  await runWait(
    `return $('[data-testid="elicitation-modal"]')?.textContent.includes('Second app');`,
  );
  await run(
    `byText('[data-testid="elicitation-modal"] button','Cancel').click();`,
  );
  await runWait(
    `return timeline().includes('elicitation decisions: accept,decline');`,
  );
  expect(await run(`return !!$('[data-testid="elicitation-modal"]');`)).toBe(
    false,
  );
});
it("withdraws native elicitation on cancellation", async () => {
  await run(`send('elicitation: cancel');`);
  await runWait(`return !!$('[data-testid="elicitation-modal"]');`);
  await runWait(
    `return !$('[data-testid="elicitation-modal"]') && timeline().includes('elicitation decisions: decline');`,
  );
});

it("remembers native app consent only after an explicit chat-scoped answer", async () => {
  await run(`send('elicitation: app'); return true;`);
  await runWait(`return modal()?.textContent.includes('Allow for this chat');`);
  expect(await run(`return !!$('[data-testid="elicitation-modal"]');`)).toBe(
    false,
  );
  await run(`answer('Allow for this chat'); return true;`);
  await runWait(
    `const button = byText('section[aria-label="The agent has a question"] button', 'Submit'); return !!button && !button.disabled;`,
  );
  await run(`submitAnswer(); return true;`);
  await runWait(
    `return timeline().includes('app consent: accept,accept') && !modal();`,
  );
});

// This scenario captures the question panel, so it belongs in the visible suite.
it("keeps working while questions are collapsed and consumes the answer in the same turn", async () => {
  await run(`pressKey('n', { metaKey: true }); return true;`);
  await runWait(`return !!$('[data-floating-chat] [data-composer-input]');`);
  await run(`
    const input = $('[data-floating-chat] [data-composer-input]');
    setReactValue(input, 'ask a nonblocking question and keep working');
    input.closest('form').requestSubmit(); return true;
  `);
  await runWait(
    `return !!modal() && timeline().includes('continuing independent work');`,
  );
  await app.waitFor(
    `!document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)`,
  );
  await app.screenshot("/tmp/catamorphic-nonblocking-question.png");
  await run(`$('button[aria-label="Answer later"]').click(); return true;`);
  await runWait(`return !modal() && !!byText('button', 'Answer when ready');`);
  await run(`byText('button', 'Answer when ready').click(); return true;`);
  await runWait(`return !!modal();`);
  await run(`answer('Orange'); return true;`);
  await runWait(
    `const submit = byText('section[aria-label="The agent has a question"] button', 'Submit'); if (!submit || submit.disabled) return false; submit.click(); return true;`,
  );
  await runWait(
    `return [...document.querySelectorAll('[role="log"] article')].some(m => m.textContent.includes('Answer received during the same turn') && m.textContent.includes('Orange')) && !modal();`,
    { timeoutMs: 30_000 },
  );
});
