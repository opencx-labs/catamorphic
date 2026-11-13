import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  openProjectSwitcher,
  setReactValueJs,
  waitForProjectWorkspace,
  workspaceDomHelpersJs,
} from "./harness.js";

/**
 * Dictation writes final words when its microphone or shortcut is released.
 * Holding shows provisional words without sending a chat message.
 * Browser shortcuts use the page's native input path.
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
  ${workspaceDomHelpersJs}
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  // A visible control can still be moving, or covered by the dock.
  const hitPoint = (element) => {
    if (!element?.checkVisibility({opacityProperty:true,visibilityProperty:true}) || element.disabled) return false;
    const box = element.getBoundingClientRect();
    const scope = element.closest('[role="menu"], [data-dock-rail], [data-chat-local-id]') ?? element;
    if (scope.getAnimations({subtree:true}).some(animation =>
      (animation.playState === 'running' || animation.pending) && animation.effect?.getTiming().iterations !== Infinity
    )) return false;
    const point = {x:box.x+box.width/2,y:box.y+box.height/2};
    return element.contains(document.elementFromPoint(point.x,point.y)) && point;
  };
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

/** Open the microphone menu with the same pointer input as a person. */
async function openMenu(button: string) {
  await focusWindow(app);
  const point = await runWait<{ x: number; y: number }>(
    `return hitPoint(${button});`,
    { label: "the microphone menu's hit target" },
  );
  await app.movePointer(point);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      clickCount: 1,
    });
}

/** Wait for enough microphone samples to recognize the complete scripted phrase. */
async function capturedSpeech() {
  const audio = await app.connectToFrame("voice.html");
  try {
    const before = await audio.eval<number>(`(() => {
      if (window.__dictationAudioSeconds === undefined) {
        window.__dictationAudioSeconds = 0;
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...args) {
          if (message?.type === 'frame')
            window.__dictationAudioSeconds += message.samples.length / message.sampleRate;
          return Reflect.apply(post, this, [message, ...args]);
        };
      }
      return window.__dictationAudioSeconds;
    })()`);
    await audio.waitFor(`window.__dictationAudioSeconds >= ${before + 1.7}`, {
      timeoutMs: 30_000,
      label: "the full scripted phrase captured",
    });
  } finally {
    audio.close();
  }
}

