import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  openProjectSwitcher,
  setReactValueJs,
  waitForProjectWorkspace,
  workspaceDomHelpersJs,
} from "./harness.js";

/**
 * With `tabSwitchOrder` set to recent, Next tab goes to the tab the person
 * looked at last, and to older ones while the shortcut's modifier stays
 * down; the tabs passed on the way do not count as visits (ADR 0319).
 */
let app: AppHandle;
const mac = process.platform === "darwin";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const helpers = `
  ${setReactValueJs}
  ${workspaceDomHelpersJs}
  const strip = () => $('[data-tab-orientation="horizontal"]');
  const tabs = () => [...strip().querySelectorAll('[data-point-key]')].filter((tab) => !tab.getAttribute('aria-hidden'));
  const tabByTitle = (title) => tabs().find((tab) => tab.textContent.includes(title));
  const front = () => {
    const page = [...document.querySelectorAll('webview')].find((view) => view.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    try { return page ? page.getTitle() : null; } catch { return null; }
  };
  const held = ${mac ? "{ metaKey: true }" : "{ ctrlKey: true }"};
  const nextTab = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true, ...held }));
  const release = () => window.dispatchEvent(new KeyboardEvent('keyup', { key: ${mac ? "'Meta'" : "'Control'"}, bubbles: true }));
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
const showing = (title: string) =>
  runWait(`return front() === ${JSON.stringify(title)};`, {
    label: `${title} in front`,
    timeoutMs: 30_000,
  });

const select = (title: string) =>
  run(
    `[...tabByTitle(${JSON.stringify(title)}).querySelectorAll('button')].find((b) => b.textContent.trim().length > 0).click(); return true;`,
  );
/** A key event sent into the page in front, as the keyboard sends it. */
const pageKey = (event: string) =>
  run(`
    const page = [...document.querySelectorAll('webview')].find((view) => view.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    page.focus();
    page.sendInputEvent(${event});
    return true;
  `);
const pageNextTab = `{ type: 'keyDown', keyCode: ']', modifiers: ['${mac ? "meta" : "control"}'] }`;
const pageRelease = `{ type: 'keyUp', keyCode: '${mac ? "Meta" : "Control"}' }`;

const openPage = async (title: string) => {
  // Browser tabs only: an untouched New Tab closes as another tab shows.
  const pages = `tabs().filter((tab) => tab.dataset.pointKey.startsWith('browser:')).length`;
  const before = await run<number>(`return ${pages};`);
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', bubbles: true, cancelable: true, altKey: true,
    ...(${mac} ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  const address = `[...document.querySelectorAll('input[aria-label="Address and search bar"]')].find((input) => input.checkVisibility({ visibilityProperty: true }) && input.value === '')`;
  await runWait(`return ${pages} === ${before + 1} && !!${address};`, {
    timeoutMs: 30_000,
    label: `a browser tab for ${title}`,
  });
  await run(`
    const input = ${address};
    input.focus();
    setReactValue(input, ${JSON.stringify(`data:text/html,<title>${title}</title><h1>${title}</h1>`)});
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  `);
  await showing(title);
};

beforeAll(async () => {
  app = await launchApp();
  await openProjectSwitcher(app);
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New project')",
  );
  await run(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New project').click(); return true;",
  );
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Recency'); return true;",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click(); return true;");
  await waitForProjectWorkspace({ app, name: "Recency" });
  await runWait("return !!strip() && tabs().length >= 1;", {
    timeoutMs: 60_000,
    label: "workspace ready",
  });
  // Looked at in strip order, so the last one is in front.
  for (const title of ["Alpha", "Beta", "Gamma"]) await openPage(title);
  await runWait("return tabs().length === 3;", { label: "three pages" });
});

afterAll(async () => {
  await app?.stop();
});

describe("next tab by recency", () => {
  it("goes to the last tab once the setting is on", async () => {
    await app.eval(
      "window.catamorphicDesktop.setPrefs({ tabSwitchOrder: 'recent' })",
    );
    // The window resolves its settings after the change; until then the
    // key follows the strip and wraps from Gamma to Alpha.
    for (let attempt = 0; ; attempt += 1) {
      if (attempt === 10) throw new Error("The setting never applied");
      await run("nextTab(); release(); return true;");
      const title = await runWait<string>(
        "const title = front(); return title !== 'Gamma' && title;",
        { label: "another tab in front" },
      );
      if (title === "Beta") break;
      // Look at Beta, then Gamma again, so Beta is the last tab once more.
      for (const tab of ["Beta", "Gamma"]) {
        await select(tab);
        await showing(tab);
      }
      await sleep(300);
    }
  });

  it("returns on the next press", async () => {
    await run("nextTab(); release(); return true;");
    await showing("Gamma");
  });

  it("reaches an older tab while the modifier is held", async () => {
    await run("nextTab(); return true;");
    await showing("Beta");
    await run("nextTab(); return true;");
    await showing("Alpha");
    await run("release(); return true;");
    // Beta was passed, not visited: the tab left, Gamma, is the last one.
    await run("nextTab(); release(); return true;");
    await showing("Gamma");
    expect(await run<number>("return tabs().length;")).toBe(3);
  });

  it("ends the pass when the modifier is released inside a page", async () => {
    // Gamma is in front and Alpha is the last tab. The page keeps its key
    // events: main forwards the shortcut, and the release that ends it.
    await pageKey(pageNextTab);
    await showing("Alpha");
    await pageKey(pageRelease);
    await sleep(300);
    // Released, so this press starts a new pass: back to Gamma, where an
    // open pass would have gone on to Beta.
    await pageKey(pageNextTab);
    await showing("Gamma");
    await pageKey(pageRelease);
  });
});
