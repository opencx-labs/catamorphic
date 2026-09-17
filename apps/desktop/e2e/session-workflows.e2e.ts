import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
const helpers = `${setReactValueJs}; const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => !b.closest('[inert]') && b.textContent.trim() === text);`;
const run = <T>(body: string) =>
  app.eval<T>(`(async()=>{${helpers};${body}})()`);
const wait = (body: string) =>
  app.waitFor(`(()=>{${helpers};${body}})()`, { timeoutMs: 90000 });
async function send(scenario: string) {
  await wait(
    `return !!$('[data-chat-local-id] [data-composer-input]') && !$('[data-chat-local-id] [aria-label="Stop response"]');`,
  );
  await run(
    `const input=$('[data-chat-local-id] [data-composer-input]'); setReactValue(input, ${JSON.stringify(`session workflow ${scenario}`)}); input.closest('form').requestSubmit();`,
  );
}
beforeAll(async () => {
  app = await launchApp();
  await wait("return !!button('New project');");
  await run("button('New project').click();");
  await wait("return !!$('[data-testid=project-name-input]');");
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Session workflows');",
  );
  await wait("return !$('[data-testid=project-submit]').disabled;");
  await run("$('[data-testid=project-submit]').click();");
  await wait("return !!$('[aria-label=\"New chat\"]');");
  await run(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}));",
  );
});
afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

it("authors a temporary one-shot, wakes once, stops and links its retained source and run", async () => {
  await send("wake");
  await wait("return !!$('.cat-markdown a[href^=\"artifact:\"]');");
  await wait(
    "return document.body.textContent.includes('Scheduled follow-up received.') && document.body.textContent.includes('Stopped a watcher');",
  );
  expect(
    await run(
      "return document.querySelectorAll('[data-testid=session-attribution] a[href^=\"run:\"]').length;",
    ),
  ).toBe(2);
  await run(
    "document.querySelector('[data-testid=session-attribution] a[href^=\"run:\"]').click();",
  );
  await wait(
    "return !!$('[aria-label=\"Run of sessionwake\"]') && document.body.textContent.includes('Run history');",
  );
  await app.waitFor(
    `(async()=>{const {url}=await window.catamorphicDesktop.getServerState(); const {items}=await (await fetch(url+'/api/projects')).json(); const state=await window.catamorphicDesktop.workspaceStateGet(items.find(p=>p.name==='Session workflows').id); return state?.tabs?.some(tab=>tab.kind==='run');})()`,
  );
  await app.reload();
  await wait("return !!$('[aria-label=\"Run of sessionwake\"]');");
  await wait("return !!$('.cat-markdown a[href^=\"artifact:\"]');");
  await run(
    "document.querySelector('.cat-markdown a[href^=\"artifact:\"]').click();",
  );
  await wait(
    "return document.body.textContent.includes('.catamorphic/workflows/src/artifacts/');",
  );
  await app.screenshot("/tmp/catamorphic-session-wakeup.png");
});

it("remains quiet on ordinary turn completion and reacts to explicit work completion", async () => {
  await send("monitor");
  await wait(
    "return document.body.textContent.includes('Created') && !!button('sessionmonitor');",
  );
  expect(
    await run(
      "return document.body.textContent.includes('Work completion observed.');",
    ),
  ).toBe(false);
  await send("complete");
  await wait(
    "return document.body.textContent.includes('Work completion observed.');",
  );
  await wait(
    "return [...document.querySelectorAll('[data-testid=chat-watchers]')].some(el=>el.textContent.includes('sessionmonitor') && el.textContent.includes('stopped'));",
  );
  const delivered = await run<number>(
    "return [...document.querySelectorAll('[data-testid=session-attribution]')].filter(el=>el.parentElement.textContent.includes('Work completion observed.')).length;",
  );
  expect(delivered).toBe(1);
  await send("reopen");
  await wait("return document.body.textContent.includes('Reopened the work');");
  await app.screenshot("/tmp/catamorphic-session-monitor.png");
});

it("keeps quiet results inspectable and exposes failed runs with a working stop control", async () => {
  await send("quiet");
  await wait("return !!button('sessionquiet');");
  await wait(
    "return button('sessionquiet').parentElement.textContent.includes('Last run: completed');",
  );
  await send("failure");
  await wait("return !!button('sessionfailure');");
  await wait(
    "return button('sessionfailure').parentElement.textContent.includes('Last run: failed');",
  );
  await run(
    "[...button('sessionfailure').parentElement.querySelectorAll('button')].find(b=>b.textContent.includes('Last run')).click();",
  );
  await wait(
    "return !!$('[aria-label=\"Run of sessionfailure\"]') && document.body.textContent.includes('Controlled monitor failure');",
  );
  await run("$('[aria-label=\"Stop watcher sessionfailure\"]').click();");
  await wait(
    "return button('sessionfailure').parentElement.textContent.includes('stopped');",
  );
});

