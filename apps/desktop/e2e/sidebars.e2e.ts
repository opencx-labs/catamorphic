import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG } from "../src/main/sidebar-config.js";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let configFile: string;
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    `!!document.querySelector('[data-sidebar="right"] [role="tab"]')`,
  );
  configFile = await app.eval<string>(
    "window.catamorphicDesktop.sidebarConfigFile()",
  );
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Sidebar studio',rootPath:${JSON.stringify(`${app.userDataDir}/sidebar-studio`)}})`,
  );
  await app.eval("location.reload()");
  await app.waitFor(
    `document.body?.innerText.includes('Sidebar studio') && !!document.querySelector('[aria-label="Pin a project note"]')`,
  );
});
afterAll(async () => {
  await app?.stop();
});
const writeConfig = (config: unknown) =>
  fs.writeFileSync(configFile, `module.exports = ${JSON.stringify(config)};\n`);

describe("tabbed sidebars", () => {
  it("uses bare accent icons and keyboard navigation with persistent panels", async () => {
    expect(
      await app.eval(`(() => {
      const tab = document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]');
      return { text:tab.textContent, color:getComputedStyle(tab).color, accent:getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(), border:getComputedStyle(tab).borderTopWidth, background:getComputedStyle(tab).backgroundColor };
    })()`),
    ).toMatchObject({
      text: "",
      border: "0px",
      background: "rgba(0, 0, 0, 0)",
    });
    await app.eval(`(() => {
      window.__sidebarNote = document.querySelector('[aria-label="Pin a project note"]');
      const tab = document.querySelector('[data-sidebar="right"] [role="tab"]');
      tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true,cancelable:true}));
    })()`);
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]')?.getAttribute('aria-label') === 'Pull requests'`,
    );
    await app.eval(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true,cancelable:true}))`,
    );
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]')?.getAttribute('aria-label') === 'Activity and notes'`,
    );
    expect(
      await app.eval(
        `window.__sidebarNote === document.querySelector('[aria-label="Pin a project note"]')`,
      ),
    ).toBe(true);
    expect(
      await app.eval(
        `getComputedStyle(document.querySelector('[data-sidebar="right"] .sidebar-tab-panel')).transitionDuration`,
      ),
    ).toContain("0.2s");
  });

  it("reconciles live edits by identity and retains the layout on invalid saves", async () => {
    const config = structuredClone(DEFAULT_SIDEBAR_CONFIG);
    config.right.reverse();
    config.right.find((tab) => tab.id === "companion")!.title =
      "Work companion";
    writeConfig(config);
    await app.waitFor(
      `!!document.querySelector('[role="tab"][aria-label="Work companion"]')`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]')?.getAttribute('aria-label')`,
      ),
    ).toBe("Work companion");
    expect(
      await app.eval(
        `window.__sidebarNote === document.querySelector('[aria-label="Pin a project note"]')`,
      ),
    ).toBe(true);
    fs.writeFileSync(configFile, "module.exports = {");
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="alert"]')?.textContent.includes('could not reload')`,
    );
    expect(
      await app.eval(
        `!!document.querySelector('[role="tab"][aria-label="Work companion"]')`,
      ),
    ).toBe(true);
    writeConfig(config);
    await app.waitFor(
      `!document.querySelector('[data-sidebar="right"] [role="alert"]')`,
    );
  });

  it("persists widths and tab selection, and collapses each side independently", async () => {
    await app.eval(`(() => {
      document.querySelector('[data-sidebar="right"] [role="tab"][aria-label="Pull requests"]').click();
      const handle = document.querySelector('[aria-label="Resize right sidebar"]');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft',bubbles:true,cancelable:true}));
      document.querySelector('[aria-label="Collapse sidebar"]').click();
    })()`);
    await app.waitFor(
      `document.querySelector('[data-sidebar="left"]').getAttribute('aria-hidden') === 'true'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-sidebar="right"]').getAttribute('aria-hidden')`,
      ),
    ).toBe("false");
    await app.eval("location.reload()");
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]')?.getAttribute('aria-label') === 'Pull requests'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[aria-label="Resize right sidebar"]').getAttribute('aria-valuenow')`,
      ),
    ).toBe("340");
    expect(
      await app.eval(
        `document.querySelector('[data-sidebar="left"]').getAttribute('aria-hidden')`,
      ),
    ).toBe("true");
    await app.eval(
      `document.querySelector('[aria-label="Expand sidebar"]').click(); document.querySelector('[role="tab"][aria-label="Work companion"]').click()`,
    );
    await app.waitFor(`(() => {
      const sides = [...document.querySelectorAll('[data-sidebar]')];
      return sides.length === 2 && sides.every(side => side.getAnimations({subtree:true}).every(a => a.playState !== 'running'));
    })()`);
    if (process.env.CATAMORPHIC_SIDEBAR_SCREENSHOT)
      await app.screenshot(process.env.CATAMORPHIC_SIDEBAR_SCREENSHOT);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
