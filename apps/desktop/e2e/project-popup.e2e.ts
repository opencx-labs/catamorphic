import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  pointerOnPage,
  removeE2eDirectory,
} from "./harness.js";

/**
 * A project's hover card in the project switcher: where the project lives
 * (folder, Git remote, Work server) at a size that holds while its reads
 * arrive, a remote that copies, and actions in the app's own menu, which
 * closes on any press elsewhere (ADR 0221). The switcher's list closes on
 * a press inside a web page, which the window never sees itself.
 */
let app: AppHandle;
let origin: string;
let temp: string;
const REMOTE = "https://github.com/example/popup-fixture.git";
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Popup lab</title>
<body style="font:16px sans-serif;margin:0;padding:24px;height:1400px">
  <p><input id="field" value="" style="width:420px"></p>
  <p id="blank" style="height:240px"></p>
  <script>
    window.__presses = 0;
    addEventListener('pointerdown', () => { window.__presses += 1; }, true);
  </script>
</body>`);
});

const view = `[...document.querySelectorAll('webview')].find(w => w.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
const inPage = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);
const trigger = `[...document.querySelectorAll('[aria-label="Switch project"]')].find(b => !b.closest('[inert]') && b.checkVisibility())`;
const listbox = `${trigger}?.parentElement.querySelector(':scope > [role="listbox"]')`;
const row = (name: string) =>
  `[...(${listbox}?.querySelectorAll('[role="option"]') ?? [])].find(o => o.textContent.trim() === ${JSON.stringify(name)})`;
const card = `[...document.querySelectorAll('[data-resource-inspector][data-open="true"] [data-testid="project-inspector"]')].find(c => c.querySelector('h2')?.textContent === 'Popup fixture')`;
const panel = `${card}?.closest('[data-resource-inspector]')`;
const menu = `document.querySelector('[data-sidebar-menu][aria-label="Actions for Popup fixture"]')`;

/** The middle of what `expression` finds, once it can take the pointer. */
const centerOf = (expression: string, label: string) =>
  app.waitFor<{ x: number; y: number }>(
    `(() => { const el = ${expression}; if (!el) return false; const r = el.getBoundingClientRect(); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); return r.width > 0 && el.getAnimations({ subtree: true }).every(a => a.playState !== 'running') && { x, y }; })()`,
    { label },
  );
const move = (point: { x: number; y: number }) =>
  app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
const press = async (point: { x: number; y: number }) => {
  await move(point);
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
};
/** Where an element of the page is, in window coordinates. */
const pagePoint = async (selector: string) => {
  const box = await inPage<{ x: number; y: number }>(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  const page = await app.eval<{ x: number; y: number; zoom: number }>(
    `(() => { const page = ${view}; const box = page.getBoundingClientRect(); return { x: box.left, y: box.top, zoom: page.getZoomFactor() }; })()`,
  );
  return {
    x: Math.round(page.x + box.x * page.zoom),
    y: Math.round(page.y + box.y * page.zoom),
  };
};
/** Settled: no motion moves what the pointer is about to press. */
const still = (expression: string) =>
  `${expression}.getAnimations().every(a => a.playState !== 'running')`;
const listOpen = () =>
  app.waitFor(
    `${listbox}?.getAttribute('aria-hidden') === 'false' && ${still(listbox)}`,
    { label: "project list open" },
  );
const listClosed = () =>
  app.waitFor(`${listbox}?.getAttribute('aria-hidden') === 'true'`, {
    label: "project list closed",
  });
const cardOpen = () =>
  app.waitFor(`!!${card} && ${still(panel)}`, {
    label: "Popup fixture's card open",
  });
const cardClosed = () =>
  app.waitFor(`!${card}`, { label: "Popup fixture's card closed" });
const menuOpen = () =>
  app.waitFor(
    `!!${menu} && !!document.querySelector('[data-menu-shield]') && ${menu}.getAnimations({ subtree: true }).every(a => a.playState !== 'running')`,
    { label: "actions menu open" },
  );
const menuClosed = () =>
  app.waitFor(`!${menu} && !document.querySelector('[data-menu-shield]')`, {
    label: "actions menu closed",
  });
/** Open the project list and rest the pointer on the fixture's row. */
const hoverFixture = async () => {
  if (
    !(await app.eval<boolean>(
      `${listbox}?.getAttribute('aria-hidden') === 'false'`,
    ))
  )
    await press(await centerOf(trigger, "switcher"));
  await listOpen();
  await move(await centerOf(row("Popup fixture"), "fixture row"));
  await cardOpen();
};
const openActions = async () => {
  await press(
    await centerOf(
      `${card}?.querySelector('[aria-label="Actions for Popup fixture"]')`,
      "actions button",
    ),
  );
  await menuOpen();
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "project-popup-e2e-")),
  );
  const fixture = path.join(temp, "Popup fixture");
  fs.mkdirSync(fixture);
  await nativeGit(fixture, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(fixture, "README.md"), "Popup fixture\n");
  await nativeGit(fixture, ["add", "."]);
  await nativeGit(fixture, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  ]);
  await nativeGit(fixture, ["remote", "add", "origin", REMOTE]);
  app = await launchApp();
  const home = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({
      name: "Popup home",
      rootPath: path.join(app.userDataDir, "popup-home"),
    })})`,
  );
  await app.eval(
    `window.catamorphicDesktop.createProject(${JSON.stringify({
      name: "Popup fixture",
      rootPath: fixture,
      importExisting: true,
    })})`,
  );
  // The project list loads both on the next load.
  await app.reload();
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
      projectId: home.id,
      surface: {
        url: `${origin}/lab`,
        title: "Popup lab",
        mode: "tab",
        nonce: "popup-lab",
        open: "browser",
      },
    })})`,
  );
  await app.waitFor(
    `(() => { const page = ${view}; try { return page.getTitle() === 'Popup lab' && !page.isLoading(); } catch { return false; } })()`,
    { label: "Popup lab loaded", timeoutMs: 30_000 },
  );
  await app.waitFor(`${trigger}?.textContent.includes('Popup home')`, {
    label: "home project in front",
  });
});
afterAll(async () => {
  await app?.stop();
  server.close();
  if (temp) removeE2eDirectory(temp);
});

