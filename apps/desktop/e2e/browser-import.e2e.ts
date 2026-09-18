import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserProfile } from "./fixtures/browser-profile.js";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let directory: string;
let profileId: string;
let origin: string;
let receivedCookie = "";
const server = http.createServer((request, response) => {
  receivedCookie = request.headers.cookie ?? "";
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<title>Fixture signed-in page</title><h1>Imported browser session</h1>",
  );
});
const input = `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0)`;
async function click(selector: string) {
  await app.waitFor(
    `document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)`,
  );
  const point = await app.waitFor<{ x: number; y: number }>(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el || el.disabled || el.closest('[inert]')) return false; el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return r.width && {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await app.movePointer(point);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
}
async function palette() {
  await app.waitFor(`!${input}`);
  await app.press("p", process.platform === "darwin" ? 4 : 2);
  await app.waitFor(
    `document.activeElement === ${input} && ${input}?.value === ""`,
  );
}
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture server address");
  origin = `http://127.0.0.1:${address.port}`;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-import-fixture-"));
  createBrowserProfile({ directory, origin });
  fs.cpSync(
    path.join(directory, "fixture.default"),
    path.join(directory, "fixture.work"),
    { recursive: true },
  );
  fs.appendFileSync(
    path.join(directory, "profiles.ini"),
    "\n[Profile1]\nName=Work browser\nIsRelative=1\nPath=fixture.work\n",
  );
  app = await launchApp({
    env: { CATAMORPHIC_E2E_BROWSER_IMPORT_DIR: directory },
  });
  profileId = await app.eval<string>(
    "window.catamorphicDesktop.windowProfile()",
  );
});
afterAll(async () => {
  await app?.stop();
  server.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared browser import and personal history", () => {
  it("uses themed, animated controls with keyboard selection and nested Escape", async () => {
    await app.waitFor(
      `!!document.querySelector('[data-testid="default-browser-button"]')`,
    );
    expect(
      await app.eval(
        `(()=>{const a=document.querySelector('[data-testid="onboarding-browser-import"]').getBoundingClientRect();const b=document.querySelector('[data-testid="default-browser-button"]').getBoundingClientRect();return b.y >= a.bottom && a.width === b.width;})()`,
      ),
    ).toBe(true);
    expect(
      await app.eval(`(() => {
        const button = document.querySelector('[data-testid="default-browser-button"]');
        return {disabled: button.disabled, reason: document.getElementById(button.getAttribute('aria-describedby')).innerText};
      })()`),
    ).toEqual({
      disabled: true,
      reason: "Use the installed Catamorphic app to set your default browser.",
    });
    await click('[data-testid="onboarding-browser-import"]');
    await app.waitFor(
      `document.querySelector('select[aria-label="Browser profile"]')?.options.length === 2`,
    );
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('select[aria-label="Browser profile"]')).appearance`,
      ),
    ).toBe("base-select");
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('input[type="checkbox"]')).appearance`,
      ),
    ).toBe("none");
    await click('select[aria-label="Browser profile"]');
    await app.waitFor(`!!document.querySelector('select:open')`);
    const style = await app.eval<{
      background: string;
      expected: string;
      duration: string;
    }>(
      `(()=>{const s=document.querySelector('select:open');const style=getComputedStyle(s,'::picker(select)');return {background:style.backgroundColor,expected:getComputedStyle(document.documentElement).getPropertyValue('--color-bg-overlay').trim(),duration:style.transitionDuration}})()`,
    );
    expect(style.duration).toContain("0.15s");
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    await app.waitFor(
      `document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)`,
    );
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
        "browser-import-profile-menu.png",
      ),
    );
    await app.press("Escape");
    await app.waitFor(`!document.querySelector('select:open')`);
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="browser-import-dialog"]')`,
      ),
    ).toBe(true);
    await click('select[aria-label="Browser profile"]');
    await app.press("ArrowDown");
    await app.press("Enter");
    await app.waitFor(
      `document.querySelector('select[aria-label="Browser profile"]').selectedOptions[0].textContent.includes('Work browser')`,
    );
    await click('select[aria-label="Browser profile"]');
    await app.press("ArrowUp");
    await app.press("Enter");
    await app.waitFor(
      `document.querySelector('select[aria-label="Browser profile"]').selectedOptions[0].textContent.includes('Test browser')`,
    );
    await app.press("Escape");
    await app.waitFor(
      `!document.querySelector('[data-testid="browser-import-dialog"]')`,
    );
  });
  it("selects categories before import and returns to completed onboarding", async () => {
    const setupBounds = await app.eval(
      `document.querySelector('[data-testid="onboarding-browser-import"]').getBoundingClientRect().toJSON()`,
    );
    await click('[data-testid="onboarding-browser-import"]');
    await app.waitFor(
      `document.querySelector('[aria-label="History"]')?.checked`,
    );
    expect(
      await app.eval("window.catamorphicDesktop.historyQuery({})"),
    ).toMatchObject({ total: 0 });
    await click('input[aria-label="Bookmarks"]');
    await click('input[aria-label="Signed-in sessions"]');
    // Observe the real IPC transition, including its first pending render.
    await app.eval(`(() => {
      const button = document.querySelector('[data-testid="browser-import-start"]');
      const dialog = document.querySelector('[data-testid="browser-import-dialog"]');
      const bounds = element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      window.importLayout = { idle: [bounds(button), bounds(dialog)], pending: [] };
      const observer = new MutationObserver(() => {
        if (button.getAttribute('aria-busy') === 'true') {
          window.importLayout.pending.push([bounds(button), bounds(dialog)]);
        }
        if (!button.isConnected) observer.disconnect();
      });
      observer.observe(dialog.parentElement, {subtree:true, attributes:true, childList:true});
    })()`);
    await click('[data-testid="browser-import-start"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="browser-import-dialog"]')`,
    );
    const layout = await app.eval<{ idle: number[][]; pending: number[][][] }>(
      "window.importLayout",
    );
    expect(layout.pending.length).toBeGreaterThan(0);
    for (const frame of layout.pending) expect(frame).toEqual(layout.idle);
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding-browser-import"]')?.textContent`,
      ),
    ).toContain("Browser import complete");
    await app.waitFor(
      `document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity)`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding-browser-import"]').getBoundingClientRect().toJSON()`,
      ),
    ).toEqual(setupBounds);
    const completed = await app.eval<{
      disabled: boolean;
      state: string;
      background: string;
      border: string;
      x: number;
      y: number;
    }>(`(() => {
      const button = document.querySelector('[data-testid="onboarding-browser-import"]');
      const style = getComputedStyle(button);
      const bounds = button.getBoundingClientRect();
      return {disabled: button.disabled, state: button.dataset.actionState, background: style.backgroundColor, border: style.borderTopColor, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    })()`);
    expect(completed.disabled).toBe(true);
    expect(completed.state).toBe("done");
    expect(completed.border).toBe("rgba(0, 0, 0, 0)");
    await app.movePointer({ x: completed.x, y: completed.y });
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('[data-testid="onboarding-browser-import"]')).backgroundColor`,
      ),
    ).toBe(completed.background);
    expect(
      await app.eval(
        "window.catamorphicDesktop.historyQuery({query:'Deep archive needle'})",
      ),
    ).toMatchObject({ total: 1 });
    expect(
      await app.eval(
        `window.catamorphicDesktop.profilesList().then(data=>data.profiles.find(p=>p.id===${JSON.stringify(profileId)}))`,
      ),
    ).toHaveProperty("browserImportCompletedAt");
  });

  it("keeps onboarding import completion scoped to the selected profile", async () => {
    await app.eval(
      "window.catamorphicDesktop.profilesCreate('Fresh import profile')",
    );
    await click('[aria-label="Switch profile: Default Profile"]');
    await app.eval(
      `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Fresh import profile' && !button.getAttribute('aria-label')).click()`,
    );
    await app.waitFor(
      `!!document.querySelector('[aria-label="Switch profile: Fresh import profile"]')`,
    );
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding-browser-import"]')?.dataset.actionState === 'idle'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-testid="onboarding-browser-import"]').disabled`,
      ),
    ).toBe(false);
    await click('[data-testid="onboarding-browser-import"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="browser-import-dialog"]')`,
    );
    await app.press("Escape");
    await app.waitFor(
      `!document.querySelector('[data-testid="browser-import-dialog"]')`,
    );
    await click('[aria-label="Switch profile: Fresh import profile"]');
    await app.eval(
      `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Default Profile' && !button.getAttribute('aria-label')).click()`,
    );
    await app.waitFor(
      `document.querySelector('[data-testid="onboarding-browser-import"]')?.dataset.actionState === 'done'`,
    );
  });

  it("history Space searches the full imported archive; the page uses that palette", async () => {
    await palette();
    await app.insertText("history");
    await app.press("Space");
    await app.waitFor(`${input}?.placeholder === 'Search history…'`);
    await app.insertText("Deep archive needle");
    await app.waitFor(
      `document.querySelector('[role="option"]')?.textContent.includes('Deep archive needle')`,
    );
    await app.press("Escape");
    await palette();
    await app.insertText("History");
    await app.waitFor(
      `[...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.includes("Pages and work you've opened"))`,
    );
    await app.press("Enter");
    await app.waitFor(
      `!!document.querySelector('[aria-label="Search history"]')`,
    );
    await click('[aria-label="Search history"]');
    await app.waitFor(`${input}?.placeholder === 'Search history…'`);
    await app.press("Escape");
  });

  it("uses the same dialog in Settings and imports a working session", async () => {
    await palette();
    await app.insertText("Settings");
    await app.waitFor(
      `[...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.trim().startsWith('Settings'))`,
    );
    await app.press("Enter");
    await app.waitFor(`!${input}`);
    await app.eval(
      `[...document.querySelectorAll('[aria-label="Settings categories"] button')].find(el=>el.textContent.includes('Import')).click()`,
    );
    await app.eval("window.catamorphicDesktop.devWindow('setSize',760,640)");
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await click('[data-testid="settings-browser-import"]');
    await app.waitFor(
      `document.querySelector('[aria-label="Signed-in sessions"]')?.checked`,
    );
    expect(
      await app.eval(
        `(()=>{const el=document.querySelector('[data-testid="browser-import-dialog"]');const r=el.getBoundingClientRect();return getComputedStyle(el).textAlign==='left' && el.scrollWidth<=el.clientWidth && r.top>=0 && r.bottom<=innerHeight;})()`,
      ),
    ).toBe(true);
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
        "browser-import-narrow.png",
      ),
    );
    await click('[data-testid="browser-import-start"]');
    await app.waitFor(
      `!document.querySelector('[data-testid="browser-import-dialog"]')`,
    );
    expect(
      await app.eval("window.catamorphicDesktop.historyQuery({})"),
    ).toMatchObject({ total: 220 });
    await palette();
    await app.insertText(`${origin}/session-check`);
    await app.press("Enter");
    const deadline = Date.now() + 15000;
    while (!receivedCookie && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedCookie).toContain("fixture_session=signed-in-fixture");
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
    await app.eval("window.catamorphicDesktop.devWindow('setSize',1200,800)");
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("records documents and reopens them in their owning project", async () => {
    const create = (name: string) =>
      app.eval<{ id: string }>(
        `window.catamorphicDesktop.createProject(${JSON.stringify({ name, rootPath: path.join(app.userDataDir, name) })})`,
      );
    const first = await create("History documents");
    fs.writeFileSync(
      path.join(app.userDataDir, "History documents", "field-notes.md"),
      "# Field notes\nA document retained in personal history.\n",
    );
    await app.eval(
      `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({ projectId: first.id, surface: { url: "file:field-notes.md", title: "Field notes", mode: "tab", nonce: "first-document" } })})`,
    );
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({query:'field-notes.md'}).then(page=>page.entries.some(entry=>entry.target.kind==='file' && entry.target.projectId===${JSON.stringify(first.id)}))`,
    );
    const second = await create("Other work");
    await app.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(second.id)}})`,
    );
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(second.id)}`,
    );
    // A fresh workspace has a New Tab palette; focus the same search surface.
    if (await app.eval(`!!${input}`)) await app.eval(`${input}.focus()`);
    else await palette();
    await app.insertText("history");
    await app.press("Space");
    await app.waitFor(`${input}?.placeholder==='Search history…'`);
    await app.insertText("field-notes.md");
    await app.waitFor(
      `[...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.includes('field-notes.md') && el.textContent.includes('History documents'))`,
    );
    await app.press("Enter");
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(first.id)}`,
    );
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"]')?.innerText.includes('Field notes')`,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("rejects unknown source profiles before accessing any browser store", async () => {
    const error = await app.eval<string>(
      `window.catamorphicDesktop.browserImportRun({browserId:'unknown', sourceProfileId:'../../outside', targetProfileId:${JSON.stringify(profileId)}, categories:['sessions']}).then(()=>'',error=>error.message)`,
    );
    expect(error).toContain("no longer available");
  });
});
