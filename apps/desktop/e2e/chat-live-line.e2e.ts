import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * The line beside the activity spinner says the best a harness gives about
 * what the agent is doing (DESIGN.md, 2026-10-15): the agent's own words
 * from its thinking, held through the steps they lead to (as Codex's and
 * Claude Code's own apps keep theirs), else the running step's own
 * description, as its row says it, else a verb Work derives from the step.
 * It used to fall back to "Working..." at the first step after the agent
 * had said what it was doing.
 */
let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  ${setReactValueJs}
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim() === text);
  const frontDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  const composer = () => frontDock()?.querySelector('[data-composer-input]');
  const pressKey = (key, mods = {}) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

it("says the agent's own words through their steps, a step's description, then a verb", async () => {
  await runWait(`return !!byText('button', 'Create or import project');`, {
    timeoutMs: 120_000,
    label: "onboarding",
  });
  await run(
    `byText('button', 'Create or import project').click(); return true;`,
  );
  await runWait(
    `const input = $('[data-testid="project-name-input"]');
     if (!input) return false; setReactValue(input, 'live-line'); return true;`,
    { label: "project name input" },
  );
  await runWait(
    `const create = $('[data-testid="project-submit"]');
     if (!create || create.disabled) return false; create.click(); return true;`,
    { label: "create project" },
  );
  await runWait("return !!$('[data-workspace-ready]');", {
    timeoutMs: 60_000,
    label: "workspace ready",
  });
  await run("pressKey('n', { metaKey: true }); return true;");
  await runWait("return !!composer();", {
    timeoutMs: 20_000,
    label: "a chat to write in",
  });
  // Every line the activity line shows, in order.
  await run(`
    window.__lines = [];
    const look = () => {
      const text = frontDock()?.querySelector('[data-testid="chat-activity"] [data-testid="activity-text"]')?.textContent?.trim();
      if (text && window.__lines.at(-1) !== text) window.__lines.push(text);
    };
    window.__lineObserver = new MutationObserver(look);
    window.__lineObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;`);
  await run(`
    const input = composer(); input.focus();
    setReactValue(input, 'Fix the parser and keep the live line honest');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;`);
  await runWait(
    `const log = frontDock()?.querySelector('[role="log"]');
     return !!log && log.textContent.includes('the parser tests pass') &&
       !log.querySelector('[data-testid="chat-activity"]');`,
    { timeoutMs: 60_000, label: "the turn answered" },
  );
  const lines = await run<string[]>(
    "window.__lineObserver.disconnect(); return window.__lines;",
  );
  const at = (line: string) => lines.indexOf(line);
  // The agent's words, then a described step, then a bare command's verb.
  expect(at("Reading the parser")).toBeGreaterThanOrEqual(0);
  expect(at("Run the parser tests")).toBeGreaterThan(at("Reading the parser"));
  expect(at("Working with git...")).toBeGreaterThan(at("Run the parser tests"));
  // The steps the agent's words led to never took the line from them.
  expect(lines).not.toContain("Find where the parser walks scopes");
  expect(lines).not.toContain("Read the walker");
  expect(app.getRendererErrors()).toEqual([]);
});
