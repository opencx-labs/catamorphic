import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end('<title>Chat preview</title><input aria-label="Preview input">');
});

async function clickMessageLink(modifiers = 0) {
  await app.waitFor(
    `(() => {
    const link = document.querySelector('.cat-markdown a[href="${origin}/preview"]');
    const r = link?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 && link.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })()`,
    { label: "message link is visible and receives input" },
  );
  await app.eval(
    `Promise.all(document.querySelector('[data-chat-local-id]').getAnimations().map(animation => animation.finished.catch(() => {})))`,
  );
  const point = await app.eval<{ x: number; y: number }>(`(() => {
    const link = document.querySelector('.cat-markdown a[href="${origin}/preview"]');
    link.scrollIntoView({block:'center'});
    const r = link.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
      modifiers,
    });
  }
}

const clickButton = (label: string) =>
  app.eval(
    `document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`,
  );
const chatTab = '[data-point-key^="chat:"]';
const bubble = "[data-chat-bubble] button[aria-expanded]";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.waitFor("!!document.querySelector('[data-sidebar=left]')");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Chat state',rootPath:${JSON.stringify(`${app.userDataDir}/chat-state`)}})`,
  );
  await app.eval("window.__beforeChatStateReload = true; location.reload()");
  await app.waitFor(
    "!window.__beforeChatStateReload && !!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
  await app.eval(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))",
  );
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat] [data-composer-input]')",
  );
  await app.eval(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'m',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),shiftKey:true,bubbles:true}))",
  );
  await app.waitFor(
    "!document.querySelector('[data-floating-chat]') && !!document.querySelector('[data-chat-local-id] [data-composer-input]')",
  );
});

afterAll(async () => {
  await app?.stop();
  server.close();
});

it("settles a new chat and shows Option-click previews above the chat", async () => {
  await app.eval(`(() => { ${setReactValueJs}
    const input = document.querySelector('[data-chat-local-id] [data-composer-input]');
    setReactValue(input, ${JSON.stringify(`[Preview](${origin}/preview)`)});
    input.closest('form').requestSubmit();
  })()`);
  await app.waitFor(
    `!!document.querySelector('.cat-markdown a[href="${origin}/preview"]')`,
  );
  await app.waitFor(
    "!document.querySelector('[data-chat-local-id]').textContent.includes('Sending message')",
  );
  await app.waitFor(
    '!!document.querySelector(\'[aria-label*="Session status:"][aria-label*="Ready"]\')',
  );
  await clickMessageLink(1);
  await app.waitFor(
    "!!document.querySelector('[data-floating-surface] webview')",
  );
  await app.waitFor(
    `(() => {
    const pane=document.querySelector('[data-floating-surface]');
    const r=pane.getBoundingClientRect();
    return pane.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })()`,
    { label: "floating browser receives input above the full chat" },
  );
  await app.waitFor(
    `(() => {
    const pane=document.querySelector('[data-floating-surface]');
    const r=pane.getBoundingClientRect();
    return !!document.elementFromPoint(r.x-5,r.y+r.height/2)?.closest('[data-floating-backdrop]');
  })()`,
    { label: "floating backdrop shields the chat" },
  );
  await app.eval(
    "document.querySelector('[aria-label=\"Dismiss floating panel\"]').click()",
  );
  await app.waitFor("!document.querySelector('[data-floating-surface]')");
  expect(
    await app.eval(
      "!!document.querySelector('[data-chat-local-id] [data-composer-input]')",
    ),
  ).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});

it.each([
  { label: "normal click", modifiers: 0 },
  { label: "new-tab click", modifiers: process.platform === "darwin" ? 4 : 2 },
])("keeps full-tab chats in the tab bar for $label", async ({ modifiers }) => {
  await clickMessageLink(modifiers);
  await app.waitFor(
    "!!document.querySelector('[data-workspace-slot=full] webview')",
  );
  expect(await app.eval(`!!document.querySelector('${chatTab}')`)).toBe(true);
  expect(await app.eval(`!!document.querySelector('${bubble}')`)).toBe(false);
  expect(
    await app.eval("!!document.querySelector('[data-floating-chat]')"),
  ).toBe(false);
  await app.eval(`document.querySelector('${chatTab} button').click()`);
  await app.waitFor(
    "!!document.querySelector('[aria-label=\"Pop out to floating chat\"]')",
  );
});

