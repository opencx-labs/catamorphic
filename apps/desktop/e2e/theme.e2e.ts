import fs from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_THEME_FONTS } from "../src/shared/theme-fonts.js";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!![...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'New project')`);
  await app.eval(`[...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'New project').click()`);
  await app.waitFor(
    `!!document.querySelector('[data-testid="project-name-input"]')`,
  );
  await app.eval(`(() => {
    ${setReactValueJs}
    setReactValue(document.querySelector('[data-testid="project-name-input"]'), 'theme-test');
  })()`);
  await app.waitFor(`(() => {
    const button = document.querySelector('[data-testid="project-submit"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  await app.waitFor(
    `!![...document.querySelectorAll('[role="tab"], button')].find(
    el => el.textContent.includes('New Tab'))`,
    { timeoutMs: 60_000 },
  );
  await app.waitFor(`!![...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'Settings')`);
  await app.eval(`[...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'Settings').click()`);
  await app.waitFor(`!![...document.querySelectorAll('label')].find(
    el => el.textContent.includes('Interface font'))`);
});

afterAll(async () => {
  await app?.stop();
});

it("starts a fresh profile in the system appearance without pinning a preset", async () => {
  const theme = await app.eval<{ selection: string; appearance: string }>(
    "window.catamorphicDesktop.getTheme()",
  );
  const appearance = await app.eval<string>(
    "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'",
  );
  expect(theme.selection).toBe("system");
  expect(theme.appearance).toBe(appearance);
  expect(await app.eval("document.documentElement.dataset.theme")).toBe(
    appearance,
  );
  const file = await app.eval<string>("window.catamorphicDesktop.themeFile()");
  expect(fs.existsSync(file)).toBe(false);
});

it("applies font edits to body and utility text, preserves them across presets, and resets", async () => {
  // Hidden windows do not reliably emit native focus/blur events. Dispatch
  // React's bubbling focusout event to exercise the same input save handler.
  await app.eval(`(() => {
    const input = [...document.querySelectorAll('label')].find(
      el => el.textContent.includes('Interface font')).querySelector('input');
    input.focus();
    input.value = 'Georgia, serif';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  })()`);
  await app.waitFor(
    `getComputedStyle(document.body).fontFamily === 'Georgia, serif'`,
  );
  await app.eval(`(() => {
    const input = [...document.querySelectorAll('label')].find(
      el => el.textContent.includes('Monospace font')).querySelector('input');
    input.focus();
    input.value = 'Menlo, monospace';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  })()`);
  await app.waitFor(
    `getComputedStyle(document.querySelector('.font-mono')).fontFamily === 'Menlo, monospace'`,
  );
  await app.eval(`[...document.querySelectorAll('button')].find(
    el => el.textContent.includes('Catamorphic Light')).click()`);
  await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
  expect(
    await app.eval(
      `window.catamorphicDesktop.getTheme().then(theme => theme.fonts)`,
    ),
  ).toEqual({
    sans: "Georgia, serif",
    mono: "Menlo, monospace",
  });
  await app.eval(`[...document.querySelectorAll('button')].find(
    el => el.textContent.trim() === 'Reset fonts').click()`);
  await app.waitFor(
    `document.documentElement.style.getPropertyValue('--font-sans') === ${JSON.stringify(DEFAULT_THEME_FONTS.sans)}`,
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.getTheme().then(theme => theme.fonts)`,
    ),
  ).toEqual(DEFAULT_THEME_FONTS);
});

it("applies external theme file edits live and restores defaults when keys are removed", async () => {
  const file = await app.eval<string>("window.catamorphicDesktop.themeFile()");
  fs.writeFileSync(
    file,
    JSON.stringify({
      selection: "dark",
      overrides: {},
      fonts: { sans: "Arial, sans-serif", mono: "Menlo, monospace" },
    }),
  );
  await app.waitFor(
    `getComputedStyle(document.body).fontFamily === 'Arial, sans-serif'`,
  );
  await app.waitFor(
    `getComputedStyle(document.querySelector('.font-mono')).fontFamily === 'Menlo, monospace'`,
  );
  fs.writeFileSync(file, JSON.stringify({ selection: "dark", overrides: {} }));
  await app.waitFor(
    `document.documentElement.style.getPropertyValue('--font-mono') === ${JSON.stringify(DEFAULT_THEME_FONTS.mono)}`,
  );
  await app.waitFor(
    `document.documentElement.style.getPropertyValue('--font-sans') === ${JSON.stringify(DEFAULT_THEME_FONTS.sans)}`,
  );
});