describe("dictation and voice's keys", () => {
  it("boots into a project", async () => {
    await openProjectSwitcher(app);
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
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
    await waitForProjectWorkspace({ app, name: "dictation-e2e" });
    await runWait(`return mic()?.dataset.phase === 'off';`, {
      timeoutMs: 60_000,
      label: "microphone in the dock, off",
    });
  }, 180_000);

  it("writes final words into the composer on release and sends them as text", async () => {
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
    await openMenu(`chatMic(${id})`);
    const dictationToggle = await runWait<{ x: number; y: number }>(
      `const item = byText('[role="menuitemcheckbox"]', 'Dictation only');
       if (item?.getAttribute('aria-checked') !== 'false') return false;
       return hitPoint(item);`,
      { label: "dictation only in the menu" },
    );
    await app.clickPointer(dictationToggle);
    await runWait(
      `return (await api.getPrefs()).voiceDictation === true &&
         chatMic(${id})?.dataset.action === 'dictate';`,
      { label: "dictation on" },
    );
    const point = await runWait<{ x: number; y: number }>(
      `return hitPoint(chatMic(${id}));`,
      { label: "the composer's microphone" },
    );
    await app.movePointer(point);
    await run(`
      window.__dictationPress = null;
      document.addEventListener('pointerdown', event => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        window.__dictationPress = {testid:button?.dataset.testid,place:button?.dataset.place,label:button?.getAttribute('aria-label')};
      }, {once:true,capture:true});
      return true;
    `);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       const { lastProjectId } = await api.getPrefs();
       return status.dictation && status.phase === 'hearing' &&
         status.target?.kind === 'dictation' && status.target.sessionId &&
         { projectId: lastProjectId, sessionId: status.target.sessionId };`,
      { timeoutMs: 30_000, label: "dictating while the microphone is held" },
    ).catch(async (cause: unknown) => {
      const detail = await run(`return {
        status:await api.voiceStatus(),press:window.__dictationPress,
        chat:{...chatOf(${id})?.dataset},
        microphone:chatMic(${id})?.getAttribute('aria-description')
      };`);
      throw new Error(
        `${String(cause)}; dictation input: ${JSON.stringify(detail)}`,
      );
    });
    await capturedSpeech();
    expect(await run(`return composerOf(${id}).textContent.trim();`)).toBe(
      UTTERANCES[0],
    );
    expect(
      await run(
        `return !!composerOf(${id}).querySelector('[data-dictation]');`,
      ),
    ).toBe(true);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await runWait(
      `return composerOf(${id}).textContent.trim() === ${JSON.stringify(UTTERANCES[0])} &&
         !composerOf(${id}).querySelector('[data-dictation]');`,
      { timeoutMs: 30_000, label: "the final words in the composer" },
    );
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "dictation off after release",
    });
    const quiet = await run<{ messages: unknown[] }>(
      `return session(${JSON.stringify(ref)});`,
    );
    expect(quiet.messages).toEqual([]);
    await run(
      `composerOf(${id}).closest('form').requestSubmit(); return true;`,
    );
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.some((m) => m.role === 'user' && m.content === ${JSON.stringify(UTTERANCES[0])}) &&
         detail.messages.some((m) => m.role === 'assistant' && m.content === 'By text.');`,
      { timeoutMs: 30_000, label: "sent and answered as text" },
    );
    await openMenu(`chatMic(${id})`);
    const dictationOff = await runWait<{ x: number; y: number }>(
      `const item = byText('[role="menuitemcheckbox"]', 'Dictation only');
       if (!item || item.getAttribute('aria-checked') !== 'true') return false;
       return hitPoint(item);`,
      { label: "dictation off in the menu" },
    );
    await app.clickPointer(dictationOff);
    await runWait(`return (await api.getPrefs()).voiceDictation === false;`, {
      label: "dictation off",
    });
  }, 120_000);

  it("dictates into a web page's focused field when its keys are released", async () => {
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
    await dictateKeys("keyDown");
    await runWait(
      `const status = await api.voiceStatus(); return status.phase === 'hearing' && status.dictation;`,
      { timeoutMs: 30_000, label: "dictating while the keys are down" },
    );
    await capturedSpeech();
    expect(await page_(`document.getElementById('note').value`)).toBe(
      UTTERANCES[1],
    );
    await dictateKeys("keyUp");
    await runWait(
      `return (await $('webview').executeJavaScript("document.getElementById('note').value")) === ${JSON.stringify(UTTERANCES[1])};`,
      { timeoutMs: 30_000, label: "the final words typed into the page" },
    );
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "dictation off after release",
    });
  }, 120_000);

  it("reuses dictation on a second hold and shows words before release", async () => {
    await page_(
      `const note = document.getElementById('note'); note.value = ''; note.focus(); true`,
    );
    await dictateKeys("keyDown");
    await runWait(
      `const status = await api.voiceStatus(); return status.phase === 'hearing' && status.dictation;`,
      { timeoutMs: 30_000, label: "dictating on the next hold" },
    );
    await capturedSpeech();
    expect(await page_(`document.getElementById('note').value`)).toBe(
      UTTERANCES[2],
    );
    await dictateKeys("keyUp");
    await runWait(
      `return (await $('webview').executeJavaScript("document.getElementById('note').value")) === ${JSON.stringify(UTTERANCES[2])};`,
      { timeoutMs: 30_000, label: "the second hold's final words" },
    );
    await runWait(`return (await api.voiceStatus()).phase === 'off';`, {
      timeoutMs: 30_000,
      label: "dictation off again",
    });
  }, 120_000);
});
