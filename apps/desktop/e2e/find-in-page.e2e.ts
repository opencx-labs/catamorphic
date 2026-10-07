import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Find in page, as in Chrome: Cmd+F opens the tab's find bar (unless the
 * page has a find of its own), typing counts the matches, Enter and
 * Shift+Enter step through them, Escape closes it with the match selected,
 * and another page ends it. Matches and selected text take the theme's
 * accent.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url?.startsWith("/own-find")) {
    // A document editor with its own find takes the key for itself.
    response.end(`<title>Own find</title><p>apple</p><script>
      addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          document.title = 'Own find opened';
        }
      });
    </script>`);
    return;
  }
  response.end(
    `<title>Fruit</title><p id="text">apple banana apple cherry apple</p><p id="plain">orange kiwi</p><a id="away" href="/own-find">away</a>`,
  );
});

const mac = process.platform === "darwin";
const view = `document.querySelector('webview')`;
const findInput = `document.querySelector('input[aria-label="Find in page"]')`;
const count = `document.querySelector('[data-testid="find-count"]')?.textContent`;
/** A key pressed inside the page, through the guest's real input path. */
const pageKey = (keyCode: string, modifiers: string[] = []) =>
  app.eval(`(() => {
    const page = ${view};
    page.focus();
    page.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} });
    page.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} });
    return true;
  })()`);
const command = mac ? "meta" : "control";
const SHIFT = 8;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);
/** Where a word of a paragraph is painted, in window coordinates. */
const wordAt = async (id: string, word: string, nth = 0) => {
  const box = await inGuest<{ x: number; y: number; height: number }>(`(() => {
    const text = document.getElementById(${JSON.stringify(id)}).firstChild;
    let at = -1;
    for (let index = 0; index <= ${nth}; index++) at = text.data.indexOf(${JSON.stringify(word)}, at + 1);
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + ${word.length});
    const box = range.getBoundingClientRect();
    return { x: box.left, y: box.top, height: box.height };
  })()`);
  const page = await app.eval<{ x: number; y: number }>(
    `(() => { const box = ${view}.getBoundingClientRect(); return { x: box.left, y: box.top }; })()`,
  );
  // Inside the highlight, above the glyphs (the words start low: a, o).
  return {
    x: Math.round(page.x + box.x + 3),
    y: Math.round(page.y + box.y + box.height / 4),
  };
};
/**
 * The color the window shows at a point. From a capture of the whole
 * window: a clipped capture leaves the page's own layer out.
 */
