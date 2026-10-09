import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Cmd+Left and Cmd+Right go back and forward in a browser tab, but a text
 * field keeps them for its caret (the line's start and end), as on macOS
 * everywhere: Work's own fields (the address bar, the chat composer), a
 * page's, and an embedded frame's. Outside a field they still go back and
 * forward, from a frame and from a page that is still loading.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/frame") {
    response.end(
      `<input id="inner" value="inside"><button id="plain">plain</button>`,
    );
    return;
  }
  if (request.url === "/slow") {
    // The document arrives, and stays loading (no dom-ready) for a while.
    response.write("<title>Slow</title><h1>Slow</h1>");
    const finish = setTimeout(() => response.end(), 20_000);
    request.on("close", () => clearTimeout(finish));
    return;
  }
  const page = request.url?.startsWith("/second") ? "Second" : "First";
  response.end(
    `<title>${page}</title><h1>${page}</h1><input id="field" value="hello world"><a id="next" href="/second">next</a><a id="slow" href="/slow">slow</a><iframe src="/frame"></iframe>`,
  );
});

const mac = process.platform === "darwin";
const view = `document.querySelector('webview')`;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);
const loaded = (title: string) =>
  app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === ${JSON.stringify(title)} && !page.isLoading(); } catch { return false; } })()`,
    { label: `${title} loaded` },
  );
/** The key a person presses in Work's window, on what holds focus there. */
const windowKey = (key: string, focus: string) =>
  app.eval<boolean>(`(() => {
    const target = ${focus};
    target.focus();
    const event = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
/** The same key pressed inside the page, through its real input path. */
const pageKey = (keyCode: string) =>
  app.eval(`(() => {
    const page = ${view};
    page.focus();
    for (const type of ['keyDown', 'keyUp'])
      page.sendInputEvent({ type, keyCode: ${JSON.stringify(keyCode)}, modifiers: [${JSON.stringify(mac ? "meta" : "control")}] });
    return true;
  })()`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Caret lab',
    rootPath: ${JSON.stringify(`${app.userDataDir}/caret-lab`)}
  })`);
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Caret lab')`, {
    timeoutMs: 30_000,
    label: "project workspace",
  });
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`${origin}/first`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await loaded("First");
  // A real press on the link, so the page has a back entry.
  const link = await app.eval<{ x: number; y: number }>(`(async () => {
    const box = await ${view}.executeJavaScript("(() => { const r = document.getElementById('next').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    const frame = ${view}.getBoundingClientRect();
    return { x: frame.left + box.x, y: frame.top + box.y };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...link,
      button: "left",
      clickCount: 1,
    });
  await loaded("Second");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("Cmd+Left and Cmd+Right", () => {
  it("move the caret in Work's own fields instead of going back", async () => {
    // The address bar.
    expect(
      await windowKey(
        "ArrowLeft",
        `document.querySelector('input[aria-label="Address and search bar"]')`,
      ),
    ).toBe(false);
    // The chat composer.
    await app.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-floating-chat] [data-composer-input]')`,
      { label: "composer" },
    );
    expect(
      await windowKey(
        "ArrowLeft",
        `document.querySelector('[data-floating-chat] [data-composer-input]')`,
      ),
    ).toBe(false);
    expect(
      await windowKey(
        "ArrowRight",
        `document.querySelector('[data-floating-chat] [data-composer-input]')`,
      ),
    ).toBe(false);
    await settle();
    expect(await app.eval<string>(`${view}.getTitle()`)).toBe("Second");
    await app.eval(
      `document.querySelector('button[aria-label="Minimize chat to bubble"]')?.click(); true`,
    );
  });

  it("move the caret in a page's field, and go back from the page itself", async () => {
    await inGuest(
      "(() => { const field = document.getElementById('field'); field.focus(); field.setSelectionRange(11, 11); return true; })()",
    );
    await pageKey("Left");
    // A synthetic key skips macOS's text system, which moves a real caret
    // to the line's start; elsewhere the engine moves it by a word.
    if (!mac)
      await app.waitFor(
        `${view}.executeJavaScript("document.getElementById('field').selectionStart < 11")`,
        { label: "the caret moved left" },
      );
    await settle();
    expect(await app.eval<string>(`${view}.getTitle()`)).toBe("Second");
    // Out of the field, the page goes back.
    await inGuest("(() => { document.activeElement.blur(); return true; })()");
    await pageKey("Left");
    await loaded("First");
    await pageKey("Right");
    await loaded("Second");
  });

  it("stay in an embedded frame's field, and go back from the frame itself", async () => {
    const focusInFrame = (id: string) =>
      inGuest(
        `(() => { const frame = document.querySelector('iframe'); frame.contentWindow.focus(); frame.contentDocument.getElementById('${id}').focus(); return true; })()`,
      );
    await focusInFrame("inner");
    await pageKey("Left");
    await settle();
    expect(await app.eval<string>(`${view}.getTitle()`)).toBe("Second");
    await focusInFrame("plain");
    await pageKey("Left");
    await loaded("First");
    await pageKey("Right");
    await loaded("Second");
  });

  it("go back from a page that is still loading", async () => {
    await inGuest(
      "(() => { document.getElementById('slow').click(); return true; })()",
    );
    await app.waitFor(
      `(() => { const page = ${view}; try { return page.getTitle() === 'Slow' && page.isLoading(); } catch { return false; } })()`,
      { label: "slow page loading" },
    );
    await pageKey("Left");
    await loaded("Second");
  });
});
