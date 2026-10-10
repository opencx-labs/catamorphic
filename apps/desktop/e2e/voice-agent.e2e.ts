import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Voice (ADR 0216), end to end with scripted speech: the audio page
 * captures the (fake) microphone and streams it to the speech worker,
 * which "hears" one utterance per start. The dock's microphone talks to
 * the assistant, a real session on Work's built-in assistant over the fake
 * agent: it hands the work to a session on the fake agent itself, speaks
 * the result when that session delivers it, and has the assistant's
 * session tools. The microphone's menu opens its chat, picks the voice and
 * the assistant; a reset closes the chat so the next start makes another.
 * A session's question that arrives while voice is off shows on the
 * microphone, and the next start says it first. A chat's own microphone
 * talks to that chat's agent, which hears that the person talks by voice
 * until they type again. The dock's microphone can leave the dock, and its
 * shortcut turns it on and off; in push to talk it hears only while the
 * keys are held, even in a web page.
 */

const UTTERANCES = [
  "start a session to tidy the docs",
  "which tools can you use",
  "tell my other chat to add a changelog entry",
  "start a session that asks me something",
  "keep the new ones",
  "how am i talking to you",
  "who are you",
  "how am i talking to you",
  "how am i talking to you",
];
/** The assistant's own tools over the person's chats. */
const ASSISTANT_SESSION_TOOLS = [
  "answer_question",
  "follow_session",
  "list_sessions",
  "message_session",
  "read_session",
  "start_session",
  "stop_session",
];

let app: AppHandle;
/** A web page to hold push to talk's keys in. */
const page = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<title>Talk page</title><p>Hold to talk</p>");
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
  const dockVoice = () => mic()?.closest('[data-dock-voice]')?.dataset.dockVoice;
  const api = window.catamorphicDesktop;
  const session = async (ref, path = '') => {
    const { url } = await api.getServerState();
    const response = await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId + path);
    const body = await response.json();
    // A chat's transcript is its snapshot's message items (ADR 0197).
    if (body?.snapshot)
      body.messages = [...body.snapshot.items]
        .filter((item) => item.kind === 'user_message' || item.kind === 'assistant_message')
        .sort((a, b) => a.position - b.position)
        .map((item) => ({
          role: item.kind === 'user_message' ? 'user' : 'assistant',
          content: item.text,
        }));
    return body;
  };
  /** Types a message into a chat, as its composer would send it. */
  const sendText = async (ref, text) => {
    const { url } = await api.getServerState();
    await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId + '/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'send', commandId: crypto.randomUUID(), text }),
    });
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

/** Every phase the microphone shows from now on, in order. */
const recordPhases = () =>
  run(`
    window.__voicePhases = [mic().dataset.phase];
    window.__voiceLoudest = 0;
    window.__voiceObserver?.disconnect();
    window.__voiceObserver = new MutationObserver(() => {
      const phase = mic()?.dataset.phase;
      if (phase && window.__voicePhases.at(-1) !== phase) window.__voicePhases.push(phase);
      for (const bar of mic()?.querySelectorAll('.voice-bars > span') ?? [])
        window.__voiceLoudest = Math.max(window.__voiceLoudest, Number(bar.style.getPropertyValue('--level')) || 0);
    });
    window.__voiceObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-phase', 'style'] });
    return true;
  `);

/** CDP's modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const SPACE = { key: " ", code: "Space", windowsVirtualKeyCode: 32 };

/** Presses an action's default keys (Cmd is Ctrl off a Mac). */
async function shortcut(action: "toggle-voice") {
  const cmd = process.platform === "darwin" ? 4 : 2;
  const modifiers = action === "toggle-voice" ? cmd + 8 : 0;
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", { type, modifiers, ...SPACE });
}

/**
 * Option+Space, push to talk's default keys, going down or up in the web
 * page: through the page's real input path, which main reads first.
 */
function holdPushToTalk(type: "keyDown" | "keyUp") {
  return app.eval(`(() => {
    const view = document.querySelector('webview');
    view.focus();
    view.sendInputEvent({ type: '${type}', keyCode: 'Space', modifiers: ['alt'] });
    return true;
  })()`);
}

