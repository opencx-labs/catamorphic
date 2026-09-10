import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG } from "../src/main/sidebar-config.js";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let configFile: string;
let projectId: string;
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="right"]')`);
  expect(
    await app.eval(
      `document.querySelector('[data-sidebar="right"]').getAttribute('aria-hidden')`,
    ),
  ).toBe("true");
  configFile = await app.eval<string>(
    "window.catamorphicDesktop.sidebarConfigFile()",
  );
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Sidebar studio',rootPath:${JSON.stringify(`${app.userDataDir}/sidebar-studio`)}})`,
  );
  projectId = project.id;
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

const toggleRight = () =>
  app.eval(
    `document.querySelector('[aria-label="Collapse right sidebar"], [aria-label="Expand right sidebar"]').click()`,
  );
const waitRight = (open: boolean) =>
  app.waitFor(
    `document.querySelector('[data-sidebar="right"]')?.getAttribute('aria-hidden') === '${!open}'`,
  );
const reload = async () => {
  await app.eval("window.__sidebarReload = true; location.reload()");
  await app.waitFor(
    `!window.__sidebarReload && !!document.querySelector('[data-sidebar="right"]')`,
  );
};

describe("tabbed sidebars", () => {
  it("hides the default left tab strip and keeps the footer below customized tabs", async () => {
    expect(
      await app.eval(
        `!!document.querySelector('[data-sidebar="left"] [role="tablist"]')`,
      ),
    ).toBe(false);
    const config = structuredClone(DEFAULT_SIDEBAR_CONFIG);
    config.left.push({
      id: "extra",
      title: "Extra",
      icon: "Files",
      sections: [{ id: "extra-files", type: "files" }],
    });
    writeConfig(config);
    await app.waitFor(
      `!!document.querySelector('[data-sidebar="left"] [role="tab"][aria-label="Extra"]')`,
    );
    expect(
      await app.eval(`(() => {
      const side = document.querySelector('[data-sidebar="left"]');
      const tabs = side.querySelector('[role="tablist"]').getBoundingClientRect();
      const bounds = side.getBoundingClientRect();
      return Math.abs((tabs.left + tabs.right) / 2 - (bounds.left + bounds.right) / 2);
    })()`),
    ).toBeLessThan(2);
    await app.eval(
      `document.querySelector('[data-sidebar="left"] [aria-label="Extra"]').click()`,
    );
    expect(
      await app.eval(`(() => {
      const side = document.querySelector('[data-sidebar="left"]');
      const profile = side.querySelector('[aria-label^="Switch profile:"]');
      const customize = side.querySelector('[aria-label="Customize sidebar"]');
      const settings = [...side.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings');
      return [profile, customize, settings].every(b => b && !b.closest('[role="tabpanel"]') && b.getBoundingClientRect().bottom > side.getBoundingClientRect().bottom - 60);
    })()`),
    ).toBe(true);
    expect(
      await app.eval(
        `!!document.querySelector('[data-sidebar="right"] [aria-label="Customize sidebar"]')`,
      ),
    ).toBe(false);
    writeConfig(DEFAULT_SIDEBAR_CONFIG);
    await app.waitFor(
      `!document.querySelector('[data-sidebar="left"] [role="tablist"]')`,
    );
  });

  it("keeps the initial selection when config tabs are reordered before any click", async () => {
    const config = structuredClone(DEFAULT_SIDEBAR_CONFIG);
    config.right.reverse();
    writeConfig(config);
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="tab"]')?.getAttribute('aria-label') === 'Pull requests'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-sidebar="right"] [role="tab"][aria-selected="true"]')?.getAttribute('aria-label')`,
      ),
    ).toBe("Activity and notes");
    writeConfig(DEFAULT_SIDEBAR_CONFIG);
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"] [role="tab"]')?.getAttribute('aria-label') === 'Activity and notes'`,
    );
  });

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

  it("remembers the populated sidebar choice across relaunch and empty projects", async () => {
    await toggleRight();
    await waitRight(false);
    await app.waitFor(
      "window.catamorphicDesktop.getPrefs().then(p => p.rightSidebarOpen === false)",
    );
    await reload();
    await app.waitFor(
      `!!document.querySelector('[data-sidebar="right"] [role="tab"]')`,
    );
    await waitRight(false);
    await toggleRight();
    await waitRight(true);
    await app.waitFor(
      "window.catamorphicDesktop.getPrefs().then(p => p.rightSidebarOpen === true)",
    );
    const root = `${app.userDataDir}/empty-sidebar-project`;
    const project = await app.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject({name:'Empty sidebar project',rootPath:${JSON.stringify(root)}})`,
    );
    fs.writeFileSync(
      `${root}/.catamorphic/sidebar.js`,
      `module.exports = ${JSON.stringify({ ...DEFAULT_SIDEBAR_CONFIG, right: [] })};\n`,
    );
    await app.eval(
      `window.catamorphicDesktop.setPrefs({lastProjectId:${JSON.stringify(project.id)}})`,
    );
    await reload();
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"]')?.textContent.includes('Add tab')`,
    );
    await waitRight(false);
    expect(
      await app.eval(
        "window.catamorphicDesktop.getPrefs().then(p => p.rightSidebarOpen)",
      ),
    ).toBe(true);
    await app.eval(
      `window.catamorphicDesktop.setPrefs({lastProjectId:${JSON.stringify(projectId)}})`,
    );
    await reload();
    await app.waitFor(
      `!!document.querySelector('[data-sidebar="right"] [role="tab"]')`,
    );
    await waitRight(true);
  });

  it("centers Add tab in an empty right sidebar and opens customization", async () => {
    writeConfig({ ...DEFAULT_SIDEBAR_CONFIG, right: [] });
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"]')?.textContent.includes('Add tab')`,
    );
    await waitRight(false);
    await toggleRight();
    await waitRight(true);
    // An empty panel is only open for this visit, even if its profile's
    // populated-sidebar preference is open.
    await reload();
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"]')?.textContent.includes('Add tab')`,
    );
    await waitRight(false);
    await toggleRight();
    await waitRight(true);
    await app.waitFor(
      `document.querySelector('[data-sidebar="right"]').getAnimations().every(a => a.playState !== 'running')`,
    );
    expect(
      await app.eval(`(() => {
      const side = document.querySelector('[data-sidebar="right"]');
      const button = [...side.querySelectorAll('button')].find(b => b.textContent.includes('Add tab'));
      const bounds = side.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return Math.abs((rect.left + rect.right) / 2 - (bounds.left + bounds.right) / 2);
    })()`),
    ).toBeLessThan(2);
    await app.eval(
      `[...document.querySelectorAll('[data-sidebar="right"] button')].find(b => b.textContent.trim() === 'Add tab').click()`,
    );
    await app.waitFor(
      `document.body.innerText.includes('The live sidebar configuration file on this machine is')`,
    );
    expect(await app.eval("document.body.innerText")).toContain(configFile);
    writeConfig(DEFAULT_SIDEBAR_CONFIG);
    await app.waitFor(
      `!!document.querySelector('[data-sidebar="right"] [role="tab"]')`,
    );
    await waitRight(true);
    await app.waitFor(
      "window.catamorphicDesktop.getPrefs().then(p => p.rightSidebarOpen === true)",
    );
  });

  it("keeps a newly created profile without a project closed", async () => {
    const profile = await app.eval<{ id: string }>(
      "window.catamorphicDesktop.profilesCreate('Empty profile')",
    );
    await app.eval(
      `window.catamorphicDesktop.windowSetProfile(${JSON.stringify(profile.id)})`,
    );
    await reload();
    await app.waitFor(
      `!!document.querySelector('[aria-label="Switch profile: Empty profile"]')`,
    );
    await waitRight(false);
    expect(app.getRendererErrors()).toEqual([]);
    if (process.env.CATAMORPHIC_SIDEBAR_SCREENSHOT)
      await app.screenshot(process.env.CATAMORPHIC_SIDEBAR_SCREENSHOT);
    // An empty workspace switches profiles in place. Its configuration and
    // visibility must come from the destination, including project overrides.
    await app.eval(
      `document.querySelector('[aria-label="Switch profile: Empty profile"]').click()`,
    );
    await app.eval(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Default Profile' && !b.getAttribute('aria-label')).click()`,
    );
    await app.waitFor(
      `!!document.querySelector('[aria-label="Switch profile: Default Profile"]')`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-sidebar="right"] [role="tab"]')`,
    );
    await waitRight(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