it("opens floating previews from a collapsed chat tab group", async () => {
  await clickButton("Collapse grouped tabs");
  await app.waitFor(
    '!!document.querySelector(\'[aria-label^="Expand "][aria-label$=" grouped tabs"]\')',
  );
  await clickMessageLink(1);
  await app.waitFor(
    "!!document.querySelector('[data-floating-surface] webview')",
  );
  await clickButton("Dismiss floating panel");
  await app.waitFor("!document.querySelector('[data-floating-surface]')");
  await app.eval(
    'document.querySelector(\'[aria-label^="Expand "][aria-label$=" grouped tabs"]\').click()',
  );
});

it("preserves floating chats, their draft, and their bubble when opening links", async () => {
  await clickButton("Pop out to floating chat");
  await app.waitFor("!!document.querySelector('[data-floating-chat]')");
  await app.waitFor(
    `!!document.querySelector('${bubble}[aria-expanded=true]')`,
  );
  await app.eval(`(() => { ${setReactValueJs}
    setReactValue(document.querySelector('[data-floating-chat] [data-composer-input]'), 'Keep this draft');
  })()`);
  await clickMessageLink();
  await app.waitFor(
    "!!document.querySelector('[data-workspace-slot=full] webview')",
  );
  expect(
    await app.eval("!!document.querySelector('[data-floating-chat]')"),
  ).toBe(true);
  expect(
    await app.eval(`!!document.querySelector('${bubble}[aria-expanded=true]')`),
  ).toBe(true);
  await clickButton("Minimize chat to bubble");
  await app.waitFor("!document.querySelector('[data-floating-chat]')");
  await app.eval(`document.querySelector('${bubble}').click()`);
  await app.waitFor("!!document.querySelector('[data-floating-chat]')");
  expect(
    await app.eval(
      "document.querySelector('[data-floating-chat] [data-composer-input]').textContent",
    ),
  ).toBe("Keep this draft");
  await clickMessageLink(1);
  await app.waitFor(
    "!!document.querySelector('[data-floating-surface] webview') && !document.querySelector('[data-floating-chat]')",
  );
  expect(
    await app.eval(
      `!!document.querySelector('${bubble}[aria-expanded=false]')`,
    ),
  ).toBe(true);
  await app.screenshot("/tmp/chat-link-floating-preview.png");
  // The bubble itself restores the chat and dismisses the resource preview.
  await app.eval(`document.querySelector('${bubble}').click()`);
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat]') && !document.querySelector('[data-floating-surface]')",
  );
  expect(
    await app.eval(
      "document.querySelector('[data-floating-chat] [data-composer-input]').textContent",
    ),
  ).toBe("Keep this draft");
  await app.waitFor(
    "getComputedStyle(document.querySelector('[data-floating-chat]')).opacity === '1'",
  );
  await app.screenshot("/tmp/chat-link-restored-dock.png");
  await clickButton("Open as tab");
  await app.waitFor("!document.querySelector('[data-floating-chat]')");
});

it("opens beside a full chat and does not let an old expansion undo new navigation", async () => {
  await clickMessageLink((process.platform === "darwin" ? 4 : 2) | 8);
  await app.waitFor(
    "!!document.querySelector('[aria-label=\"Full width\"]') && !!document.querySelector('[data-workspace-slot=right] webview')",
  );
  await app.screenshot("/tmp/chat-link-split.png");
  await app.eval(`(() => { ${setReactValueJs}
    const input = document.querySelector('[data-chat-local-id] [data-composer-input]');
    setReactValue(input, 'Respond slowly while I read the page beside you');
    input.closest('form').requestSubmit();
  })()`);
  await app.waitFor(
    '!!document.querySelector(\'[aria-label*="Session status:"][aria-label*="Working"]\')',
  );
  await app.waitFor(
    '!!document.querySelector(\'[aria-label*="Session status:"][aria-label*="Ready"]\')',
  );
  expect(
    await app.eval(
      "window.catamorphicDesktop.getPrefs().then(prefs => prefs.unreadSessionIds ?? [])",
    ),
  ).toEqual([]);
  // Expand and navigate before its 220ms exit finishes. Separate turns let
  // React commit the expanding layout, reproducing the stale timer race.
  await clickButton("Full width");
  await app.eval(
    `document.querySelector('.cat-markdown a[href="${origin}/preview"]').click()`,
  );
  await app.waitFor(
    "!!document.querySelector('[data-workspace-slot=full] webview')",
  );
  await app.eval("new Promise(resolve => setTimeout(resolve, 350))");
  expect(
    await app.eval(
      "!!document.querySelector('[data-workspace-slot=full] webview')",
    ),
  ).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});
