import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Legacy migration: a pre-profile install has its model config in
 * `<userData>/settings.json`. First launch must seed the default profile's
 * agent roster from it (a "Built-in" agent) — and it must actually work,
 * so starting a chat from the command palette gets a reply. Regression
 * guard for the silent-seed-skip bug (safeStorage used before app-ready
 * made the legacy key read as null, leaving the registry empty and every
 * palette chat failing with "No coding agent is configured").
 */

let app: AppHandle | undefined;

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const paletteInput = () => (
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => document.activeElement === el) ??
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => !el.closest('[inert]'))
  );
  const paletteRows = () => {
    const input = paletteInput();
    if (!input) return [];
    return [...input.closest('[role="dialog"]').querySelectorAll('[role="option"]')];
  };
  const timelineMessages = () =>
    $$('[role="log"] article').map((el) => el.textContent.trim());
`;

const run = <T>(body: string) =>
  (app as AppHandle).eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => (app as AppHandle).waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

describe("legacy settings migration", () => {
  it("seeds a Pi agent from settings.json and palette chats work", async () => {
    // A pre-profile install: model config at the userData root, no
    // per-profile agents.json anywhere.
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-e2e-legacy-"),
    );
    fs.writeFileSync(
      path.join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          apiKeyPlaintext: "sk-test-legacy-key",
        },
        null,
        2,
      )}\n`,
    );
    app = await launchApp({ userDataDir });

    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-legacy');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(`return !!$('textarea[placeholder*="Search or ask"]');`, {
      timeoutMs: 60_000,
      label: "palette New Tab after project creation",
    });

    // The seeded agent shows up in the agent picker.
    await run(
      `setReactValue(paletteInput(), 'Change default agent'); return true;`,
    );
    await runWait(
      `const opt = paletteRows().find((el) => el.textContent.includes('Change default agent'));
       if (!opt) return false;
       opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
       return true;`,
      { label: "default-agent picker" },
    );
    // The current default carries the check + "current" chip (the picker
    // pins it first; the old "· default" text suffix is gone).
    await runWait(
      `return paletteRows()
        .some((el) => el.textContent.includes('Built-in') &&
                      el.querySelector('[data-testid="palette-current"]'));`,
      { label: "seeded Pi agent marked current" },
    );
    await run(`
      paletteInput().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Backspace', bubbles: true, cancelable: true }));
      return true;
    `);

    // And a palette-started chat reaches the agent and gets a reply.
    await run(`setReactValue(paletteInput(), '@agent'); return true;`);
    await run(`
      paletteInput().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Tab', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(`return !!$('[data-testid="palette-mode-chip"]');`, {
      label: "agent chip committed",
    });
    await run(
      `setReactValue(paletteInput(), 'hello from legacy seed'); return true;`,
    );
    await run(`
      paletteInput().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    `);
    await runWait(
      `return timelineMessages().some((m) => m.includes('You said: hello from legacy seed'));`,
      { timeoutMs: 30_000, label: "agent reply from palette-started chat" },
    );
  });
});