describe("a project's card", () => {
  it("opens at its size and keeps it while its reads arrive", async () => {
    // Every frame from the card's first, until its reads have long landed.
    await app.eval(`(() => {
      window.__cardHeights = null;
      const heights = [];
      const watch = () => {
        const element = ${panel};
        if (!element) return requestAnimationFrame(watch);
        const start = performance.now();
        const sample = () => {
          heights.push(element.offsetHeight);
          if (performance.now() - start < 1500) requestAnimationFrame(sample);
          else window.__cardHeights = heights;
        };
        sample();
      };
      requestAnimationFrame(watch);
      return true;
    })()`);
    await hoverFixture();
    const heights = await app.waitFor<number[]>("window.__cardHeights", {
      label: "card heights sampled",
    });
    expect(heights.length).toBeGreaterThan(10);
    expect(new Set(heights).size).toBe(1);
    expect(
      await app.eval<string[]>(
        `[...${card}.querySelectorAll('dt')].map(term => term.textContent)`,
      ),
    ).toEqual(["Folder", "Git remote", "Work server"]);
    const text = await app.eval<string>(`${card}.textContent`);
    expect(text).toContain(REMOTE);
    expect(text).toContain("No ongoing sessions");
    for (const gone of ["Worktrees", "pull request", "could not load"])
      expect(text).not.toContain(gone);
    expect(await app.eval<boolean>(`!!${card}.querySelector('[title]')`)).toBe(
      false,
    );
  });

  it("copies its Git remote", async () => {
    await press(
      await centerOf(
        `${card}?.querySelector('[aria-label="Copy Git remote"]')`,
        "copy button",
      ),
    );
    await app.waitFor(
      `${card}?.querySelector('[aria-label="Copy Git remote"]')?.dataset.copied === 'true'`,
      { label: "copied" },
    );
    // What the clipboard holds, pasted into the page.
    await app.eval(`${view}.focus(); true`);
    await inPage(
      "(() => { const field = document.getElementById('field'); field.value = ''; field.focus(); return true; })()",
    );
    await app.eval(`${view}.paste(); true`);
    await app.waitFor(
      `${view}.executeJavaScript("document.getElementById('field').value", true).then(value => value === ${JSON.stringify(REMOTE)})`,
      { label: "remote pasted" },
    );
  });
});

describe("a project's actions menu", () => {
  it("closes on a press elsewhere in the card, which stays", async () => {
    await hoverFixture();
    await openActions();
    const term = await app.eval<{ x: number; y: number }>(
      `(() => { const r = ${card}.querySelector('dt').getBoundingClientRect(); return { x: Math.round(r.x + 8), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    await press(term);
    await menuClosed();
    expect(await app.eval<boolean>(`!!${card}`)).toBe(true);
    await listOpen();
  });

  it("closes on a press outside the card, which the page never receives", async () => {
    await openActions();
    const before = await inPage<number>("window.__presses");
    await press(await pagePoint("#blank"));
    await menuClosed();
    expect(await inPage<number>("window.__presses")).toBe(before);
    // The press only closed the menu: the list and its card stay.
    await listOpen();
    expect(await app.eval<boolean>(`!!${card}`)).toBe(true);
  });

  it("closes on Escape before its card does", async () => {
    await openActions();
    await app.press("Escape");
    await menuClosed();
    expect(await app.eval<boolean>(`!!${card}`)).toBe(true);
    await app.press("Escape");
    await cardClosed();
  });

  it("deletes through its confirmation", async () => {
    await hoverFixture();
    await openActions();
    await press(
      await centerOf(
        `[...(${menu}?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === 'Delete project…')`,
        "delete entry",
      ),
    );
    await app.waitFor(
      `[...document.querySelectorAll('[role="dialog"][aria-modal="true"] h2')].some(h => h.textContent.includes('Popup fixture?'))`,
      { label: "delete confirmation" },
    );
    // The card and the list gave way to the confirmation.
    await cardClosed();
    await listClosed();
    await app.press("Escape");
    await app.waitFor(
      `![...document.querySelectorAll('[role="dialog"][aria-modal="true"] h2')].some(h => h.textContent.includes('Popup fixture?'))`,
      { label: "confirmation dismissed" },
    );
  });
});

describe("the project list", () => {
  it("closes on a press inside a web page", async () => {
    await press(await centerOf(trigger, "switcher"));
    await listOpen();
    const point = await pagePoint("#blank");
    await pointerOnPage(app, { view, selector: "#blank", point });
    const before = await inPage<number>("window.__presses");
    await press(point);
    await listClosed();
    // Unlike a menu, the list lets the press through.
    await app.waitFor(
      `${view}.executeJavaScript('window.__presses', true).then(count => count === ${before + 1})`,
      { label: "page pressed" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
