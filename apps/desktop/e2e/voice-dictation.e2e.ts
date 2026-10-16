import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Dictation and voice's keys (ADR 0216, 0236), end to end with scripted
 * speech. With "Dictation only" on, a chat's microphone writes what the
 * person says into its composer while they say it, and sends nothing: the
 * person sends it as typed text, the agent reads it as text, and dictation
 * ends with the send. Dictate's keys write into the text field the person
 * is in, a web page's too: tapped, until it is sent; held, while held.
 */

const UTTERANCES = [
  "how am i talking to you",
  "start a session to tidy the docs",
  "remember to water the plants",
];

let app: AppHandle;
/** A web page with a field to dictate into. */
const page = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<title>Talk page</title><p>Hold to talk</p><input id="note" aria-label="Note">',
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  app = await launchApp({
    env: { CATAMORPHIC_E2E_FAKE_VOICE: JSON.stringify(UTTERANCES) },
  });
}, 180_000);

afterAll(async () => {
  page.close();
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  const mic = () => $('[data-testid="voice-button"]');
  const chatOf = (localId) => $('[data-chat-local-id="' + localId + '"]');
  const chatMic = (localId) => chatOf(localId)?.querySelector('[data-testid="chat-voice-button"]');
  const composerOf = (localId) => chatOf(localId)?.querySelector('[data-composer-input]');
  const api = window.catamorphicDesktop;
  const session = async (ref) => {
    const { url } = await api.getServerState();
    const response = await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId);
    const body = await response.json();
    const roles = { user_message: 'user', assistant_message: 'assistant' };
    body.messages = [...(body.snapshot?.items ?? [])]
      .filter((item) => item.kind in roles)
      .sort((a, b) => a.position - b.position)
      .map((item) => ({ role: roles[item.kind], content: item.text }));
    return body;
  };
  ${setReactValueJs}
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(async () => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(async () => { ${helpers}\n${body} })()`, opts);

interface Ref {
  projectId: string;
  sessionId: string;
}

/** A script run in the web page, as its own. */
const page_ = (script: string) =>
  run(`return $('webview').executeJavaScript(${JSON.stringify(script)});`);

/** Dictate's default keys, Option+Space, down or up in the web page. */
const dictateKeys = (type: "keyDown" | "keyUp") =>
  run(`
    const view = $('webview');
    view.focus();
    view.sendInputEvent({ type: '${type}', keyCode: 'Space', modifiers: ['alt'] });
    return true;
  `);

/** Opens a microphone's menu, as a right click does. */
const openMenu = (button: string) =>
  run(`
    const button = ${button};
    const bounds = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
    }));
    return true;
  `);

describe("dictation and voice's keys", () => {
  it("boots into a project", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'dictation-e2e'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return mic()?.dataset.phase === 'off';`, {
      timeoutMs: 60_000,
      label: "microphone in the dock, off",
    });
  }, 180_000);

  it("writes what the person says into the composer as they say it, and ends when it is sent", async () => {
    const before = await run<string[]>(
      `return $$('[data-chat-local-id]').map((el) => el.dataset.chatLocalId);`,
    );
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'n', bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); return true;`);
    const localId = await runWait<string>(
      `const known = ${JSON.stringify(before)};
       const chat = $$('[data-chat-local-id]').find((el) => !known.includes(el.dataset.chatLocalId));
       return chat?.querySelector('[data-composer-input]') && chatMic(chat.dataset.chatLocalId) && chat.dataset.chatLocalId;`,
      { timeoutMs: 30_000, label: "a new chat with a microphone" },
    );
    const id = JSON.stringify(localId);
    // "Dictation only", from the composer's microphone menu.
    await openMenu(`chatMic(${id})`);
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Dictation only');
       if (!item || item.getAttribute('aria-checked') !== 'false') return false;
       item.click(); return true;`,
      { label: "dictation only in the menu" },
    );
    await runWait(`return (await api.getPrefs()).voiceDictation === true;`, {
      label: "dictation on",
    });
    // The words still being said show in the composer, muted, then stay.
    await run(`
      window.__dictationShown = [];
      window.__dictationObserver?.disconnect();
      window.__dictationObserver = new MutationObserver(() => {
        const live = composerOf(${id})?.querySelector('[data-dictation]');
        const text = live?.textContent.trim();
        if (text && window.__dictationShown.at(-1) !== text) window.__dictationShown.push(text);
      });
      window.__dictationObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
      return true;
    `);
    await run(`chatMic(${id}).click(); return true;`);
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       const { lastProjectId } = await api.getPrefs();
       return status.dictation && status.target?.kind === 'dictation' &&
         status.target.sessionId && chatMic(${id})?.dataset.lit === 'true' &&
         { projectId: lastProjectId, sessionId: status.target.sessionId };`,
      { timeoutMs: 30_000, label: "dictating in the chat" },
    );
    await runWait(
      `return composerOf(${id}).textContent.trim() === ${JSON.stringify(UTTERANCES[0])} &&
         !composerOf(${id}).querySelector('[data-dictation]');`,
      { timeoutMs: 30_000, label: "the words in the composer" },
    );
    const shown = await run<string[]>(`return window.__dictationShown;`);
    expect(shown.length).toBeGreaterThan(0);
    // Each showing was the start of what was said, as it was being said.
    for (const words of shown) expect(UTTERANCES[0]).toContain(words);
    // Nothing reached the chat, and nothing was read aloud.
    const quiet = await run<{ messages: unknown[] }>(
      `return session(${JSON.stringify(ref)});`,
    );
    expect(quiet.messages).toEqual([]);
    expect(await run(`return chatMic(${id}).dataset.phase;`)).toMatch(
      /listening|hearing/,
    );
    // The person sends it as typed text: dictation ends, and the agent
    // reads it as text.
    await run(
      `composerOf(${id}).closest('form').requestSubmit(); return true;`,
    );
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "dictation over once sent",
    });
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.some((m) => m.role === 'user' && m.content === ${JSON.stringify(UTTERANCES[0])}) &&
         detail.messages.some((m) => m.role === 'assistant' && m.content === 'By text.');`,
      { timeoutMs: 30_000, label: "sent and answered as text" },
    );
    await openMenu(`chatMic(${id})`);
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Dictation only');
       if (!item || item.getAttribute('aria-checked') !== 'true') return false;
       item.click(); return true;`,
      { label: "dictation off in the menu" },
    );
    await runWait(`return (await api.getPrefs()).voiceDictation === false;`, {
      label: "dictation off",
    });
  }, 120_000);

  it("dictates into a web page's field from a tap of its keys, until it is sent", async () => {
    const address = page.address();
    if (!address || typeof address === "string") throw new Error("No page");
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 't', altKey: true, bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); return true;`);
    await runWait(`return !!$('input[aria-label="Address and search bar"]');`, {
      timeoutMs: 30_000,
      label: "browser address bar",
    });
    await run(`
      const input = $('input[aria-label="Address and search bar"]');
      input.focus();
      setReactValue(input, 'http://127.0.0.1:${address.port}/');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `try { return $('webview')?.getTitle() === 'Talk page'; } catch { return false; }`,
      { timeoutMs: 30_000, label: "the test page" },
    );
    await page_(`document.getElementById('note').focus(); true`);
    await runWait(
      `return (await $('webview').executeJavaScript("document.activeElement?.id")) === 'note';`,
      { label: "the page's field focused" },
    );
    // Dictate's keys (Option+Space), tapped: on, listening on its own.
    await dictateKeys("keyDown");
    await dictateKeys("keyUp");
    await runWait(
      `return (await $('webview').executeJavaScript("document.getElementById('note').value")) === ${JSON.stringify(UTTERANCES[1])};`,
      { timeoutMs: 30_000, label: "the words typed into the page" },
    );
    const status = await run<{ dictation: boolean; handsFree: boolean }>(
      `return api.voiceStatus();`,
    );
    expect(status).toMatchObject({ dictation: true, handsFree: true });
    // Return in the field it wrote into sends it: dictation ends.
    await run(`
      $('webview').sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      $('webview').sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      return true;
    `);
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "dictation over once sent",
    });
  }, 120_000);

  it("dictates while its keys are held, and goes off after", async () => {
    await page_(
      `const note = document.getElementById('note'); note.value = ''; note.focus(); true`,
    );
    await dictateKeys("keyDown");
    await runWait(
      `const status = await api.voiceStatus();
       return status.phase === 'hearing' && status.dictation && !status.handsFree;`,
      { timeoutMs: 30_000, label: "dictating while the keys are down" },
    );
    // While held, the words show in the page's field as they are said.
    await runWait(
      `return (await $('webview').executeJavaScript("document.getElementById('note').value")).length > 0;`,
      { timeoutMs: 30_000, label: "words showing in the page" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await dictateKeys("keyUp");
    await runWait(
      `return (await $('webview').executeJavaScript("document.getElementById('note').value")) === ${JSON.stringify(UTTERANCES[2])};`,
      { timeoutMs: 30_000, label: "the words typed into the page" },
    );
    // Started by holding, it goes off once it has nothing left to do.
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "voice off once idle",
    });
  }, 120_000);
});
