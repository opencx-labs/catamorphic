import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";
import { CHATS_SECTION, writeSidebarSections } from "./sidebar-config.js";

let app: AppHandle;
let sessions: string[];
let base: string;
const chat = "section[data-chat-local-id]:not([inert], [inert] *)";
const loading = `${chat} [role="status"][aria-label="Loading conversation"]`;
const message = "History saved on this computer";
const screenshot = (name: string) =>
  app.screenshot(
    path.join(process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp", name),
  );

beforeAll(async () => {
  app = await launchApp();
  await writeSidebarSections(app, [CHATS_SECTION]);
  const seeded = await app.eval<{ base: string; sessions: string[] }>(
    `(async () => {
    const api = window.catamorphicDesktop;
    const project = await api.createProject({name:'Offline chats',rootPath:${JSON.stringify(`${app.userDataDir}/offline-chats`)}});
    const agent = await api.agentsCreate({name:'Local helper',harness:'codex',model:'fake-model-a'});
    await api.agentsSetDefault(agent.id);
    const {url} = await api.getServerState();
    const base = url+'/api/projects/'+project.id+'/agent/sessions';
    const sessions = [];
    for (const title of ['Local history', 'Load failure']) {
      const created = await fetch(base, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:agent.id,title,source:'desktop'})});
      if (!created.ok) throw new Error(await created.text());
      const session = await created.json();
      sessions.push(session.id);
      const sent = await fetch(base+'/'+session.id+'/commands', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',commandId:crypto.randomUUID(),text:${JSON.stringify(message)}})});
      if (!sent.ok) throw new Error(await sent.text());
    }
    return {base,sessions};
  })()`,
  );
  ({ base, sessions } = seeded);
  await app.waitFor(
    `(async () => {
    const details = await Promise.all(${JSON.stringify(sessions)}.map(id => fetch(${JSON.stringify(base)}+'/'+id).then(r=>r.json())));
    return details.every(detail => detail.snapshot.items.some(item => item.kind === 'assistant_message' && item.text.includes('You said:')) && detail.snapshot.turns.every(turn => turn.status === 'completed'));
  })()`,
    { label: "local transcripts persisted before opening a chat" },
  );
  // Install before the provider captures fetch. The test can interrupt a
  // real session stream without relying on OS connectivity or heartbeats.
  await app.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const fetch = globalThis.fetch.bind(globalThis);
      const state = {offline:false, streams:[]};
      globalThis.__sessionTransport = state;
      globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (!path.includes('/agent/sessions/') || !path.endsWith('/events')) return fetch(request);
        if (state.offline) return Promise.reject(new TypeError('Failed to fetch'));
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal]);
        state.streams.push({controller,signal});
        return fetch(new Request(request,{signal}));
      };
    })()`,
  });
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await app.waitFor(
    `${JSON.stringify(sessions)}.every(id => document.querySelector('aside [data-session-id="'+id+'"] [data-sidebar-item-id]'))`,
    { label: "persisted chats are listed in the sidebar" },
  );
  await focusWindow(app);
});

afterAll(async () => {
  await app?.stop();
});

async function openFromSidebar(sessionId: string) {
  const selector = `aside [data-session-id="${sessionId}"] [data-tree-primary]`;
  await app.waitFor(
    `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row) return false;
    row.scrollIntoView({block:'center'});
    const r = row.getBoundingClientRect();
    return r.width && r.height && row.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) ? {x:r.x+r.width/2,y:r.y+r.height/2} : false;
  })()`,
    { label: "sidebar chat receives input" },
  );
  await app.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await app.waitFor(`!!document.querySelector(${JSON.stringify(chat)})`, {
    label: "sidebar click opens the conversation surface",
  });
}

it("opens uncached local history from the sidebar offline, with a centered loading spinner", async () => {
  // Only the renderer's connectivity hint changes. Loopback stays reachable,
  // exactly as it does when the computer loses internet access.
  await app.eval("window.dispatchEvent(new Event('offline'))");
  const paused: string[] = [];
  const unsubscribe = app.onCdpEvent("Fetch.requestPaused", (event) => {
    if (
      event &&
      typeof event === "object" &&
      "requestId" in event &&
      typeof event.requestId === "string"
    )
      paused.push(event.requestId);
  });
  await app.cdp("Fetch.enable", {
    patterns: [
      { urlPattern: `${base}/${sessions[0]}`, requestStage: "Request" },
    ],
  });
  try {
    await openFromSidebar(sessions[0] ?? "");
    await expect
      .poll(() => paused.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await app.waitFor(`!!document.querySelector(${JSON.stringify(loading)})`);
    const state = await app.eval<{
      centered: boolean;
      text: string;
      motion: string;
    }>(`(() => {
      const spinner = document.querySelector(${JSON.stringify(loading)});
      const log = spinner.closest('[role="log"]');
      const s = spinner.getBoundingClientRect(), r = log.getBoundingClientRect();
      return {centered:Math.abs((s.x+s.width/2)-(r.x+r.width/2))<10 && Math.abs((s.y+s.height/2)-(r.y+r.height/2))<40, text:log.textContent, motion:getComputedStyle(spinner.querySelector('svg')).animationName};
    })()`);
    expect(state.centered).toBe(true);
    expect(state.text).toBe("");
    expect(state.motion).not.toBe("none");
    await screenshot("offline-chat-loading.png");
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector(${JSON.stringify(loading)})?.querySelector('svg')).animationName`,
      ),
    ).toBe("none");
    for (const requestId of paused)
      await app.cdp("Fetch.continueRequest", { requestId });
  } finally {
    await app.cdp("Fetch.disable");
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
    unsubscribe();
  }
  await app.waitFor(
    `document.querySelector(${JSON.stringify(chat)})?.textContent.includes(${JSON.stringify(`You said: ${message}`)})`,
    { label: "local history appears while offline" },
  );
  expect(
    await app.eval(`!!document.querySelector(${JSON.stringify(loading)})`),
  ).toBe(false);
  await screenshot("offline-chat-loaded.png");
  expect(app.getRendererErrors()).toEqual([]);
});

