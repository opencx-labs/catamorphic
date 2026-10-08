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

  it("dragging the strip across a page reaches the middle resting spot", async () => {
    await app.eval(
      `window.catamorphicDesktop.setPrefs({ dockPlacement: 'right' }).then(() => true)`,
    );
    await app.waitFor(
      `document.querySelector('[data-dock-host]')?.dataset.dockPlacement === 'right' && document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && !document.querySelector('[data-dock-rail]').getAnimations().some((animation) => animation.playState === 'running')`,
      { label: "strip open at the right" },
    );
    const handle = await app.eval<{ x: number; y: number; middle: number }>(
      `(() => {
        const arrows = document.querySelector('[data-dock-arrows]').getBoundingClientRect();
        const host = document.querySelector('[data-dock-host]').getBoundingClientRect();
        return { x: arrows.left + arrows.width / 2, y: arrows.top + arrows.height / 2, middle: host.left + host.width / 2 };
      })()`,
    );
    // The page fills the content area under the strip.
    expect(
      await app.eval<string>(
        `document.elementsFromPoint(${handle.middle}, ${handle.y}).map((el) => el.tagName).join(',')`,
      ),
    ).toContain("WEBVIEW");
    const mouse = (type: string, x: number) =>
      app.cdp("Input.dispatchMouseEvent", {
        type,
        x,
        y: handle.y,
        button: "left",
        clickCount: 1,
        ...(type === "mouseMoved" ? { buttons: 1 } : {}),
      });
    await mouse("mousePressed", handle.x);
    await mouse("mouseMoved", handle.x - 10);
    await app.waitFor(
      `document.querySelector('[data-dock-rail]')?.dataset.dockDragging === 'true'`,
      { label: "strip follows the pointer" },
    );
    // One quick move leaves the strip behind, over the page.
    await mouse("mouseMoved", handle.middle);
    await app.waitFor(
      `!!document.querySelector('[data-dock-target="center"][data-active]')`,
      { label: "middle resting spot lit" },
    );
    await mouse("mouseReleased", handle.middle);
    await app.waitFor(
      `document.querySelector('[data-dock-host]')?.dataset.dockPlacement === 'center' && !document.querySelector('[data-dock-dragging]') && !document.querySelector('[data-dock-drag-shield]')`,
      { label: "strip lands in the middle" },
    );
  });

  it("the popover opens toward the middle wherever the strip rests", async () => {
    const popover = `document.querySelector('[data-testid="downloads-popover"]')`;
    const check = async (label: string) => {
      await click('[data-testid="downloads-bubble"]');
      await app.waitFor(
        `(() => {
          const element = ${popover};
          if (!element || element.getAnimations().some((animation) => animation.playState === 'running')) return false;
          const box = element.getBoundingClientRect();
          const host = document.querySelector('[data-dock-host]').getBoundingClientRect();
          return box.left >= host.left - 1 && box.right <= host.right + 1 && box.right <= window.innerWidth;
        })()`,
        { label: `popover inside the window: ${label}` },
      );
      await click('[data-testid="downloads-bubble"]');
      await app.waitFor(`!${popover}`, { label: "popover closed" });
    };
    for (const placement of ["left", "right", "center"]) {
      await app.eval(
        `window.catamorphicDesktop.setPrefs({ dockPlacement: '${placement}' }).then(() => true)`,
      );
      await app.waitFor(
        `document.querySelector('[data-dock-host]')?.dataset.dockPlacement === '${placement}' && !document.querySelector('[data-dock-rail]').getAnimations().some((animation) => animation.playState === 'running')`,
        { label: `strip open at ${placement}` },
      );
      await check(`open strip at ${placement}`);
    }
    // Collapsed, the strip rests in a bottom corner.
    await click("[data-dock-arrows]");
    for (const side of ["left", "right"]) {
      await app.eval(
        `window.catamorphicDesktop.setPrefs({ dockSide: '${side}' }).then(() => true)`,
      );
      await app.waitFor(
        `document.querySelector('[data-dock-host]')?.dataset.dockSide === '${side}' && document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true' && !document.querySelector('[data-dock-rail]').getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')`,
        { label: `strip collapsed at ${side}` },
      );
      await check(`collapsed at ${side}`);
    }
    // The detached dock is a window just big enough for the strip; it
    // grows while the popover is open, which opens toward the middle.
    await app.eval(`window.catamorphicDesktop.dockDetach(true)`);
    const dock = await app.connectToFrame("surface=dock");
    try {
      const opensInside = async (label: string) => {
        await dock.eval(
          `document.querySelector('[data-testid="downloads-bubble"]').click(); true`,
        );
        await dock.waitFor(
          `(() => {
            const element = ${popover};
            if (!element || element.getAnimations().some((animation) => animation.playState === 'running')) return false;
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
          })()`,
          { label: `popover inside the detached dock: ${label}` },
        );
        await dock.eval(
          `document.querySelector('[data-testid="downloads-bubble"]').click(); true`,
        );
        await dock.waitFor(`!${popover}`, { label: "detached popover closed" });
      };
      // The strip was folded in the window, and that fold is the person's
      // in every window: the detached dock shows it folded until opened.
      await dock.waitFor(
        `document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
        { label: "detached strip keeps the fold" },
      );
      await dock.eval(
        `document.querySelector('[aria-label="Expand chat bubbles"]').click(); true`,
      );
      await dock.waitFor(
        `!!document.querySelector('[data-testid="downloads-bubble"]') && document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'false'`,
        { label: "detached strip open" },
      );
      for (const placement of ["left", "right"]) {
        await app.eval(
          `window.catamorphicDesktop.setPrefs({ dockPlacement: '${placement}' }).then(() => true)`,
        );
        await dock.waitFor(
          `document.querySelector('[data-dock-host]')?.dataset.dockPlacement === '${placement}'`,
          { label: `detached strip open at ${placement}` },
        );
        await opensInside(`open strip at ${placement}`);
      }
      await dock.eval(
        `document.querySelector('[data-dock-arrows]').click(); true`,
      );
      for (const side of ["left", "right"]) {
        await app.eval(
          `window.catamorphicDesktop.setPrefs({ dockSide: '${side}' }).then(() => true)`,
        );
        await dock.waitFor(
          `document.querySelector('[data-dock-host]')?.dataset.dockSide === '${side}' && document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
          { label: `detached strip collapsed at ${side}` },
        );
        await opensInside(`collapsed at ${side}`);
      }
    } finally {
      dock.close();
      await app.eval(`window.catamorphicDesktop.dockDetach(false)`);
    }
    // Back in the window, the strip keeps the fold made in the detached
    // dock; opened again, it settles.
    await app.waitFor(
      `document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'true'`,
      { label: "dock back in the window, folded" },
    );
    await click('[aria-label="Expand chat bubbles"]');
    await app.waitFor(
      `document.querySelector('[data-dock-rail]')?.dataset.dockCollapsed === 'false' && !document.querySelector('[data-dock-rail]').getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')`,
      { label: "dock back in the window, open" },
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
    // History (ADR 0154) keeps the opened file as a file on this machine,
    // opened in this project, not as one of the project's own files.
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({}).then((page) => page.entries.some((entry) => entry.target.kind === 'local' && entry.target.path.endsWith('/notes.txt') && entry.project?.name === 'Downloads lab'))`,
      { label: "download recorded in history" },
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

  it("closing the bubble hides it until the next download", async () => {
    await click('[data-testid="downloads-bubble-close"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="downloads-bubble-root"]')`,
      { label: "bubble closed" },
    );
    await inGuest("document.getElementById('bin').click(); true");
    await app.waitFor(
      `!!document.querySelector('[data-testid="downloads-bubble"]')`,
      { label: "a new download brings the bubble back" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