/** Opens a browser tab on the test page. */
async function openPage() {
  const address = page.address();
  if (!address || typeof address === "string") throw new Error("No page");
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', altKey: true, bubbles: true, cancelable: true,
    ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  await app.waitFor(
    `!!document.querySelector('input[aria-label="Address and search bar"]')`,
    { timeoutMs: 30_000, label: "browser address bar" },
  );
  await app.eval(`(() => {
    const input = document.querySelector('input[aria-label="Address and search bar"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://127.0.0.1:${address.port}/');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await app.waitFor(
    `(() => { try { return document.querySelector('webview')?.getTitle() === 'Talk page'; } catch { return false; } })()`,
    { timeoutMs: 30_000, label: "the test page" },
  );
}

/** Opens the microphone's menu, as a right click does. */
const openMenu = () =>
  run(`
    const bounds = mic().getBoundingClientRect();
    mic().dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
    }));
    return true;
  `);

/** Talk once: the assistant's chat holds the utterance and the spoken reply. */
async function talk(utterance: string, reply: string): Promise<Ref> {
  await recordPhases();
  await run(`mic().click(); return true;`);
  const ref = await runWait<Ref>(
    `const status = await api.voiceStatus();
     const prefs = await api.getPrefs();
     return status.phase !== 'off' && status.phase !== 'preparing' && prefs.assistantSession;`,
    { timeoutMs: 30_000, label: "voice listening in the assistant's chat" },
  );
  await runWait(
    `const detail = await session(${JSON.stringify(ref)});
     return detail.messages?.some((m) => m.role === 'user' && m.content === ${JSON.stringify(utterance)}) &&
       detail.messages.some((m) => m.role === 'assistant' && m.content.startsWith(${JSON.stringify(reply)}));`,
    {
      timeoutMs: 30_000,
      label: "the utterance and its answer in the assistant's chat",
    },
  );
  await runWait(
    `const phases = window.__voicePhases;
     return phases.includes('speaking') && phases.at(-1) === 'listening';`,
    { timeoutMs: 30_000, label: "the answer spoken, then listening again" },
  );
  return ref;
}

describe("voice", () => {
  it("boots into a project with the microphone in the dock", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'voice-e2e'); return true;`,
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

  let first: Ref;

  it("lights up, hears the person, hands the work to a session and speaks", async () => {
    first = await talk(
      UTTERANCES[0] ?? "",
      "It's started. I'll tell you when it's done.",
    );
    const phases = await run<string[]>(`return window.__voicePhases;`);
    expect(phases.slice(0, 2)).toEqual(["off", "preparing"]);
    expect(phases).toEqual(
      expect.arrayContaining(["hearing", "thinking", "speaking", "listening"]),
    );
    // The bars followed the voice as it was heard, well above the working
    // wave's dots.
    expect(await run<number>(`return window.__voiceLoudest;`)).toBeGreaterThan(
      0.5,
    );
    expect(
      await run<boolean>(
        `return mic().getAttribute('aria-pressed') === 'true';`,
      ),
    ).toBe(true);
    const prefs = await run<{ assistantSession: Ref | null }>(
      `return api.getPrefs();`,
    );
    expect(prefs.assistantSession).toEqual(first);
    const detail = await run<{ status: string; agentId: string }>(
      `return session(${JSON.stringify(first)});`,
    );
    expect(detail.status).toBe("active");
    // The assistant is Work's built-in one, on the person's agent...
    expect(detail.agentId).toMatch(/^work-assistant:/);
    // ...and the session it started runs on the agent itself.
    const children = await runWait<{ session: { agentId: string } }[]>(
      `const children = await session(${JSON.stringify(first)}, '/subsessions');
       return children.length > 0 && children;`,
      { label: "the session the assistant started" },
    );
    expect(children.map((child) => child.session.agentId)).toEqual([
      detail.agentId.slice("work-assistant:".length),
    ]);
    // Its result comes back to the assistant on its own, which answers.
    await runWait(
      `const detail = await session(${JSON.stringify(first)});
       return detail.messages.some((m) => m.role === 'assistant' && m.content.startsWith('You said:'));`,
      {
        timeoutMs: 30_000,
        label: "the delegated result answered in the assistant's chat",
      },
    );
    await runWait(`return mic().dataset.phase === 'listening';`, {
      timeoutMs: 30_000,
      label: "listening again after the result",
    });
  }, 120_000);

  it("a second click stops listening and keeps the chat for next time", async () => {
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off",
    });
    const prefs = await run<{ assistantSession: Ref | null }>(
      `return api.getPrefs();`,
    );
    expect(prefs.assistantSession).toEqual(first);
  }, 60_000);

  it("the microphone's menu opens the assistant's chat and picks the voice and microphone", async () => {
    // Voices are a submenu, named, with who they are beside the name.
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitem"][data-submenu]', 'Voice');
       if (!item) return false; item.click(); return true;`,
      { label: "open the Voice submenu" },
    );
    const voices = await runWait<{ label: string; checked: string }[]>(
      `const items = $$('[role="menu"][aria-label="Voice"] [role="menuitemradio"]');
       return items.length > 0 && items.map((item) => ({
         label: item.textContent.trim(), checked: item.getAttribute('aria-checked'),
       }));`,
      { label: "the voices in the submenu" },
    );
    expect(voices).toEqual([
      { label: "HeartAmerican woman", checked: "true" },
      { label: "BellaAmerican woman", checked: "false" },
      { label: "MichaelAmerican man", checked: "false" },
      { label: "FenrirAmerican man", checked: "false" },
    ]);
    await run(
      `byText('[role="menuitemradio"]', 'Michael').click(); return true;`,
    );
    // The built-in assistant speaks in the default voice.
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceId === 'am_michael' && !$('[role="menuitemradio"]');`,
      { label: "the new voice kept, the menu closed" },
    );
    // Microphones too: the system's, then each one the machine has.
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitem"][data-submenu]', 'Microphone');
       if (!item) return false; item.click(); return true;`,
      { label: "open the Microphone submenu" },
    );
    const microphones = await runWait<string[]>(
      `const items = $$('[role="menu"][aria-label="Microphone"] [role="menuitemradio"]');
       return items.length > 1 && items.map((item) => item.textContent.trim() + ':' + item.getAttribute('aria-checked'));`,
      { label: "the microphones in the submenu" },
    );
    expect(microphones[0]).toBe("System default:true");
    await run(
      `$$('[role="menu"][aria-label="Microphone"] [role="menuitemradio"]')[1].click(); return true;`,
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return typeof prefs.voiceMicrophone === 'string';`,
      { label: "the chosen microphone kept" },
    );
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitem"]', 'Open assistant chat');
       if (!item) return false; item.click(); return true;`,
      { label: "open the assistant's chat from the menu" },
    );
    // It opens like any chat, with what was said and answered.
    await runWait(
      `return !!$('[data-session-id="${first.sessionId}"]') &&
         !!byText('*', 'start a session to tidy the docs');`,
      { label: "the assistant's chat open in the dock" },
    );
  }, 60_000);

  it("reset closes the assistant's chat, and the next click starts a new one", async () => {
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitem"]', 'Reset assistant chat');
       if (!item || item.disabled) return false; item.click(); return true;`,
      { label: "reset from the microphone's menu" },
    );
    await runWait(
      `const prefs = await api.getPrefs();
       const old = await session(${JSON.stringify(first)});
       return prefs.assistantSession === null && old.status === 'closed';`,
      { label: "old assistant chat closed and forgotten" },
    );
    // The new chat has the person's agent's tools, with the assistant's
    // session tools in place of Work's project-only ones.
    const second = await talk(UTTERANCES[1] ?? "", "Tools: ");
    const tools = await run<string[]>(
      `const detail = await session(${JSON.stringify(second)});
       const reply = detail.messages.find((m) => m.role === 'assistant' && m.content.startsWith('Tools: '));
       return reply.content.slice('Tools: '.length).split(', ');`,
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        ...ASSISTANT_SESSION_TOOLS,
        "open_surface",
        "update_todo_list",
      ]),
    );
    expect(tools).not.toContain("spawn_subsession");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.projectId).toBe(first.projectId);
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off again",
    });
    // Nor does it discover Work's project-only chat tools.
    await run(
      `await sendText(${JSON.stringify(second)}, 'which session capabilities can you find'); return true;`,
    );
    const found = await runWait<string>(
      `const detail = await session(${JSON.stringify(second)});
       return detail.messages.find((m) => m.role === 'assistant' && m.content.startsWith('Capabilities:'))?.content;`,
      { timeoutMs: 30_000, label: "what the assistant can discover" },
    );
    for (const replaced of [
      "list_project_sessions",
      "read_project_session",
      "send_project_session_message",
      "interrupt_subsession",
    ])
      expect(found).not.toContain(replaced);
  }, 120_000);

  it("manages the person's own chats, not only the ones it started", async () => {
    const prefs = await run<{ assistantSession: Ref }>(
      `return api.getPrefs();`,
    );
    const mine = await run<Ref>(`
      const { url } = await api.getServerState();
      const response = await fetch(url + '/api/projects/${prefs.assistantSession.projectId}/agent/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Release notes' }),
      });
      const created = await response.json();
      return { projectId: created.projectId, sessionId: created.id };
    `);
    await talk(UTTERANCES[2] ?? "", "Told Release notes.");
    await runWait(
      `const detail = await session(${JSON.stringify(mine)});
       return detail.messages?.some((m) => m.role === 'user' && m.content === 'add a changelog entry');`,
      { label: "the person's own chat got the assistant's message" },
    );
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off at the end",
    });
  }, 120_000);

  it("hears a session's notes as it works, as one quiet line", async () => {
    const { assistantSession: ref } = await run<{ assistantSession: Ref }>(
      `return api.getPrefs();`,
    );
    await run(
      `await sendText(${JSON.stringify(ref)}, 'start a session that reports as it goes'); return true;`,
    );
    const note = await runWait<{ text: string; notice: unknown }>(
      `const detail = await session(${JSON.stringify(ref)});
       const item = detail.snapshot.items.find((item) =>
         item.kind === 'user_message' && item.author.kind === 'system' && item.author.code === 'session_notes');
       return item && { text: item.text, notice: item.metadata.notice };`,
      {
        timeoutMs: 30_000,
        label: "the session's notes in the assistant's chat",
      },
    );
    expect(note).toEqual({
      text: "Report, while it works:\n- Reading the docs folder.",
      notice: "Report: an update",
    });
    // Its result comes the usual way, and the notes never repeat it.
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.snapshot.items.some((item) => item.kind === 'user_message' && item.text.includes('Two pages are stale.'));`,
      { timeoutMs: 30_000, label: "the session's result delivered" },
    );
    const notes = await run<number>(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.snapshot.items.filter((item) => item.kind === 'user_message' && item.author.code === 'session_notes').length;`,
    );
    expect(notes).toBe(1);
    await runWait(`return !(await session(${JSON.stringify(ref)})).running;`, {
      timeoutMs: 30_000,
      label: "the assistant done with the session's result",
    });
  }, 120_000);

  it("hears a session's question at once, and answers it for the person", async () => {
    const { assistantSession: ref } = await run<{ assistantSession: Ref }>(
      `return api.getPrefs();`,
    );
    // A question folded into a turn already running there is the
    // harness's to read; this one should start a turn of its own.
    await runWait(`return !(await session(${JSON.stringify(ref)})).running;`, {
      timeoutMs: 30_000,
      label: "the assistant idle",
    });
    await run(
      `await sendText(${JSON.stringify(ref)}, 'start a session that asks me to choose a layout'); return true;`,
    );
    // The question reaches the assistant as soon as it is asked...
    const asked = await runWait<string>(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.snapshot.items.find((item) =>
         item.kind === 'user_message' && item.metadata?.notice === 'Layout: a question')?.text;`,
      {
        timeoutMs: 30_000,
        label: "the session's question in the assistant's chat",
      },
    );
    expect(asked).toContain(
      "Which layout should I use? (one of: Wide, Narrow; or their own words)",
    );
    // ...which answers in a turn, spoken when voice is on. Core's own "needs
    // user input" for a delegated session may arrive first and start that
    // turn, with the question joining it, so any reply after it counts.
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       const asked = detail.snapshot.items.find((item) => item.metadata?.notice === 'Layout: a question');
       return !detail.running && detail.snapshot.items.some((item) =>
         item.kind === 'assistant_message' && item.position > asked.position);`,
      {
        timeoutMs: 30_000,
        label: "the assistant answering after the question",
      },
    );
    // The person answers the assistant, and the session that asked has it.
    await run(
      `await sendText(${JSON.stringify(ref)}, 'the answer is wide'); return true;`,
    );
    const layout = await runWait<Ref>(
      `const children = await session(${JSON.stringify(ref)}, '/subsessions');
       const child = children.find((c) => c.session.title === 'Layout');
       return child && { projectId: ${JSON.stringify(ref.projectId)}, sessionId: child.session.id };`,
      { label: "the session that asked" },
    );
    await runWait(
      `const detail = await session(${JSON.stringify(layout)});
       return detail.messages.some((m) => m.role === 'assistant' && m.content === 'Using the Wide layout.');`,
      { timeoutMs: 30_000, label: "the answer reached the session that asked" },
    );
  }, 120_000);

  it("news while voice is off shows on the microphone, and starting says it first", async () => {
    // A session it starts asks the person something; voice goes off first.
    const ref = await talk(
      UTTERANCES[3] ?? "",
      "Started. It may have a question for you.",
    );
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off before the question",
    });
    // The question wakes the assistant, which answers like any chat...
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.some((m) => m.role === 'assistant' && m.content === 'The docs session wants to know which pages to keep.');`,
      { timeoutMs: 30_000, label: "the assistant passing the question on" },
    );
    // ...and the microphone shows there is something to hear.
    await runWait(
      `return mic().dataset.pending === 'true' &&
         mic().querySelector('[data-testid="voice-news"]')?.dataset.shown === 'true';`,
      { timeoutMs: 20_000, label: "news on the microphone" },
    );
    // Starting speaks the news before the person says anything, then
    // passes their answer back to the session that asked.
    await recordPhases();
    await run(`mic().click(); return true;`);
    await runWait(
      `const phases = window.__voicePhases;
       return phases.includes('speaking') && phases.includes('hearing') &&
         phases.indexOf('speaking') < phases.indexOf('hearing');`,
      {
        timeoutMs: 30_000,
        label: "the news spoken before listening to the person",
      },
    );
    expect(await run(`return mic().dataset.pending ?? null;`)).toBe(null);
    const docs = await runWait<Ref>(
      `const children = await session(${JSON.stringify(ref)}, '/subsessions');
       const child = children.find((c) => c.session.title === 'Docs pages');
       return child && { projectId: ${JSON.stringify(ref.projectId)}, sessionId: child.session.id };`,
      { label: "the session that asked" },
    );
    await runWait(
      `const detail = await session(${JSON.stringify(docs)});
       return detail.messages?.some((m) => m.role === 'user' && m.content === 'Keep the new ones.');`,
      { timeoutMs: 30_000, label: "the answer passed back to it" },
    );
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off at the very end",
    });
  }, 120_000);

  it("a chat's own microphone talks to its agent, which hears it is voice until the person types", async () => {
    // A new chat, started by typing.
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
       return chat?.querySelector('[data-composer-input]') && chat.dataset.chatLocalId;`,
      { label: "a new chat" },
    );
    const type = (text: string) =>
      run(`const input = chatOf(${JSON.stringify(localId)}).querySelector('[data-composer-input]');
        setReactValue(input, ${JSON.stringify(text)}); input.closest('form').requestSubmit(); return true;`);
    const answers = (text: string) =>
      run<number>(
        `return [...chatOf(${JSON.stringify(localId)}).querySelectorAll('.cat-markdown')]
           .filter((el) => el.textContent.trim() === ${JSON.stringify(text)}).length;`,
      );
    await type("how am i talking to you");
    await runWait(
      `return [...chatOf(${JSON.stringify(localId)}).querySelectorAll('.cat-markdown')].some((el) => el.textContent.trim() === 'By text.');`,
      { timeoutMs: 30_000, label: "a typed answer" },
    );
    // Its microphone sits in the composer; the dock's stays off.
    await run(`chatMic(${JSON.stringify(localId)}).click(); return true;`);
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       return status.phase !== 'off' && status.phase !== 'preparing' &&
         status.target?.kind === 'chat' && chatMic(${JSON.stringify(localId)})?.dataset.lit === 'true' &&
         { projectId: status.target.projectId, sessionId: status.target.sessionId };`,
      { timeoutMs: 30_000, label: "voice on in the chat" },
    );
    expect(await run(`return mic().dataset.phase;`)).toBe("off");
    // What the person says is the chat's next message, and the agent knows
    // they talk by voice: it answers so.
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.filter((m) => m.role === 'user' && m.content === 'how am i talking to you').length === 2 &&
         detail.messages.some((m) => m.role === 'assistant' && m.content === 'By voice.');`,
      { timeoutMs: 30_000, label: "the spoken message answered as voice" },
    );
    const detail = await run<{ agentId: string }>(
      `return session(${JSON.stringify(ref)});`,
    );
    expect(detail.agentId).not.toMatch(/assistant:/);
    // Off again, the conversation carries on in text.
    await run(`chatMic(${JSON.stringify(localId)}).click(); return true;`);
    await runWait(
      `return (await api.voiceStatus()).phase === 'off' && chatMic(${JSON.stringify(localId)}).dataset.phase === 'off';`,
      { label: "voice off in the chat" },
    );
    await type("how am i talking to you");
    await runWait(
      `return [...chatOf(${JSON.stringify(localId)}).querySelectorAll('.cat-markdown')].filter((el) => el.textContent.trim() === 'By text.').length === 2;`,
      { timeoutMs: 30_000, label: "typed again, answered as text" },
    );
    expect(await answers("By voice.")).toBe(1);
    // Out of chats, composers have no microphone.
    await run(`await api.setPrefs({ voiceInChats: false }); return true;`);
    await runWait(`return !chatMic(${JSON.stringify(localId)});`, {
      label: "no microphone in the composer",
    });
    await run(`await api.setPrefs({ voiceInChats: true }); return true;`);
    await runWait(`return !!chatMic(${JSON.stringify(localId)});`, {
      label: "the composer's microphone back",
    });
  }, 120_000);

  it("another agent can be the assistant, as it is set up and in its own voice", async () => {
    const { agents } = await run<{ agents: { id: string; name: string }[] }>(
      `return api.agentsList();`,
    );
    const other = agents.find((agent) => agent.name === "Other Fake");
    if (!other) throw new Error("No second fake agent");
    await run(
      `await api.agentsUpdate(${JSON.stringify(other.id)}, { instructions: 'You are Juniper.' }); return true;`,
    );
    const old = (
      await run<{ assistantSession: Ref | null }>(`return api.getPrefs();`)
    ).assistantSession;
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitem"][data-submenu]', 'Assistant');
       if (!item) return false; item.click(); return true;`,
      { label: "open the Assistant submenu" },
    );
    const choices = await runWait<string[]>(
      `const items = $$('[role="menu"][aria-label="Assistant"] [role="menuitemradio"], [role="menu"][aria-label="Assistant"] [role="menuitem"]');
       return items.length > 2 && items.map((item) => item.textContent.trim());`,
      { label: "the assistants to pick from" },
    );
    expect(choices[0]).toContain("Built-in assistant");
    expect(choices).toEqual(
      expect.arrayContaining(["Fake Agent", "Other Fake", "Create agent…"]),
    );
    await run(
      `byText('[role="menuitemradio"]', 'Other Fake').click(); return true;`,
    );
    await runWait(
      `return (await api.getPrefs()).voiceAssistant === ${JSON.stringify(other.id)};`,
      { label: "the other agent is the assistant" },
    );
    // Its voice is its own: picking one in the dock's menu keeps the default.
    await openMenu();
    await runWait(
      `return !!byText('[role="menuitem"][data-submenu]', 'Assistant')?.textContent.includes('Other Fake');`,
      { label: "the menu naming the new assistant" },
    );
    await runWait(
      `const item = byText('[role="menuitem"][data-submenu]', 'Voice');
       if (!item) return false; item.click(); return true;`,
      { label: "open the Voice submenu" },
    );
    await run(
      `byText('[role="menuitemradio"]', 'Bella').click(); return true;`,
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.agentVoices[${JSON.stringify(other.id)}] === 'af_bella' && prefs.voiceId === 'am_michael';`,
      { label: "the assistant's own voice kept" },
    );
    // It talks in a chat of its own, as configured, with the assistant's
    // guidance after its own instructions.
    const ref = await talk(UTTERANCES[6] ?? "", "Your assistant, Juniper.");
    expect(ref.sessionId).not.toBe(old?.sessionId);
    const detail = await run<{ agentId: string }>(
      `return session(${JSON.stringify(ref)});`,
    );
    expect(detail.agentId).toBe(`assistant:${other.id}`);
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off after the new assistant",
    });
    // The palette picks it too: back to Work's built-in assistant.
    const palette = `$$('textarea[aria-label="Search commands, pages, and more"]').find((el) => !el.closest('[inert]'))`;
    const pickRow = (text: string) => `
      const option = [...${palette}.closest('[role="dialog"]').querySelectorAll('[role="option"]')]
        .find((el) => el.textContent.includes(${JSON.stringify(text)}));
      if (!option) return false;
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return true;`;
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); return true;`);
    await runWait(`return !!${palette};`, { label: "palette open" });
    await run(`setReactValue(${palette}, 'Change assistant'); return true;`);
    await runWait(pickRow("Change assistant"), { label: "the command row" });
    await runWait(
      `return !!$('[data-testid="palette-mode-chip"]')?.textContent.includes('Assistant');`,
      { label: "the assistant picker" },
    );
    await runWait(pickRow("Built-in assistant"), { label: "the built-in row" });
    await runWait(`return (await api.getPrefs()).voiceAssistant === null;`, {
      label: "the built-in assistant again",
    });
  }, 120_000);

  it("hides from the dock, shows while its shortcut has it on, and comes back from the arrows' menu", async () => {
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Show voice in dock');
       if (!item || item.getAttribute('aria-checked') !== 'true') return false;
       item.click(); return true;`,
      { label: "hide from the microphone's menu" },
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceInDock === false && dockVoice() === 'hidden';`,
      { label: "the microphone shrunk out of the dock" },
    );
    // Its shortcut still turns voice on, and the microphone shows meanwhile.
    await shortcut("toggle-voice");
    await runWait(
      `return dockVoice() === 'shown' && mic().dataset.phase !== 'off';`,
      {
        timeoutMs: 30_000,
        label: "voice on by its shortcut, the microphone back",
      },
    );
    await shortcut("toggle-voice");
    await runWait(`return dockVoice() === 'hidden';`, {
      timeoutMs: 30_000,
      label: "voice off by its shortcut, the microphone gone again",
    });
    // The arrows' menu always offers it.
    await run(`
      const arrows = $('[data-dock-arrows]');
      const bounds = arrows.getBoundingClientRect();
      arrows.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2,
      }));
      return true;
    `);
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Show voice in dock');
       if (!item || item.getAttribute('aria-checked') !== 'false') return false;
       item.click(); return true;`,
      { label: "show from the arrows' menu" },
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceInDock === true && dockVoice() === 'shown' && mic().dataset.phase === 'off';`,
      { label: "the microphone back in the dock" },
    );
  }, 120_000);

  it("in push to talk, hears only while its keys are held, even in a web page", async () => {
    await openPage();
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Push to talk');
       if (!item) return false; item.click(); return true;`,
      { label: "push to talk from the microphone's menu" },
    );
    await runWait(`return (await api.getPrefs()).voicePushToTalk === true;`, {
      label: "push to talk on",
    });
    await run(`mic().click(); return true;`);
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       const prefs = await api.getPrefs();
       return status.phase === 'listening' && prefs.assistantSession;`,
      { timeoutMs: 30_000, label: "listening, for the keys" },
    );
    const heard = () =>
      run<number>(
        `const detail = await session(${JSON.stringify(ref)});
         return detail.messages.filter((m) => m.role === 'user').length;`,
      );
    const before = await heard();
    // The scripted person talks a moment after the microphone opens; with
    // no keys held, none of it becomes a message.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await heard()).toBe(before);
    await holdPushToTalk("keyDown");
    await runWait(`return mic().dataset.phase === 'hearing';`, {
      label: "hearing while the keys are down",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await holdPushToTalk("keyUp");
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.filter((m) => m.role === 'user').length === ${before + 1};`,
      { timeoutMs: 30_000, label: "heard as the keys came up" },
    );
    await run(`mic().click(); return true;`);
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off",
    });
    await openMenu();
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Push to talk');
       if (!item) return false; item.click(); return true;`,
      { label: "push to talk off again" },
    );
  }, 120_000);
});
