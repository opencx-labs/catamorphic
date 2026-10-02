import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Sleeping tabs (ADR 0194). A minute lasts 25 ms here, so the default hour
 * out of sight is 1.5 seconds.
 */
const SLEEP_ENV = { CATAMORPHIC_E2E_TAB_SLEEP_MINUTE_MS: "25" };

let app: AppHandle;
let origin: string;
const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  res.writeHead(200, { "Content-Type": "text/html" });
  if (path === "/form") {
    res.end(
      // Controlled like a React field: its default follows its value.
      '<title>Sleep form</title><input id="note" aria-label="Note" autocomplete="off" oninput="this.defaultValue = this.value">',
    );
    return;
  }
  const name = path.replace(/^\/long\//, "");
  res.end(
    `<title>Sleep fixture ${name}</title><body style="height:6000px;margin:0"><h1>Page ${name}</h1></body>`,
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ env: SLEEP_ENV });
  await createProject("Sleep fixture");
});
afterAll(async () => {
  await app?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createProject(name: string) {
  const create = `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create or import project')`;
  await app.waitFor(`!!${create}`);
  await app.eval(`${create}.click()`);
  await app.waitFor(
    `!!document.querySelector('[data-testid="project-name-input"]')`,
  );
  await app.eval(
    `(()=>{${setReactValueJs};setReactValue(document.querySelector('[data-testid="project-name-input"]'),${JSON.stringify(name)})})()`,
  );
  await app.waitFor(
    `(()=>{const b=document.querySelector('[data-testid="project-submit"]');if(b&&!b.disabled){b.click();return true}return false})()`,
  );
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')", {
    label: "workspace ready",
  });
}

const shortcut = (key: string, alt = false) =>
  app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),altKey:${alt},bubbles:true}))`,
  );

/** The webview showing `title`, as an expression. */
const pageWith = (title: string) =>
  `[...document.querySelectorAll('webview')].find((view) => { try { return view.getTitle() === ${JSON.stringify(title)} && !view.isLoading(); } catch { return false; } })`;
const inPage = <T = unknown>(title: string, code: string) =>
  app.eval<T>(`${pageWith(title)}.executeJavaScript(${JSON.stringify(code)})`);
const pageReady = (title: string) =>
  app.waitFor(`!!${pageWith(title)}`, { label: `${title} loaded` });

/** A new browser tab at `path`, focused. */
async function openTab(path: string, title: string) {
  await newTab();
  await app.eval(
    `(()=>{${setReactValueJs};setReactValue(document.activeElement,${JSON.stringify(origin + path)})})()`,
  );
  await app.press("Enter");
  await pageReady(title);
}
/** An empty New Tab in front, which hides every page tab. */
async function newTab() {
  await shortcut("t", true);
  await app.waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Address and search bar'`,
    { label: "new tab address bar focused" },
  );
}
const tabButton = (title: string) =>
  `[...document.querySelectorAll('[data-tab-orientation] button')].find((b) => b.textContent.includes(${JSON.stringify(title)}))`;
const showTab = async (title: string) => {
  await app.waitFor(`!!${tabButton(title)}`, { label: `${title} tab` });
  await app.eval(`${tabButton(title)}.click()`);
};
const asleep = (title: string) =>
  `!!${tabButton(title)}?.querySelector('[data-tab-asleep]')`;
const pageTargets = async () => {
  const { targetInfos } = (await app.cdp("Target.getTargets")) as {
    targetInfos: { url: string }[];
  };
  return targetInfos.map((target) => target.url);
};

describe("sleeping tabs", () => {
  it("unloads an unseen tab and wakes it where it was", async () => {
    await openTab("/long/a", "Sleep fixture a");
    await inPage("Sleep fixture a", `location.href = "${origin}/long/b"`);
    await pageReady("Sleep fixture b");
    await inPage("Sleep fixture b", "scrollTo(0, 1234)");
    // Chromium commits the scroll position into the page state about a
    // second after it settles.
    await app.eval("new Promise((resolve) => setTimeout(resolve, 3000))");

    await newTab();
    await app.waitFor(asleep("Sleep fixture b"), {
      label: "hidden tab asleep",
    });
    expect(await app.eval(`!!${pageWith("Sleep fixture b")}`)).toBe(false);
    expect(await pageTargets()).not.toContain(`${origin}/long/b`);

    await showTab("Sleep fixture b");
    await pageReady("Sleep fixture b");
    await app.waitFor(
      `${pageWith("Sleep fixture b")}.executeJavaScript("scrollY").then((y) => y === 1234)`,
      { label: "scroll position kept" },
    );
    expect(await app.eval(asleep("Sleep fixture b"))).toBe(false);
    expect(await app.eval(`${pageWith("Sleep fixture b")}.canGoBack()`)).toBe(
      true,
    );
    await app.eval(`${pageWith("Sleep fixture b")}.goBack()`);
    await pageReady("Sleep fixture a");
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("keeps a page with unsent typed text awake until it is cleared", async () => {
    await inPage("Sleep fixture a", `location.href = "${origin}/form"`);
    await pageReady("Sleep form");
    await app.eval(`${pageWith("Sleep form")}.focus(); true`);
    await inPage("Sleep form", "document.querySelector('#note').focus()");
    await app.insertText("half a thought");
    expect(
      await inPage("Sleep form", "document.querySelector('#note').value"),
    ).toBe("half a thought");

    await newTab();
    // Several sleep periods pass; the page keeps its text and its guest.
    await app.eval("new Promise((resolve) => setTimeout(resolve, 5000))");
    expect(await app.eval(asleep("Sleep form"))).toBe(false);
    expect(
      await inPage("Sleep form", "document.querySelector('#note').value"),
    ).toBe("half a thought");

    await showTab("Sleep form");
    await app.eval(`${pageWith("Sleep form")}.focus(); true`);
    await inPage("Sleep form", "document.querySelector('#note').select()");
    await app.press("Backspace");
    await app.waitFor(
      `${pageWith("Sleep form")}.executeJavaScript("document.querySelector('#note').value === ''")`,
      { label: "typed text cleared" },
    );
    await newTab();
    await app.waitFor(asleep("Sleep form"), { label: "cleared page asleep" });
  });

  it("restores a workspace with only its shown tab loaded", async () => {
    await openTab("/long/c", "Sleep fixture c");
    // The workspace saves shortly after it changes.
    await app.waitFor(
      `window.catamorphicDesktop.getPrefs().then((prefs) => window.catamorphicDesktop.workspaceStateGet(prefs.lastProjectId)).then((saved) => JSON.stringify(saved ?? null).includes("/long/c"))`,
      { label: "workspace saved" },
    );
    const userDataDir = app.userDataDir;
    await app.stop({ preserveUserData: true });
    app = await launchApp({ userDataDir, env: SLEEP_ENV });
    await app.waitFor("!!document.querySelector('[data-workspace-ready]')", {
      label: "workspace restored",
      timeoutMs: 60_000,
    });
    await pageReady("Sleep fixture c");
    await app.waitFor(asleep("Sleep form"), { label: "restored tab asleep" });
    expect(await pageTargets()).not.toContain(`${origin}/form`);

    await showTab("Sleep form");
    await pageReady("Sleep form");
    expect(await app.eval(asleep("Sleep form"))).toBe(false);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
