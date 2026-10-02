import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Approvals and connector requests are durable session requests (ADR 0196),
 * answered in the chat or from any client. Navigation and reload keep them.
 */

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
  const approval = () => $('[data-testid="approval-card"][data-request-kind="approval"]');
  const requestCard = (text) => $$('[data-testid="approval-card"]').find((el) => el.textContent.includes(text));
  const answer = label => { byText('section[aria-label="The agent has a question"] button', label).click(); };
  const submitAnswer = () => byText('section[aria-label="The agent has a question"] button', 'Submit').click();
  // The expanded floating chat; minimized ones stay mounted but inert.
  const hereChat = () => $$('[data-floating-chat]').find((el) => !el.closest('[inert]'));
  const here = () => hereChat()?.querySelector('[data-composer-input]');
  const hereLog = () => hereChat()?.querySelector('[role="log"]')?.textContent ?? '';
  const sendHere = (text) => { const ta = here(); setReactValue(ta, text); ta.closest('form').requestSubmit(); };
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
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'perm-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
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
      `const card = approval(); return !!card && card.textContent.includes('post_message') && card.textContent.includes('fake');`,
      { timeoutMs: 30_000, label: "approval card" },
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
    await runWait(`return !!approval();`);
    await app.waitFor(
      `window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(projectId)}).then(state => state?.chats?.some(chat => 'chat:'+chat.localId===${JSON.stringify(chatKey)} && chat.mode==='tab'))`,
      { label: "chat tab persisted before reload" },
    );
    await app.reload();
    await runWait(
      `return !!approval() && approval().textContent.includes('post_message');`,
      { timeoutMs: 60000, label: "pending approval restored" },
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
    await run(`$('[data-testid="approval-always"]').click(); return true;`);
    await runWait(
      `return !approval() && timeline().includes('permission decision: allow (always)');`,
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
      `return !!approval() && approval().textContent.includes('upload_file');`,
      { timeoutMs: 30_000, label: "third approval card" },
    );
    // Act as the companion app: find the pending request in the session's
    // snapshot and answer it with a command. The answer must both unblock
    // the tool call AND withdraw the card in this window.
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
            const detail = await fetch(url).then(r => r.ok ? r.json() : null);
            const ask = detail?.snapshot.requests.find(
              (request) => request.status === "pending" && request.approval?.tool?.name === "upload_file",
            );
            if (!ask) continue;
            const posted = await fetch(url + "/commands", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                type: "respond",
                commandId: crypto.randomUUID(),
                requestId: ask.id,
                response: { kind: "approval", decision: "approved" },
              }),
            });
            const receipt = await posted.json();
            return { ok: posted.ok && receipt.status === "accepted", detail: "answered " + ask.id };
          }
        }
        return { ok: false, detail: "no pending ask found over HTTP" };
      })()
    `);
    expect(answered).toMatchObject({ ok: true });
    await runWait(
      `return !approval() && timeline().includes('permission decision: allow');`,
      { timeoutMs: 30_000, label: "card withdrawn, agent got allow" },
    );
  }, 60_000);

  it("Deny answers deny; the card closes", async () => {
    await run(`send('permission: fake/delete_channel'); return true;`);
    await runWait(
      `return !!approval() && approval().textContent.includes('delete_channel');`,
      {
        timeoutMs: 30_000,
        label: "second approval card",
      },
    );
    await run(`$('[data-testid="approval-deny"]').click(); return true;`);
    await runWait(
      `return !approval() && timeline().includes('permission decision: deny');`,
      {
        timeoutMs: 30_000,
        label: "agent got deny",
      },
    );
  }, 60_000);
});

it("shows concurrent connector requests together and settles each independently", async () => {
  await run(`send('elicitation: queue');`);
  await runWait(
    `return !!requestCard('First app') && !!requestCard('Second app');`,
  );
  await app.screenshot("/tmp/codex-elicitation.png");
  await run(
    `requestCard('First app').querySelector('[data-testid="elicitation-accept"]').click();`,
  );
  await runWait(
    `return !requestCard('First app') && !!requestCard('Second app');`,
  );
  await run(
    `requestCard('Second app').querySelector('[data-testid="elicitation-decline"]').click();`,
  );
  await runWait(
    `return timeline().includes('elicitation decisions: accept,decline');`,
  );
  expect(await run(`return !!$('[data-testid="approval-card"]');`)).toBe(false);
});
it("withdraws a connector request on cancellation", async () => {
  await run(`send('elicitation: cancel');`);
  await runWait(`return !!requestCard('Cancelled app');`);
  await runWait(
    `return !requestCard('Cancelled app') && timeline().includes('elicitation decisions: decline');`,
  );
});

it("remembers native app consent only after an explicit answer in the chat", async () => {
  await run(`send('elicitation: app'); return true;`);
  await runWait(`return !!requestCard('Calculator');`);
  expect(await run(`return !!$('[data-testid="elicitation-modal"]');`)).toBe(
    false,
  );
  await run(
    `requestCard('Calculator').querySelector('[data-testid="elicitation-accept"]').click(); return true;`,
  );
  await runWait(
    `return timeline().includes('app consent: accept,accept') && !requestCard('Calculator');`,
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

// ADR 0195: the chat keeps going around a question.
describe("talking around questions", () => {
  const settle = () =>
    app.waitFor(
      `!document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)`,
    );

  it("opens a fresh floating chat", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!here() && !hereLog().includes('permission');`, {
      label: "fresh floating chat",
    });
  });

  it("a message during a blocking question gets a reply; the question stays open and still answers", async () => {
    await run(`sendHere('blocking question about the layout'); return true;`);
    await runWait(
      `return !!modal() && modal().textContent.includes('Which layout should I use?');`,
      { timeoutMs: 30_000, label: "blocking question" },
    );
    await settle();
    // The waiting status sits in the header beside the title; no row
    // above it, no "Other" row, and the composer takes free text.
    expect(
      await run(`
        const m = modal();
        return {
          headerFirst: m.firstElementChild === m.querySelector('header'),
          status: m.querySelector('header [role="status"]')?.textContent,
          other: !!byText('section[aria-label="The agent has a question"] button', 'Other'),
          placeholder: here().dataset.placeholder,
        };
      `),
    ).toEqual({
      headerFirst: true,
      status: "Waiting for your answer",
      other: false,
      placeholder: "Answer in your own words…",
    });
    await app.screenshot("/tmp/catamorphic-blocking-question.png");
    // A slow attachment shows its progress without moving the question.
    const top = await run<number>(
      `return modal().getBoundingClientRect().top;`,
    );
    await run(`
      here().focus();
      window.__originalFileRead = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        return new Promise((resolve, reject) => {
          window.__releasePaste = () => window.__originalFileRead.call(this).then(resolve, reject);
        });
      };
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([7, 8])], 'notes.bin'));
      here().dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return here().closest('form').textContent.includes('Preparing attachments');`,
      { label: "attachment preparing" },
    );
    expect(
      await run<number>(`return modal().getBoundingClientRect().top;`),
    ).toBe(top);
    await run(
      `File.prototype.arrayBuffer = window.__originalFileRead; window.__releasePaste(); return true;`,
    );
    await runWait(
      `return !!here().querySelector('[data-testid="composer-pill"]');`,
      { label: "attachment pill" },
    );
    await run(`
      const el = here(); el.focus();
      const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.execCommand('insertText', false, ' what is the difference?');
      el.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return hereLog().includes('Replying before you answer') && hereLog().includes('notes.bin') && modal()?.textContent.includes('Answer when ready');`,
      { timeoutMs: 30_000, label: "reply while the question stays open" },
    );
    // The reply reads after the message it answers.
    expect(
      await run(`
        const articles = [...hereChat().querySelectorAll('[role="log"] article')];
        const sent = articles.findIndex((el) => el.textContent.includes('what is the difference?') && el.dataset.userMessage);
        const reply = articles.findIndex((el) => el.textContent.includes('Replying before you answer'));
        return sent >= 0 && sent < reply;
      `),
    ).toBe(true);
    await run(`answer('Grid'); return true;`);
    await runWait(
      `const button = byText('section[aria-label="The agent has a question"] button', 'Submit'); if (!button || button.disabled) return false; button.click(); return true;`,
    );
    await runWait(
      `const card = hereChat().querySelector('[data-testid="question-answer"]'); return !modal() && !!card && card.textContent.includes('Which layout should I use?') && card.textContent.includes('Grid') && !card.textContent.includes('User answer');`,
      { timeoutMs: 30_000, label: "answer card in history" },
    );
  }, 90_000);

  it("the agent closes a question the conversation settled", async () => {
    await run(`sendHere('blocking question again'); return true;`);
    await runWait(`return !!modal();`, { timeoutMs: 30_000 });
    await run(`sendHere('never mind'); return true;`);
    await runWait(
      `return hereLog().includes('Replying before you answer: never mind') && modal()?.textContent.includes('Answer when ready');`,
      { timeoutMs: 30_000, label: "deferred question" },
    );
    await run(`sendHere('close my questions'); return true;`);
    await runWait(
      `return !modal() && hereLog().includes('Questions: Closed');`,
      { timeoutMs: 30_000, label: "question closed" },
    );
  }, 60_000);

  it("a message during a permission request withdraws it and reaches the agent", async () => {
    await run(`sendHere('permission: fake/archive_thread'); return true;`);
    await runWait(
      `return !!approval() && approval().textContent.includes('archive_thread');`,
      { timeoutMs: 30_000, label: "approval request" },
    );
    // Typing declines a permission request; the composer does not offer it
    // as an answer.
    expect(await run(`return here().dataset.placeholder;`)).not.toBe(
      "Answer in your own words…",
    );
    await run(`sendHere('do something else instead'); return true;`);
    await runWait(
      `return !approval() && hereLog().includes('permission decision: deny') && hereLog().includes('You said: do something else instead');`,
      { timeoutMs: 30_000, label: "consent withdrawn, message answered" },
    );
  }, 60_000);

  it("the agent can see Work's window instead of asking", async () => {
    await run(`sendHere('look at my screen'); return true;`);
    await runWait(`return hereLog().includes('Saw 1 window image');`, {
      timeoutMs: 30_000,
      label: "window screenshot",
    });
  }, 60_000);
});