it("shows a failed history load without the empty prompt and recovers while still offline", async () => {
  await app.blockRequests([`${base}/${sessions[1]}`]);
  try {
    await openFromSidebar(sessions[1] ?? "");
    await app.waitFor(
      `!!document.querySelector('${chat} [role="log"] [role="alert"]')`,
      { label: "history load failure is visible" },
    );
    expect(
      await app.eval(`!!document.querySelector(${JSON.stringify(loading)})`),
    ).toBe(false);
    expect(
      await app.eval(
        `!!document.querySelector('${chat} [role="log"] .m-auto')`,
      ),
    ).toBe(false);
    await screenshot("offline-chat-load-error.png");
  } finally {
    await app.blockRequests([]);
  }
  await app.waitFor(
    `document.querySelector(${JSON.stringify(chat)})?.textContent.includes(${JSON.stringify(`You said: ${message}`)})`,
    { label: "history load recovers without going online" },
  );
  await app.waitFor(
    `!document.querySelector('${chat} [role="log"] [role="alert"]')`,
  );
  await app.eval("window.dispatchEvent(new Event('online'))");
  expect(app.getRendererErrors()).toEqual([]);
});

it("shows clear connection status for an interrupted stream and retains the conversation", async () => {
  await app.waitFor(
    "window.__sessionTransport.streams.some(stream => !stream.signal.aborted)",
    {
      label: "a live session stream before interruption",
    },
  );
  try {
    await app.eval(`(() => {
      window.__sessionTransport.offline = true;
      for (const {controller} of window.__sessionTransport.streams) controller.abort();
    })()`);
    await app.waitFor(
      `document.querySelector(${JSON.stringify(chat)})?.textContent.includes('Waiting for connection. Reconnecting…')`,
      { label: "explicit connection status after the stream disconnects" },
    );
    expect(
      await app.eval(
        `document.querySelector(${JSON.stringify(chat)})?.textContent.includes(${JSON.stringify(message)})`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `document.querySelector(${JSON.stringify(chat)})?.textContent.includes('No updates')`,
      ),
    ).toBe(false);
    await screenshot("offline-chat-reconnecting.png");
  } finally {
    await app.eval("window.__sessionTransport.offline = false");
  }
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(chat)})?.textContent.includes('Waiting for connection. Reconnecting…')`,
    { label: "connection status clears after reconnecting" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