const pixel = async (point: { x: number; y: number }) => {
  const { data } = (await app.cdp("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  return app.eval<number[]>(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const scale = bitmap.width / window.innerWidth;
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, Math.round(${point.x} * scale), Math.round(${point.y} * scale), 1, 1, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  })()`);
};
/**
 * Waits until the point is painted in `expected`. Within 24 per channel:
 * macOS captures carry the display's color conversion (11 off seen), and
 * what this rules out is far further away (Chromium's yellow and orange,
 * the system's selection blue, the page's own green).
 */
const painted = async (
  point: { x: number; y: number },
  expected: number[],
  label: string,
) => {
  let actual: number[] = [];
  for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
    actual = await pixel(point);
    if (
      actual.every(
        (channel, index) => Math.abs(channel - (expected[index] ?? -1)) <= 24,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${label}: painted ${actual} at ${JSON.stringify(point)}, expected ${expected}`,
  );
};
const loaded = (title: string) =>
  app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === ${JSON.stringify(title)} && !page.isLoading(); } catch { return false; } })()`,
    { label: `${title} loaded` },
  );

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Find lab',
    rootPath: ${JSON.stringify(`${app.userDataDir}/find-lab`)}
  })`);
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Find lab')`, {
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`${origin}/fruit`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await loaded("Fruit");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("find in page", () => {
  it("Cmd+F in the page opens the find bar, which counts and steps through matches", async () => {
    await pageKey("F", [command]);
    await app.waitFor(`document.activeElement === ${findInput}`, {
      label: "find bar focused",
    });
    await app.insertText("apple");
    await app.waitFor(`${count} === '1/3'`, { label: "first of three" });
    await app.press("Enter");
    await app.waitFor(`${count} === '2/3'`, { label: "Enter steps on" });
    await app.press("Enter", SHIFT);
    await app.waitFor(`${count} === '1/3'`, {
      label: "Shift+Enter steps back",
    });
    await app.press("Enter", SHIFT);
    await app.waitFor(`${count} === '3/3'`, { label: "wraps to the last" });
    await app.insertText("x");
    await app.waitFor(`${count} === '0/0'`, { label: "no match" });
    await app.press("Backspace");
    await app.waitFor(`${count} === '1/3'`, { label: "matches again" });
  });

  it("paints matches and selected text in the theme's accent, and a page's own colors over it", async () => {
    // What is painted, not computed: Chromium computes highlight styles it
    // never paints (a user-origin sheet's).
    const accent = await app.eval<string>(
      "getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()",
    );
    const rgb = [1, 3, 5].map((at) =>
      Number.parseInt(accent.slice(at, at + 2), 16),
    );
    /** The accent at `percent` over the page's white. */
    const over = (percent: number) =>
      rgb.map((channel) =>
        Math.round((channel * percent + 255 * (100 - percent)) / 100),
      );
    const green = [0, 160, 0];
    const ownStyle = (css: string) =>
      inGuest(
        `document.head.insertAdjacentHTML('beforeend', '<style id="own">${css}</style>'); true`,
      );
    const dropOwnStyle = () =>
      inGuest("document.getElementById('own').remove(); true");

    const current = await wordAt("text", "apple");
    const other = await wordAt("text", "apple", 1);
    await painted(current, rgb, "current match");
    await painted(other, over(35), "other match");
    await ownStyle("::search-text{background-color:rgb(0,160,0)}");
    await painted(other, green, "the page's own match color");
    await dropOwnStyle();

    const plain = await wordAt("plain", "orange");
    await app.eval(`${view}.focus(); true`);
    await inGuest(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('plain'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    })()`);
    await painted(plain, over(30), "selection");
    await ownStyle("::selection{background-color:rgb(0,160,0)}");
    await painted(plain, green, "the page's own selection color");
    await dropOwnStyle();
    await inGuest("getSelection().removeAllRanges(); true");
    // Back to the bar, on a match.
    await app.eval(`${findInput}.focus(); true`);
    await app.press("Enter");
    await app.waitFor(`${count} === '2/3'`, { label: "steps on again" });
  });

  it("Escape closes it with the match selected and focus back in the page", async () => {
    await app.press("Escape");
    await app.waitFor(
      `!document.querySelector('[data-testid="find-bar"]') && document.activeElement === ${view}`,
      { label: "find bar gone, page focused" },
    );
    expect(await inGuest<string>("String(getSelection())")).toBe("apple");
  });

  it("reopens with its query, and Cmd+G steps from the page", async () => {
    await pageKey("F", [command]);
    await app.waitFor(
      `document.activeElement === ${findInput} && ${findInput}.value === 'apple' && ${findInput}.selectionEnd - ${findInput}.selectionStart === 5`,
      { label: "query kept and selected" },
    );
    await app.waitFor(`/^\\d\\/3$/.test(${count} ?? '')`, {
      label: "searched again",
    });
    const before = await app.eval<string>(count);
    await pageKey("G", [command]);
    await app.waitFor(`${count} !== ${JSON.stringify(before)}`, {
      label: "Cmd+G from the page steps",
    });
  });

  it("another page ends the find; a page with its own find keeps Cmd+F", async () => {
    await inGuest("document.getElementById('away').click(); true");
    await loaded("Own find");
    await app.waitFor(`!document.querySelector('[data-testid="find-bar"]')`, {
      label: "find bar closed by navigation",
    });
    await pageKey("F", [command]);
    await loaded("Own find opened");
    // Give the bar every chance to open: it must not.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      await app.eval<boolean>(
        `!!document.querySelector('[data-testid="find-bar"]')`,
      ),
    ).toBe(false);
  });
});
