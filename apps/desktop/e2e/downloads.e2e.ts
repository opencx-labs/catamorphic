import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Downloads (ADR 0153): a page's download lands in the profile's
 * downloads folder, shows in the dock while it runs and after, lists on
 * the Downloads page, opens in Work when Work can show it, and can be
 * removed from the list.
 */
let app: AppHandle;
let origin: string;
let downloadsDir: string;
const BODY = "hello from the download\n".repeat(2000);
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/notes.txt")) {
    response.setHeader("Content-Type", "text/plain");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="notes.txt"',
    );
    response.setHeader("Content-Length", Buffer.byteLength(BODY));
    response.end(BODY);
    return;
  }
  if (request.url?.startsWith("/bundle.bin")) {
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="bundle.bin"',
    );
    response.end(Buffer.alloc(4096));
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<title>Download Lab</title><a id="text" href="/notes.txt">text</a><a id="bin" href="/bundle.bin">binary</a>`,
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  downloadsDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "work-dl-"));
  app = await launchApp({ env: { CATAMORPHIC_DOWNLOADS_DIR: downloadsDir } });
  // The dock lives with a project; open the lab page inside one.
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Downloads lab',
    rootPath: ${JSON.stringify(`${app.userDataDir}/downloads-lab`)}
  })`);
  // The new project becomes the workspace on the next load.
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Downloads lab')`, {
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`${origin}/lab`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
});
afterAll(async () => {
  await app?.stop();
  server.close();
  fs.rmSync(downloadsDir, { recursive: true, force: true });
});

const guest = `document.querySelector('webview')`;
const inGuest = (code: string) =>
  app.eval(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const click = (selector: string) =>
  app.eval(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
const rows = `[...document.querySelectorAll('[data-testid="download-row"]')]`;

describe("downloads", () => {
  it("a page's download shows in the dock and lands in the downloads folder", async () => {
    await app.waitFor(
      `(() => { const view = ${guest}; try { return view.getTitle() === 'Download Lab' && !view.isLoading(); } catch { return false; } })()`,
      { label: "lab ready" },
    );
    await inGuest("document.getElementById('text').click(); true");
    // Stage by stage: the record first (main saw the download), then the
    // dock bubble that shows it.
    await app.waitFor(
      `window.catamorphicDesktop.downloadsList().then((list) => list.length > 0)`,
      { label: "download recorded" },
    );
    await app.waitFor(`!!document.querySelector('[data-dock-rail]')`, {
      label: "dock rail",
    });
    await app.waitFor(
      `!!document.querySelector('[data-testid="downloads-bubble"]')`,
      {
        label: "downloads bubble",
      },
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="downloads-bubble"][data-active]')`,
      {
        label: "download finished",
      },
    );
    expect(fs.readFileSync(path.join(downloadsDir, "notes.txt"), "utf8")).toBe(
      BODY,
    );
  });

  it("the bubble lists the file and leads to the Downloads page", async () => {
    await click('[data-testid="downloads-bubble"]');
    await app.waitFor(
      `document.querySelector('[data-testid="downloads-popover"]')?.textContent.includes('notes.txt')`,
      { label: "popover lists the file" },
    );
    await click('[data-testid="downloads-show-all"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="downloads-page"]')`,
      {
        label: "downloads page",
      },
    );
    await app.waitFor(
      `${rows}.some((row) => row.textContent.includes('notes.txt') && row.dataset.state === 'completed')`,
      { label: "completed row" },
    );
  });

  it("opening a text file shows it in Work; a binary is revealed instead", async () => {
    await inGuest("document.getElementById('bin').click(); true");
    await app.waitFor(
      `${rows}.some((row) => row.textContent.includes('bundle.bin') && row.dataset.state === 'completed')`,
      { label: "binary row" },
    );
    const before = await app.eval<number>(
      `document.querySelectorAll('webview').length`,
    );
    // Cmd/Ctrl-click: open in a new tab, the usual gesture.
    await app.eval(`(() => {
      const row = ${rows}.find((row) => row.textContent.includes('notes.txt'));
      row.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }) }));
      return true;
    })()`);
    await app.waitFor(
      `document.querySelectorAll('webview').length === ${before + 1} && [...document.querySelectorAll('webview')].some((view) => (view.getAttribute('src') || '').startsWith('file://') && view.getAttribute('src').endsWith('notes.txt'))`,
      { label: "text file opened in a browser tab" },
    );
  });

  it("Remove from list forgets the download and keeps the file", async () => {
    // The file tab is in front; bring the Downloads page back (palette).
    await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', bubbles: true, cancelable: true,
      ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    })); true`);
    await app.waitFor(
      `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].some((el) => document.activeElement === el)`,
      { label: "palette open" },
    );
    await app.insertText("Downloads");
    await app.waitFor(
      `document.activeElement.closest('[role="dialog"]')?.querySelector('[role="option"]')?.textContent.startsWith('Downloads')`,
      { label: "Downloads row first" },
    );
    await app.press("Enter");
    await app.waitFor(
      `${rows}.some((row) => row.textContent.includes('bundle.bin'))`,
      { label: "downloads page back" },
    );
    await app.eval(`(() => {
      const row = ${rows}.find((row) => row.textContent.includes('bundle.bin'));
      row.querySelector('[aria-label^="Remove"]').click();
      return true;
    })()`);
    await app.waitFor(
      `!${rows}.some((row) => row.textContent.includes('bundle.bin'))`,
      { label: "row removed" },
    );
    expect(fs.existsSync(path.join(downloadsDir, "bundle.bin"))).toBe(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
