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
 * Push-to-talk through the audio page and speech worker, end to end with
 * scripted recognition: capture while held, final words on release, then
 * a spoken reply with the microphone closed. Session tools, notifications,
 * chat targeting, read aloud and screen context follow their normal paths.
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
  "that's all, stop listening",
  // Held and let go with nothing said.
  "",
  "what was on my screen",
];
/** The assistant's own tools over the person's chats. */
const ASSISTANT_SESSION_TOOLS = [
  "answer_question",
  "follow_session",
  "list_sessions",
  "message_session",
  "read_session",
  "stop_session",
];

let app: AppHandle;
/** A web page to hold voice's keys in. */
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
  const dockVoice = () => mic()?.closest('[data-dock-voice]')?.dataset.dockVoice;
  const api = window.catamorphicDesktop;
  const session = async (ref, path = '') => {
    const { url } = await api.getServerState();
    const response = await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId + path);
    const body = await response.json();
    // A chat's transcript is its snapshot's message items (ADR 0197): the
    // person's, others' (the assistant's among them) and the task
    // notifications it got (ADR 0217).
    const roles = { user_message: 'user', inbound_message: 'inbound', assistant_message: 'assistant', task_notification: 'notification' };
    if (body?.snapshot)
      body.messages = [...body.snapshot.items]
        .filter((item) => item.kind in roles)
        .sort((a, b) => a.position - b.position)
        .map((item) => ({
          role: roles[item.kind],
          content: item.kind === 'task_notification' ? item.summary : item.text,
        }));
    return body;
  };
  /** Types a message into a chat, as its composer would send it. */
  const sendText = async (ref, text, dispatch) => {
    const { url } = await api.getServerState();
    await fetch(url + '/api/projects/' + ref.projectId + '/agent/sessions/' + ref.sessionId + '/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'send', commandId: crypto.randomUUID(), text, ...(dispatch ? { dispatch } : {}) }),
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
    window.__voiceStatusLog = [];
    window.__voiceUnsubscribe?.();
    window.__voiceUnsubscribe = api.onVoiceStatus(status => window.__voiceStatusLog.push({phase:status.phase,at:Date.now()}));
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

/**
 * Talk to Work's default keys going down or up in the web page: through
 * the page's real input path, which main reads first.
 */
function holdTalkKeys(type: "keyDown" | "keyUp") {
  const cmd = process.platform === "darwin" ? "meta" : "control";
  return app.eval(`(() => {
    const view = document.querySelector('webview');
    view.focus();
    view.sendInputEvent({ type: '${type}', keyCode: 'Space', modifiers: ['${cmd}', 'shift'] });
    return true;
  })()`);
}

/** Opens a browser tab on the test page, once. */
async function openPage() {
  const address = page.address();
  if (!address || typeof address === "string") throw new Error("No page");
  const open = await app.eval<boolean>(
    `(() => { try { return document.querySelector('webview')?.getTitle() === 'Talk page'; } catch { return false; } })()`,
  );
  if (open) return;
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

/** Open a menu through real input, keeping native hover and focus in step. */
async function openMenu(target = "mic()") {
  await focusWindow(app);
  const point = await runWait<{ x: number; y: number }>(
    `return hitPoint(${target});`,
    { label: "the voice menu's hit target" },
  );
  await app.movePointer(point);
  await run(`
    window.__voiceMenuPress = null;
    document.addEventListener('pointerdown', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      window.__voiceMenuPress = {label:button?.getAttribute('aria-label'),arrows:button?.hasAttribute('data-dock-arrows'),testid:button?.dataset.testid,x:event.clientX,y:event.clientY};
    }, {once:true,capture:true});
    return true;
  `);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "right",
      clickCount: 1,
    });
  await runWait(`return !!$('[role="menu"]');`, {
    label: "voice menu after the right press",
  }).catch(async (cause: unknown) => {
    const detail = await run(`return {
      press:window.__voiceMenuPress,status:await api.voiceStatus(),
      target:${target}?.getBoundingClientRect().toJSON()
    };`);
    throw new Error(`${String(cause)}; menu input: ${JSON.stringify(detail)}`);
  });
}

/** A DOM click leaves the real pointer over a different submenu's row. */
async function clickMenuItem(expression: string, label: string) {
  const point = await runWait<{ x: number; y: number }>(
    `return hitPoint(${expression});`,
    { label },
  );
  await app.clickPointer(point);
}

/** Press or release a microphone through Chromium's actual pointer path. */
async function microphone(
  type: "mousePressed" | "mouseReleased",
  button = "mic()",
) {
  const point = await runWait<{ x: number; y: number }>(
    `const button = ${button};
     if (!button) return false;
     if (${JSON.stringify(type)} === 'mousePressed') return hitPoint(button);
     const box = button.getBoundingClientRect();
     return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`,
    { label: "the microphone's hit target" },
  );
  if (type === "mousePressed") await app.movePointer(point);
  await app.cdp("Input.dispatchMouseEvent", {
    type,
    button: "left",
    clickCount: 1,
    ...point,
  });
}

/** A complete scripted utterance needs at least 1.5 seconds of captured audio. */
async function capturedSpeech() {
  const audio = await app.connectToFrame("voice.html");
  try {
    const before = await audio.eval<number>(`(() => {
      if (window.__voiceCapturedSeconds === undefined) {
        window.__voiceCapturedSeconds = 0;
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...args) {
          if (message?.type === 'frame')
            window.__voiceCapturedSeconds += message.samples.length / message.sampleRate;
          return Reflect.apply(post, this, [message, ...args]);
        };
      }
            return window.__voiceCapturedSeconds;
    })()`);
    await audio.waitFor(`window.__voiceCapturedSeconds >= ${before + 1.7}`, {
      timeoutMs: 30_000,
      label: "the full scripted phrase captured",
    });
  } finally {
    audio.close();
  }
}

/** Talk once: the assistant's chat holds the utterance and the spoken reply. */
async function talk(
  utterance: string,
  reply: string,
  key?: "Space" | "Enter",
): Promise<Ref> {
  await recordPhases();
  const input = async (held: boolean) => {
    if (!key) {
      await microphone(held ? "mousePressed" : "mouseReleased");
      return;
    }
    if (held) await run(`mic().focus(); return true;`);
    await app.cdp("Input.dispatchKeyEvent", {
      type: held ? "keyDown" : "keyUp",
      key: key === "Space" ? " " : key,
      code: key,
      windowsVirtualKeyCode: key === "Space" ? 32 : 13,
    });
  };
  const captureProbe = await app.connectToFrame("voice.html");
  await captureProbe.eval(`(() => {
    if (!window.__captureTimingInstalled) {
      window.__captureTimingInstalled = true;
      // Keep device startup separate from Work's press-to-capture handoff.
      window.addEventListener('message', event => {
        if (event.source === window && event.ports.length)
          window.__captureStages.portAt = Date.now();
      });
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stages = window.__captureStages;
        stages.inputRequestedAt = Date.now();
        const stream = await getUserMedia(...args);
        stages.inputOpenedAt = Date.now();
        return stream;
      };
      const resume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = async function(...args) {
        const stages = window.__captureStages;
        if (this.sampleRate === 16000) stages.graphRequestedAt ??= Date.now();
        await Reflect.apply(resume, this, args);
        if (this.sampleRate === 16000) stages.graphResumedAt ??= Date.now();
      };
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'capturing' && !window.__captureFirstAt)
          window.__captureFirstAt = Date.now();
        if (message?.type === 'drained') window.__lastVoiceDrainedAt = Date.now();
        return Reflect.apply(post, this, [message, ...args]);
      };
    }
    window.__captureStages = {};
    window.__captureFirstAt = 0;
    window.__lastVoiceDrainedAt = 0;
    return true;
  })()`);
  // Readiness and pointer positioning happen before the press, not in its latency.
  await run(`
    window.__voicePressedAt = 0;
    window.addEventListener(${JSON.stringify(key ? "keydown" : "pointerdown")}, () => {
      window.__voicePressedAt = Date.now();
    }, {once:true,capture:true});
    return true;
  `);
  await input(true);
  const ref = await runWait<Ref>(
    `const status = await api.voiceStatus();
     const prefs = await api.getPrefs();
     return status.phase === 'hearing' && prefs.assistantSession;`,
    {
      timeoutMs: 30_000,
      label: "the assistant hearing while the microphone is held",
    },
  );
  await capturedSpeech();
  const pressedAt = await run<number>("return window.__voicePressedAt;");
  const capturedAt = await captureProbe.eval<number>("window.__captureFirstAt");
  expect(pressedAt).toBeGreaterThan(0);
  const captureDelay = capturedAt - pressedAt;
  const stages = await captureProbe.eval<Record<string, number>>(
    "window.__captureStages",
  );
  const timing = {
    ...Object.fromEntries(
      Object.entries(stages).map(([stage, at]) => [stage, at - pressedAt]),
    ),
    firstFrame: captureDelay,
  };
  // Print before asserting so a slow native runner retains its startup stages.
  console.info(
    "Voice capture startup (ms from press):",
    JSON.stringify(timing),
  );
  expect(captureDelay).toBeGreaterThanOrEqual(0);
  expect(captureDelay, JSON.stringify(timing)).toBeLessThan(500);
  await input(false);
  await runWait(
    `const detail = await session(${JSON.stringify(ref)});
     return detail.messages?.some((m) => m.role === 'user' && m.content === ${JSON.stringify(utterance)}) &&
       detail.messages.some((m) => m.role === 'assistant' && m.content.startsWith(${JSON.stringify(reply)}));`,
    {
      timeoutMs: 30_000,
      label: "the released utterance and its answer in the assistant's chat",
    },
  );
  await runWait(
    `const phases = window.__voicePhases;
     return phases.includes('speaking') && phases.at(-1) === 'off';`,
    { timeoutMs: 30_000, label: "the answer spoken, then voice off" },
  );
  const lastDrainedAt = await captureProbe.eval<number>(
    "window.__lastVoiceDrainedAt",
  );
  captureProbe.close();
  const statusLog = await run<{ phase: string; at: number }[]>(
    "return window.__voiceStatusLog;",
  );
  const settledAt =
    statusLog.filter((entry) => entry.phase === "off").at(-1)?.at ?? 0;
  expect(lastDrainedAt).toBeGreaterThan(0);
  expect(settledAt - lastDrainedAt).toBeGreaterThanOrEqual(0);
  expect(settledAt - lastDrainedAt).toBeLessThan(750);
  expect(statusLog.map((entry) => entry.phase)).not.toContain("listening");
  return ref;
}

describe("voice", () => {
  it("boots into a project with the microphone in the dock", async () => {
    await openProjectSwitcher(app);
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(`byText('button', 'New project').click(); return true;`);
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
    await waitForProjectWorkspace({ app, name: "voice-e2e" });
    await runWait(`return mic()?.dataset.phase === 'off';`, {
      timeoutMs: 60_000,
      label: "microphone in the dock, off",
    });
  }, 180_000);

  let first: Ref;

  it("holds the focused microphone with Space, hears the person and speaks", async () => {
    first = await talk(
      UTTERANCES[0] ?? "",
      "It's started. I'll tell you when it's done.",
      "Space",
    );
    const phases = await run<string[]>(`return window.__voicePhases;`);
    expect(phases.slice(0, 2)).toEqual(["off", "preparing"]);
    expect(phases).toEqual(
      expect.arrayContaining(["hearing", "thinking", "speaking", "off"]),
    );
    // The bars followed the voice as it was heard, well above the working
    // wave's dots.
    expect(await run<number>(`return window.__voiceLoudest;`)).toBeGreaterThan(
      0.5,
    );
    expect(
      await run<boolean>(
        `return !mic().hasAttribute('aria-pressed') && mic().getAttribute('aria-label')?.startsWith('Hold to talk');`,
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
    // Its result comes back to the assistant on its own, as a task
    // notification (ADR 0217), which it answers.
    await runWait(
      `const detail = await session(${JSON.stringify(first)});
       return detail.messages.some((m) => m.role === 'notification' && m.content.endsWith(' finished')) &&
         detail.messages.some((m) => m.role === 'assistant' && m.content.startsWith('Read it: '));`,
      {
        timeoutMs: 30_000,
        label: "the delegated result answered in the assistant's chat",
      },
    );
    await runWait(`return mic().dataset.phase === 'off';`, {
      timeoutMs: 30_000,
      label: "voice off after the result",
    });
  }, 120_000);

  it("release closes capture and keeps the chat for next time", async () => {
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off",
    });
    const prefs = await run<{ assistantSession: Ref | null }>(
      `return api.getPrefs();`,
    );
    expect(prefs.assistantSession).toEqual(first);
    const audio = await app.connectToFrame("voice.html");
    try {
      await audio.eval("window.__voiceWarmMarker = 'kept'; true");
      const captured = await audio.eval<number>(
        "window.__voiceCapturedSeconds",
      );
      // Wait a few frame intervals with voice off: capture must stay closed.
      await audio.eval("new Promise(resolve => setTimeout(resolve, 200))");
      expect(await audio.eval("window.__voiceCapturedSeconds")).toBe(captured);
    } finally {
      audio.close();
    }
  }, 60_000);

  it("the microphone's menu opens the assistant's chat and picks the voice and microphone", async () => {
    // Voices are a submenu, named, with who they are beside the name.
    await openMenu();
    await clickMenuItem(
      `byText('[role="menuitem"][data-submenu]', 'Voice')`,
      "open the Voice submenu",
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
    await clickMenuItem(
      `byText('[role="menuitemradio"]', 'Michael')`,
      "choose Michael",
    );
    // The built-in assistant speaks in the default voice.
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceId === 'am_michael' && !$('[role="menuitemradio"]');`,
      { label: "the new voice kept, the menu closed" },
    );
    // Microphones too: the system's, then each one the machine has.
    await openMenu();
    await clickMenuItem(
      `byText('[role="menuitem"][data-submenu]', 'Microphone')`,
      "open the Microphone submenu",
    );
    const microphones = await runWait<string[]>(
      `const items = $$('[role="menu"][aria-label="Microphone"] [role="menuitemradio"]');
       return items.length > 1 && items.map((item) => item.textContent.trim() + ':' + item.getAttribute('aria-checked'));`,
      { label: "the microphones in the submenu" },
    );
    expect(microphones[0]).toBe("System default:true");
    await clickMenuItem(
      `$$('[role="menu"][aria-label="Microphone"] [role="menuitemradio"]')[1]`,
      "choose the microphone",
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return typeof prefs.voiceMicrophone === 'string';`,
      { label: "the chosen microphone kept" },
    );
    await openMenu();
    await clickMenuItem(
      `byText('[role="menuitem"]', 'Open assistant chat')`,
      "open the assistant's chat from the menu",
    );
    // It opens like any chat, with what was said and answered.
    await runWait(
      `return !!$('[data-session-id="${first.sessionId}"]') &&
         !!byText('*', 'start a session to tidy the docs');`,
      { label: "the assistant's chat open in the dock" },
    );
  }, 60_000);

  it("reset closes the assistant's chat, and holding Enter starts a new one", async () => {
    await openMenu();
    await clickMenuItem(
      `byText('[role="menuitem"]', 'Reset assistant chat')`,
      "reset from the microphone's menu",
    );
    await runWait(
      `const prefs = await api.getPrefs();
       const old = await session(${JSON.stringify(first)});
       return prefs.assistantSession === null && old.status === 'closed';`,
      { label: "old assistant chat closed and forgotten" },
    );
    // The new chat has the person's agent's tools, with the assistant's
    // session tools in place of Work's project-only ones.
    const second = await talk(UTTERANCES[1] ?? "", "Tools: ", "Enter");
    const audio = await app.connectToFrame("voice.html");
    try {
      expect(await audio.eval("window.__voiceWarmMarker")).toBe("kept");
    } finally {
      audio.close();
    }
    const tools = await run<string[]>(
      `const detail = await session(${JSON.stringify(second)});
       const reply = detail.messages.find((m) => m.role === 'assistant' && m.content.startsWith('Tools: '));
       return reply.content.slice('Tools: '.length).split(', ');`,
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        ...ASSISTANT_SESSION_TOOLS,
        // It starts sessions like any agent (ADR 0271).
        "spawn_subsession",
        "open_surface",
        // What was on screen as the person spoke, at once (ADR 0265).
        "screen_when_spoken",
        "stop_listening",
        "update_todo_list",
      ]),
    );
    expect(tools).not.toContain("wait_for_subsessions");
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.projectId).toBe(first.projectId);
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
       return detail.messages?.some((m) => m.role === 'inbound' && m.content === 'add a changelog entry');`,
      { label: "the person's own chat got the assistant's message" },
    );
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off at the end",
    });
  }, 120_000);

  it("hears a session's notes as it works, as one task notification", async () => {
    const { assistantSession: ref } = await run<{ assistantSession: Ref }>(
      `return api.getPrefs();`,
    );
    await run(
      `await sendText(${JSON.stringify(ref)}, 'start a session that reports as it goes'); return true;`,
    );
    const note = await runWait<{ text: string; notice: unknown }>(
      `const detail = await session(${JSON.stringify(ref)});
       const item = detail.snapshot.items.find((item) =>
         item.kind === 'task_notification' && item.task.type === 'followed_session');
       return item && { text: item.detail, notice: item.summary };`,
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
       return detail.snapshot.items.some((item) => item.kind === 'task_notification' && item.detail.includes('Two pages are stale.'));`,
      { timeoutMs: 30_000, label: "the session's result delivered" },
    );
    const notes = await run<number>(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.snapshot.items.filter((item) => item.kind === 'task_notification' && item.task.type === 'followed_session').length;`,
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
         item.kind === 'task_notification' && item.summary === 'Layout: a question')?.detail;`,
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
       const asked = detail.snapshot.items.find((item) => item.kind === 'task_notification' && item.summary === 'Layout: a question');
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
    await runWait(`return mic().dataset.phase === 'off';`, {
      label: "microphone off before the question",
    });
    const docs = await runWait<Ref>(
      `const children = await session(${JSON.stringify(ref)}, '/subsessions');
       const child = children.find((c) => c.session.title === 'Docs pages');
       return child && { projectId: ${JSON.stringify(ref.projectId)}, sessionId: child.session.id };`,
      { label: "the session waiting to ask" },
    );
    await run(
      `await sendText(${JSON.stringify(docs)}, 'Ask which pages now', 'steer'); return true;`,
    );
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
    await microphone("mousePressed");
    await runWait(`return mic().dataset.phase === 'hearing';`, {
      timeoutMs: 30_000,
      label: "holding the microphone for the answer",
    });
    await capturedSpeech();
    await microphone("mouseReleased");
    // What the person says meanwhile waits for the news (the main
    // process hands it over once the chat has caught them up).
    await runWait(`return window.__voicePhases.includes('speaking');`, {
      timeoutMs: 30_000,
      label: "the news spoken as voice starts",
    });
    expect(await run(`return mic().dataset.pending ?? null;`)).toBe(null);
    await runWait(
      `const detail = await session(${JSON.stringify(docs)});
       return detail.messages?.some((m) => m.role === 'inbound' && m.content === 'Keep the new ones.');`,
      { timeoutMs: 30_000, label: "the answer passed back to it" },
    );
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
    // Its microphone previews into the composer without consuming typed prose.
    await run(
      `setReactValue(chatOf(${JSON.stringify(localId)}).querySelector('[data-composer-input]'), 'Keep this draft'); return true;`,
    );
    await microphone("mousePressed", `chatMic(${JSON.stringify(localId)})`);
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       return status.phase !== 'off' && status.phase !== 'preparing' &&
         status.target?.kind === 'chat' && chatMic(${JSON.stringify(localId)})?.dataset.lit === 'true' &&
         { projectId: status.target.projectId, sessionId: status.target.sessionId };`,
      { timeoutMs: 30_000, label: "voice on in the chat" },
    );
    expect(await run(`return mic().dataset.phase;`)).toBe("off");
    await capturedSpeech();
    await runWait(
      `const input = chatOf(${JSON.stringify(localId)}).querySelector('[data-composer-input]'); return input.textContent.includes('how am i talking to you') && !!input.querySelector('[data-dictation]');`,
      { label: "live words in the composer before release" },
    );
    expect(await answers("By voice.")).toBe(0);
    await microphone("mouseReleased", `chatMic(${JSON.stringify(localId)})`);
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
    await runWait(
      `return chatOf(${JSON.stringify(localId)}).querySelector('[data-composer-input]').textContent.trim() === 'Keep this draft';`,
      { label: "only the voice preview removed after sending" },
    );
    // Off again, the conversation carries on in text.
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
    await clickMenuItem(
      `byText('[role="menuitem"][data-submenu]', 'Assistant')`,
      "open the Assistant submenu",
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
    await clickMenuItem(
      `byText('[role="menuitemradio"]', 'Other Fake')`,
      "choose Other Fake",
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
    await clickMenuItem(
      `byText('[role="menuitem"][data-submenu]', 'Voice')`,
      "open the Voice submenu",
    );
    await clickMenuItem(
      `byText('[role="menuitemradio"]', 'Bella')`,
      "choose Bella",
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
       return item?.getAttribute('aria-checked') === 'true';`,
      { label: "hide from the microphone's menu" },
    );
    await clickMenuItem(
      `byText('[role="menuitemcheckbox"]', 'Show voice in dock')`,
      "hide from the microphone's menu",
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceInDock === false && dockVoice() === 'hidden';`,
      { label: "the microphone shrunk out of the dock" },
    );
    // Its shortcut still turns voice on, and the microphone shows meanwhile.
    await openPage();
    await holdTalkKeys("keyDown");
    // The previous test changed assistants. Preparing precedes its chat's
    // creation; stopping then can leave the next test reading the old
    // assistantSession while the replacement is still being created.
    await runWait(
      `return dockVoice() === 'shown' && mic().dataset.phase === 'hearing';`,
      {
        timeoutMs: 30_000,
        label: "voice held by its shortcut, the microphone back",
      },
    );
    await capturedSpeech();
    await holdTalkKeys("keyUp");
    await runWait(`return dockVoice() === 'hidden';`, {
      timeoutMs: 30_000,
      label: "voice off by its shortcut, the microphone gone again",
    });
    // The arrows' menu always offers it.
    await openMenu("$('[data-dock-arrows]')");
    await runWait(
      `const item = byText('[role="menuitemcheckbox"]', 'Show voice in dock');
       return item?.getAttribute('aria-checked') === 'false';`,
      { label: "show from the arrows' menu" },
    );
    await clickMenuItem(
      `byText('[role="menuitemcheckbox"]', 'Show voice in dock')`,
      "show from the arrows' menu",
    );
    await runWait(
      `const prefs = await api.getPrefs();
       return prefs.voiceInDock === true && dockVoice() === 'shown' && mic().dataset.phase === 'off';`,
      { label: "the microphone back in the dock" },
    );
  }, 120_000);

  it("talks while its keys are held, even in a web page, and goes off after", async () => {
    await openPage();
    const assistant = await run<Ref>(
      `return (await api.getPrefs()).assistantSession;`,
    );
    const heard = () =>
      run<number>(
        `const detail = await session(${JSON.stringify(assistant)});
         return detail.messages.filter((m) => m.role === 'user').length;`,
      );
    const before = await heard();
    const audio = await app.connectToFrame("voice.html");
    await audio.eval(`(() => {
      window.__heldAudioSeconds=0;
      window.__heldStreams=[];
      const post=MessagePort.prototype.postMessage;
      const devices=navigator.mediaDevices;
      const getMicrophone=devices.getUserMedia;
      // A slow microphone must not turn a fixed wall-clock hold into silence.
      devices.getUserMedia=async function(...args) {
        await new Promise(resolve=>setTimeout(resolve,3000));
        const stream=await Reflect.apply(getMicrophone,this,args);
        window.__heldStreams.push(stream);
        return stream;
      };
      MessagePort.prototype.postMessage=function(message,...args) {
        const result=Reflect.apply(post,this,[message,...args]);
        if(message?.type==='frame')
          window.__heldAudioSeconds+=message.samples.length/message.sampleRate;
        return result;
      };
      window.__restoreHeldAudio=()=>{
        MessagePort.prototype.postMessage=post;
        devices.getUserMedia=getMicrophone;
      };
      return true;
    })()`);
    let held = false;
    try {
      // Down with voice off: it starts, hearing only while held.
      await holdTalkKeys("keyDown");
      held = true;
      await runWait(`return mic().dataset.phase === 'hearing';`, {
        timeoutMs: 30_000,
        label: "hearing while the keys are down",
      });
      // Hearing reports the held intent. Wait for enough real capture to
      // exceed the scripted speech before recognition starts on release.
      await audio.waitFor("window.__heldAudioSeconds>=2.5", {
        timeoutMs: 30_000,
        label: "scripted speech captured while held",
      });
      expect(await heard()).toBe(before);
      await holdTalkKeys("keyUp");
      held = false;
      await audio.waitFor(
        "window.__heldStreams.length>0 && window.__heldStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))",
        {
          timeoutMs: 1500,
          label: "microphone released while recognition and reply continue",
        },
      );
      await runWait(
        `const detail = await session(${JSON.stringify(assistant)});
         return detail.messages.filter((m) => m.role === 'user').length === ${before + 1};`,
        { timeoutMs: 30_000, label: "heard as the keys came up" },
      );
      // Started by holding, voice goes off once it has nothing left to do.
      await runWait(`return mic().dataset.phase === 'off';`, {
        timeoutMs: 60_000,
        label: "voice off once idle",
      });
    } finally {
      try {
        if (held) await holdTalkKeys("keyUp");
      } finally {
        try {
          await audio.eval("window.__restoreHeldAudio();true");
        } finally {
          audio.close();
        }
      }
    }
  }, 120_000);

  it("ends after its agent says goodbye", async () => {
    await recordPhases();
    await microphone("mousePressed");
    const ref = await runWait<Ref>(
      `const status = await api.voiceStatus();
       const prefs = await api.getPrefs();
       return status.phase !== 'off' && status.phase !== 'preparing' && prefs.assistantSession;`,
      { timeoutMs: 30_000, label: "voice on in the assistant's chat" },
    );
    await capturedSpeech();
    await microphone("mouseReleased");
    await runWait(
      `const detail = await session(${JSON.stringify(ref)});
       return detail.messages.some((m) => m.role === 'user' && m.content === ${JSON.stringify(UTTERANCES[9])}) &&
         detail.messages.some((m) => m.role === 'assistant' && m.content === 'Talk soon.');`,
      {
        timeoutMs: 30_000,
        label: "the agent stopped listening and said goodbye",
      },
    );
    await runWait(`return mic().dataset.phase === 'off';`, {
      timeoutMs: 30_000,
      label: "voice off once the goodbye is said",
    });
    const phases = await run<string[]>(`return window.__voicePhases;`);
    // Once the agent took the turn it never listened again: it spoke, and
    // voice went off.
    const thinking = phases.indexOf("thinking", phases.lastIndexOf("hearing"));
    expect(thinking).toBeGreaterThan(0);
    expect(phases.slice(thinking)).toContain("speaking");
    expect(phases.slice(thinking)).not.toContain("listening");
    expect(phases.at(-1)).toBe("off");
    // Turned off cleanly, not stopped by a failure.
    const status = await run<{ error: string | null }>(
      `return api.voiceStatus();`,
    );
    expect(status.error).toBeNull();
  }, 120_000);

  it("goes off as a hold that said nothing is let go, with nothing to show", async () => {
    await openPage();
    const assistant = await run<Ref>(
      `return (await api.getPrefs()).assistantSession;`,
    );
    const heard = () =>
      run<number>(
        `const detail = await session(${JSON.stringify(assistant)});
         return detail.messages.filter((m) => m.role === 'user').length;`,
      );
    const before = await heard();
    await holdTalkKeys("keyDown");
    await runWait(`return mic().dataset.phase === 'hearing';`, {
      timeoutMs: 30_000,
      label: "hearing while the keys are down",
    });
    // The empty scripted phrase still traverses actual microphone capture.
    await capturedSpeech();
    await holdTalkKeys("keyUp");
    const letGo = performance.now();
    await runWait(`return mic().dataset.phase === 'off';`, {
      timeoutMs: 30_000,
      label: "voice off as the keys came up",
    });
    // Not after the wait of a voice that had something to do (4 s).
    expect(performance.now() - letGo).toBeLessThan(3_000);
    expect(await heard()).toBe(before);
    const status = await run<{ error: string | null; pending: boolean }>(
      `return api.voiceStatus();`,
    );
    expect(status).toMatchObject({ error: null, pending: false });
  }, 120_000);

  it("reads a reply aloud from its button, with voice off and the microphone closed", async () => {
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
    // A long answer: about two seconds of speech.
    await run(`const input = chatOf(${JSON.stringify(localId)}).querySelector('[data-composer-input]');
      setReactValue(input, 'pace the work quickly'); input.closest('form').requestSubmit(); return true;`);
    const button = `[...chatOf(${JSON.stringify(localId)}).querySelectorAll('article')]
      .find((el) => el.textContent.includes('Fixed: the lexer'))
      ?.querySelector('[data-testid="chat-read-aloud"]')`;
    await runWait(`return !!${button};`, {
      timeoutMs: 30_000,
      label: "a long reply with its read aloud button",
    });
    // Every reading the windows hear, in order, with when.
    await run(`window.__readings = [];
      window.__readingsOff?.();
      window.__readingsOff = api.onVoiceStatus((status) => {
        const last = window.__readings.at(-1)?.state;
        const state = status.reading ? (status.reading.preparing ? 'preparing' : 'speaking') : 'none';
        if (last !== state) window.__readings.push({ state, at: performance.now() });
        if (status.phase !== 'off') window.__voiceOn = true;
      });
      return true;`);
    const states = () =>
      run<string[]>(
        `return window.__readings.map((reading) => reading.state);`,
      );
    // Pressed again while it plays, it stops at once, long before its end.
    await run(`${button}.click(); return true;`);
    await runWait(`return window.__readings.at(-1)?.state === 'speaking';`, {
      timeoutMs: 30_000,
      label: "the reply playing",
    });
    await run(`${button}.click(); return true;`);
    await runWait(`return window.__readings.at(-1)?.state === 'none';`, {
      label: "reading stopped by a second press",
    });
    expect(await states()).toEqual(["preparing", "speaking", "none"]);
    expect(
      await run<number>(
        `const [, speaking, none] = window.__readings; return none.at - speaking.at;`,
      ),
    ).toBeLessThan(1_500);
    expect(await run(`return ${button}.dataset.reading ?? null;`)).toBeNull();
    // Pressed once, it plays to its end and the button is itself again.
    await run(`window.__readings = []; ${button}.click(); return true;`);
    await runWait(
      `return window.__readings.some((reading) => reading.state === 'speaking') && window.__readings.at(-1)?.state === 'none';`,
      { timeoutMs: 30_000, label: "the reply read to its end" },
    );
    // A late word of the stop before may come first; from the press on:
    const readings = await states();
    expect(readings.slice(readings.indexOf("preparing"))).toEqual([
      "preparing",
      "speaking",
      "none",
    ]);
    expect(await run(`return ${button}.dataset.reading ?? null;`)).toBeNull();
    // Voice stayed off, and its microphone with it.
    expect(await run(`return window.__voiceOn === true;`)).toBe(false);
    expect(await run(`return mic().dataset.phase;`)).toBe("off");
    await run(`window.__readingsOff?.(); return true;`);
  }, 120_000);

  it("keeps what was on screen as the person started speaking, for the agent to load", async () => {
    // Work in front: the picture is its window, as on any machine.
    await focusWindow(app);
    await talk(UTTERANCES[11] ?? "", "Saw 1 picture in Work, as you began.");
    await runWait(`return mic().dataset.phase === 'off';`, {
      timeoutMs: 30_000,
      label: "voice off again",
    });
  }, 120_000);
});
