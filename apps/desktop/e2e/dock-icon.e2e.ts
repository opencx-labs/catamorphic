import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
const iconRow = `document.querySelector('[data-setting-id="dockIcon"]')`;
const api = "window.catamorphicDesktop";

beforeAll(async () => {
  app = await launchApp();
});
afterAll(async () => {
  await app?.stop();
});

it("offers customization only when the operating system supports it", async () => {
  expect(await app.eval(`${api}.dockIconState()`)).toMatchObject({
    supported: process.platform === "darwin",
    custom: false,
  });
  if (process.platform !== "darwin") {
    await expect(app.eval(`${api}.dockIconReset()`)).rejects.toThrow(
      "available on macOS",
    );
    await expect(
      app.eval(`${api}.dockIconSet(new Uint8Array([1]))`),
    ).rejects.toThrow("available on macOS");
  }
});

describe.skipIf(process.platform !== "darwin")("macOS Dock icon", () => {
  const openSetting = async () => {
    await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
    await app.press("p", 4);
    await app.waitFor(
      `document.activeElement?.matches('textarea[aria-label="Search commands, pages, and more"]')`,
    );
    await app.insertText("Dock icon");
    await app.waitFor(
      `document.activeElement.closest('[role="dialog"]')?.querySelector('[role="option"]')?.textContent.includes('Dock icon')`,
    );
    await app.press("Enter");
    await app.waitFor(`!!${iconRow}`);
    await app.waitFor(
      `document.activeElement === ${iconRow}.querySelector('[data-setting-control]')`,
    );
  };

  it("uses the real file input, survives a relaunch and resets", async () => {
    await openSetting();
    const source = path.join(app.userDataDir, "selected-icon.png");
    fs.copyFileSync(
      path.join(import.meta.dirname, "../build/icon.png"),
      source,
    );
    const document = z
      .object({ root: z.object({ nodeId: z.number() }) })
      .parse(await app.cdp("DOM.getDocument"));
    const input = z.object({ nodeId: z.number() }).parse(
      await app.cdp("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector: '[data-setting-id="dockIcon"] input[type="file"]',
      }),
    );
    await app.cdp("DOM.setFileInputFiles", {
      nodeId: input.nodeId,
      files: [source],
    });
    await app.waitFor(
      `${iconRow}.querySelector('img')?.alt === 'Custom Dock icon'`,
    );
    expect(fs.existsSync(path.join(app.userDataDir, "dock-icon.png"))).toBe(
      true,
    );
    fs.rmSync(source);
    await app.screenshot("/tmp/settings-dock-icon.png");
    const directory = app.userDataDir;
    await app.stop({ preserveUserData: true });
    app = await launchApp({ userDataDir: directory });
    await openSetting();
    expect(await app.eval(`${api}.dockIconState()`)).toMatchObject({
      custom: true,
    });
    await app.eval(`${iconRow}.querySelectorAll('button')[1].click()`);
    await app.waitFor(
      `${iconRow}.querySelector('img')?.alt === 'Work Dock icon'`,
    );
    expect(fs.existsSync(path.join(directory, "dock-icon.png"))).toBe(false);
    expect(await app.eval(`${api}.dockIconState()`)).toMatchObject({
      custom: false,
      preview: null,
    });
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("keeps a valid choice when an invalid replacement is submitted", async () => {
    const bytes = fs.readFileSync(
      path.join(import.meta.dirname, "../build/icon.png"),
    );
    await app.eval(
      `${api}.dockIconSet(new Uint8Array(${JSON.stringify([...bytes])}))`,
    );
    await expect(
      app.eval(`${api}.dockIconSet(new Uint8Array([1,2,3]))`),
    ).rejects.toThrow("Choose a PNG or JPEG");
    expect(await app.eval(`${api}.dockIconState()`)).toMatchObject({
      custom: true,
    });
    await app.eval(`${api}.dockIconReset()`);
  });
});