it("alerts once for a timer in the background and opens its exact message", async () => {
  await run(
    `window.__nativeNotification = window.Notification; window.__workflowNotifications = []; Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.Notification = class { static permission = 'granted'; constructor(title, options) { this.title = title; this.body = options.body; window.__workflowNotifications.push(this); } };`,
  );
  try {
    await send("reminder");
    await wait(
      `return window.__workflowNotifications.some(item => item.body === 'Reminder: submit the application.');`,
    );
    expect(
      await run(
        `return window.__workflowNotifications.filter(item => item.body === 'Reminder: submit the application.').length;`,
      ),
    ).toBe(1);
    await run(
      `delete document.hasFocus; window.__workflowNotifications.find(item => item.body === 'Reminder: submit the application.').onclick();`,
    );
    await wait(
      `return [...document.querySelectorAll('[data-message-id]')].some(item => item.className.includes('outline-accent') && item.textContent.includes('Reminder: submit the application.'));`,
    );
    expect(
      await run(
        `const item = [...document.querySelectorAll('[data-message-id]')].find(item => item.className.includes('outline-accent')); const bounds = item.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= window.innerHeight;`,
      ),
    ).toBe(true);
  } finally {
    await run(
      `delete document.hasFocus; window.Notification = window.__nativeNotification;`,
    );
  }
});

it("delivers an attention reminder without a model turn and shows late schedule context", async () => {
  await send("overdue");
  await wait(
    "return document.body.textContent.includes('Reminder: submit the application.') && document.body.textContent.includes('Delivered late. Scheduled for');",
  );
  await wait(
    "return !!button('sessionoverdue') && button('sessionoverdue').parentElement.textContent.includes('stopped');",
  );
  expect(
    await run(
      "return [...document.querySelectorAll('[data-testid=session-attribution]')].some(el => el.textContent.includes('Attention requested') && el.textContent.includes('View run'));",
    ),
  ).toBe(true);
});

it("lists a seven-day reminder before archive, preserves it on cancel, and cancels it on confirmation", async () => {
  await send("longreminder");
  await wait(
    "return !!button('sessionlongreminder') && button('sessionlongreminder').parentElement.textContent.includes('Next:');",
  );
  const archive = async () => {
    await run(
      `const bubble = document.querySelector('[data-chat-bubble][data-session-id] button'); if (!bubble) throw new Error('Missing chat bubble'); bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 500 }));`,
    );
    await wait(
      `return [...document.querySelectorAll('[role=menuitem]')].some(item => item.textContent.trim() === 'Archive');`,
    );
    await run(
      `[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === 'Archive').click();`,
    );
    await wait(
      "return !!$('[data-testid=archive-session-confirm]:not(:disabled)');",
    );
  };
  await archive();
  expect(
    await run("return document.querySelector('[role=dialog]').textContent;"),
  ).toContain("sessionlongreminder");
  expect(
    await run("return document.querySelector('[role=dialog]').textContent;"),
  ).toContain("Next:");
  await run("button('Cancel').click();");
  await wait(
    "return !document.querySelector('[role=dialog]:not([aria-hidden=true]) [data-testid=archive-session-confirm]');",
  );
  expect(
    await run(
      "return button('sessionlongreminder').parentElement.textContent;",
    ),
  ).toContain("active");
  await archive();
  await run("$('[data-testid=archive-session-confirm]').click();");
  await wait(
    "return !document.querySelector('[role=dialog]:not([aria-hidden=true]) [data-testid=archive-session-confirm]') && !document.querySelector('[data-chat-local-id] [data-composer-input]');",
  );
  const statuses = await run<string[]>(
    `const {url} = await window.catamorphicDesktop.getServerState(); const {items: projects} = await (await fetch(url + '/api/projects')).json(); const project = projects.find(item => item.name === 'Session workflows'); const {items: sessions} = await (await fetch(url + '/api/projects/' + project.id + '/agent/sessions')).json(); const statuses = []; for (const session of sessions) { const watchers = await (await fetch(url + '/api/projects/' + project.id + '/agent/sessions/' + session.id + '/watchers')).json(); statuses.push(...watchers.items.filter(item => item.workflowName === 'sessionlongreminder').map(item => item.status)); } return statuses;`,
  );
  expect(statuses).toEqual(["stopped"]);
});
