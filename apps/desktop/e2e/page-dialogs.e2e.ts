import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  pointerOnPage,
  setReactValueJs,
} from "./harness.js";
import { pressNativeMacKey } from "./native-pointer.js";

/**
 * Pages ask through Work's dialogs (ADR 0227): alert, confirm and prompt
 * from the page and its frames, "Leave site?" when a beforeunload holds a
 * reload, a navigation or a close, and HTTP sign-ins. Each dialog sits
 * over its own tab, which waits while the rest of Work carries on.
 */
let app: AppHandle;
let origin: string;
let otherOrigin: string;
const AUTH = `Basic ${Buffer.from("work:secret").toString("base64")}`;

const server = http.createServer((request, response) => {
  const url = request.url ?? "/";
  response.setHeader("Content-Type", "text/html");
  if (url.startsWith("/auth")) {
    if (request.headers.authorization !== AUTH) {
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", 'Basic realm="Work test"');
      response.end("<title>Unauthorized</title><p>Sign-in required</p>");
      return;
    }
    response.end("<title>Signed in</title><p>Welcome</p>");
    return;
  }
  if (url.startsWith("/frame")) {
    // A frame that asks when its parent tells it to.
    response.end(`<title>Frame</title><script>
      addEventListener('message', (event) => {
        if (event.data === 'alert') alert('From the frame');
      });
    </script>`);
    return;
  }
  if (url.startsWith("/unload")) {
    response.end(`<title>Unload</title>
      <a id="away" href="/plain?from=link">Away</a>
      <script>
        addEventListener('beforeunload', (event) => {
          event.preventDefault();
          event.returnValue = '';
        });
      </script>`);
    return;
  }
  if (url.startsWith("/leaving-alert")) {
    // Chrome refuses dialogs from a page that is being left, even one that
    // takes apart what the check reads first.
    response.end(`<title>Leaving alert</title><script>
      addEventListener('beforeunload', () => {
        Function.prototype.call = function () {};
        Reflect.apply = function () {};
        Object.defineProperty(Event.prototype, 'type', { get: () => 'click' });
        alert('Leaving');
      });
      addEventListener('pagehide', () => { alert('Hiding'); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') confirm('Hidden?');
      });
    </script>`);
    return;
  }
  if (url.startsWith("/sandboxed")) {
    // A sandboxed frame calling alert in a loop, with long text.
    const frame = `<script>
      for (let i = 0; i < 100000; i++) alert('x'.repeat(20000));
      parent.postMessage('done', '*');
    </script>`;
    response.end(`<title>Sandboxed</title><script>
      addEventListener('message', () => { document.title = 'Sandboxed done'; });
    </script>
    <iframe sandbox="allow-scripts" srcdoc="${frame.replaceAll('"', "&quot;")}"></iframe>`);
    return;
  }
  if (url.startsWith("/dialogs")) {
    response.end(`<title>Dialogs</title><p>Dialogs lab</p>
      <button onclick="window.answer = confirm('Proceed?')">Ask confirmation</button>
      <button onclick="window.named = prompt('Name?', 'Ada')">Ask name</button>
      <iframe id="same" src="/frame"></iframe>
      <iframe id="other" src="${otherOrigin}/frame"></iframe>`);
    return;
  }
  response.end("<title>Plain</title><p>Plain page</p>");
});

const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
/** A picture for review, once the dialog's entrance has settled. */
const shot = async (name: string) => {
  if (!artifacts) return;
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.screenshot(path.join(artifacts, `${name}.png`));
};

/** Hidden tabs stay laid out (invisible), so "on screen" asks visibility. */
const SHOWN = `((element) => element.checkVisibility({ visibilityProperty: true }))`;
/** The page on screen. */
const VIEW = `[...document.querySelectorAll('webview')].find(${SHOWN})`;
/** Its dialog, if it shows one. */
const DIALOG = `${VIEW}?.parentElement.querySelector('[data-testid="page-dialog"]:not([inert])')`;
const ACTIVE_KEY = `document.querySelector('[data-point-key] [aria-current="true"]')?.closest('[data-point-key]')?.dataset.pointKey`;
const ADDRESS = `[...document.querySelectorAll('input[aria-label="Address and search bar"]')].find(${SHOWN})`;
const host = (url: string) => url.slice("http://".length);

/** Where the record of every dialog list main sent stands now. */
const markDialogs = () => app.eval<number>("window.__dialogLists.length");
/** The dialog kinds each list main sent since `mark` held. */
const dialogsSince = (mark: number) =>
  app.eval<string[][]>(`window.__dialogLists.slice(${mark})`);

/** Run script in the page with a user gesture, without waiting for it. */
const start = (code: string, gesture = true) =>
  app.eval<string>(`(() => {
    const id = Math.random().toString(36).slice(2);
    window.__runs ??= {};
    window.__runs[id] = { done: false };
    ${VIEW}.executeJavaScript(${JSON.stringify(code)}, ${gesture}).then(
      (value) => { window.__runs[id] = { done: true, value }; },
      (error) => { window.__runs[id] = { done: true, error: String(error) }; },
    );
    return id;
  })()`);
/** What a started script returned, once it did. */
const finished = async (id: string) =>
  JSON.parse(
    await app.waitFor<string>(
      `window.__runs[${JSON.stringify(id)}].done && JSON.stringify(window.__runs[${JSON.stringify(id)}])`,
      { label: "the page's script returned" },
    ),
  ) as { done: true; value?: unknown; error?: string };
const running = (id: string) =>
  app.eval<boolean>(`!window.__runs[${JSON.stringify(id)}].done`);
const inPage = <T>(code: string) =>
  app.eval<T>(`${VIEW}.executeJavaScript(${JSON.stringify(code)})`);
/** A press in the page as the person makes one, not a script's gesture. */
const pressInPage = async () => {
  const point = await app.eval<{ x: number; y: number }>(`(() => {
    const box = ${VIEW}.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  await pointerOnPage(app, { view: VIEW, selector: "html", point });
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
};

const dialogShows = (kind: string) =>
  app.waitFor(`${DIALOG}?.dataset.kind === ${JSON.stringify(kind)}`, {
    label: `${kind} dialog shows`,
  });
const dialogGone = () => app.waitFor(`!${DIALOG}`, { label: "dialog gone" });
const text = (testId: string) =>
  app.eval<string>(
    `${DIALOG}?.querySelector('[data-testid="${testId}"]')?.textContent ?? ''`,
  );
const click = (testId: string) =>
  app.eval(
    `${DIALOG}.querySelector('[data-testid="${testId}"]').click(); true`,
  );
const focusInDialog = () =>
  app.waitFor(`!!${DIALOG}?.contains(document.activeElement)`, {
    label: "focus in the dialog",
  });
const title = () =>
  app.eval<string>(
    `(() => { try { return ${VIEW}.getTitle(); } catch { return ''; } })()`,
  );
const loaded = (expected: string) =>
  app.waitFor(
    `(() => { try { const page = ${VIEW}; return page.getTitle() === ${JSON.stringify(expected)} && !page.isLoading(); } catch { return false; } })()`,
    { label: `${expected} loaded` },
  );
/** Type an address and press Enter, as the person does. */
const go = async (url: string) => {
  await app.eval(`(() => {
    ${setReactValueJs}
    const input = ${ADDRESS};
    input.focus();
    setReactValue(input, ${JSON.stringify(url)});
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
};
const newTab = async () => {
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', altKey: true, bubbles: true, cancelable: true,
    ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  await app.waitFor(`!!${ADDRESS} && document.activeElement === ${ADDRESS}`, {
    label: "new tab's address bar",
  });
};
/** macOS menu accelerator, or input sent to the actual guest on Linux. */
const closePageKey = async () => {
  if (process.platform === "darwin") await pressNativeMacKey("w", ["command"]);
  else
    await app.eval(`(() => {
      const page = ${VIEW};
      for (const type of ['keyDown', 'keyUp'])
        page.sendInputEvent({ type, keyCode: 'W', modifiers: ['control'] });
      return true;
    })()`);
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  otherOrigin = `http://localhost:${address.port}`;
  app = await launchApp();
  await app.eval(`window.catamorphicDesktop.createProject({
    name: 'Dialog lab',
    rootPath: ${JSON.stringify(`${app.userDataDir}/dialog-lab`)}
  })`);
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Dialog lab')`, {
    timeoutMs: 30_000,
    label: "project workspace",
  });
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')", {
    label: "workspace ready for shortcuts",
  });
  // Every dialog list main sends, to tell what showed even for a moment.
  await app.eval(`(() => {
    window.__dialogLists = [];
    window.catamorphicDesktop.onPageDialogs((change) =>
      window.__dialogLists.push(change.dialogs.map((dialog) => dialog.kind)));
    return true;
  })()`);
  await newTab();
  await go(`${origin}/dialogs`);
  await loaded("Dialogs");
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("page dialogs", () => {
  it("a confirm waits over its tab: Escape cancels, Enter accepts", async () => {
    const run = await start("confirm('Delete this draft?')");
    await dialogShows("confirm");
    expect(await text("page-dialog-title")).toBe(`${host(origin)} says`);
    expect(await text("page-dialog-message")).toBe("Delete this draft?");
    // Over this tab's page, not the window.
    expect(
      await app.eval<boolean>(`${VIEW}.parentElement.contains(${DIALOG})`),
    ).toBe(true);
    await focusInDialog();
    // The page waits.
    expect(await running(run)).toBe(true);
    await shot("page-dialog-confirm");
    await app.press("Escape");
    await dialogGone();
    expect((await finished(run)).value).toBe(false);

    const again = await start("confirm('Keep going?')");
    await dialogShows("confirm");
    await focusInDialog();
    await app.press("Enter");
    await dialogGone();
    expect((await finished(again)).value).toBe(true);
    // Focus is back on the page.
    await app.waitFor(`document.activeElement === ${VIEW}`, {
      label: "focus back on the page",
    });
  });

  it("an alert's text stays text, and a long one scrolls", async () => {
    const message = `<b>bold</b>\n${"word ".repeat(3000).trim()}`;
    const run = await start(`alert(${JSON.stringify(message)})`);
    await dialogShows("alert");
    expect(await text("page-dialog-message")).toBe(message);
    expect(
      await app.eval<boolean>(
        `!${DIALOG}.querySelector('[data-testid="page-dialog-message"] b')`,
      ),
    ).toBe(true);
    expect(
      await app.eval<boolean>(`(() => {
        const box = ${DIALOG}.querySelector('[data-testid="page-dialog-message"]');
        return box.scrollHeight > box.clientHeight;
      })()`),
    ).toBe(true);
    // An alert has only OK.
    expect(
      await app.eval<boolean>(
        `!${DIALOG}.querySelector('[data-testid="page-dialog-cancel"]')`,
      ),
    ).toBe(true);
    await shot("page-dialog-long-alert");
    await click("page-dialog-accept");
    await dialogGone();
    expect(await finished(run)).toEqual({ done: true });
  });

  it("a prompt offers its default and returns what was typed, or null", async () => {
    const run = await start("prompt('Your name?', 'Ada')");
    await dialogShows("prompt");
    const input = `${DIALOG}.querySelector('[data-testid="page-dialog-input"]')`;
    await app.waitFor(`document.activeElement === ${input}`, {
      label: "prompt field focused",
    });
    expect(await app.eval<string>(`${input}.value`)).toBe("Ada");
    expect(
      await app.eval<boolean>(
        `${input}.selectionStart === 0 && ${input}.selectionEnd === 3`,
      ),
    ).toBe(true);
    await app.insertText("Grace");
    await shot("page-dialog-prompt");
    await app.press("Enter");
    await dialogGone();
    expect((await finished(run)).value).toBe("Grace");

    const cancelled = await start("prompt('Your name?')");
    await dialogShows("prompt");
    await click("page-dialog-cancel");
    await dialogGone();
    expect((await finished(cancelled)).value).toBeNull();
  });

  it("an embedded frame of another site is named, and a frame of the page's own is the page", async () => {
    await start(
      "document.getElementById('other').contentWindow.postMessage('alert', '*')",
    );
    await dialogShows("alert");
    expect(await text("page-dialog-title")).toBe(
      `An embedded page at ${host(otherOrigin)} says`,
    );
    expect(await text("page-dialog-message")).toBe("From the frame");
    await shot("page-dialog-embedded");
    await click("page-dialog-accept");
    await dialogGone();
    await start(
      "document.getElementById('same').contentWindow.postMessage('alert', '*')",
    );
    await dialogShows("alert");
    expect(await text("page-dialog-title")).toBe(`${host(origin)} says`);
    await click("page-dialog-accept");
    await dialogGone();
  });

  it("a page that keeps asking can be told to stop, until it loads again", async () => {
    // This page load has asked before: the next dialog offers the stop.
    const run = await start("confirm('Again?')");
    await dialogShows("confirm");
    await app.eval(
      `${DIALOG}.querySelector('[data-testid="page-dialog-suppress"]').click(); true`,
    );
    await shot("page-dialog-suppress");
    await click("page-dialog-accept");
    await dialogGone();
    expect((await finished(run)).value).toBe(true);
    // Stopped: answered at once, as Chrome does.
    expect(await finished(await start("confirm('More?')"))).toEqual({
      done: true,
      value: false,
    });
    expect(await finished(await start("prompt('More?')"))).toEqual({
      done: true,
      value: null,
    });
    expect(await app.eval<boolean>(`!${DIALOG}`)).toBe(true);
    await app.eval(`${VIEW}.reload(); true`);
    await loaded("Dialogs");
    const fresh = await start("confirm('Fresh page?')");
    await dialogShows("confirm");
    expect(
      await app.eval<boolean>(
        `!${DIALOG}.querySelector('[data-testid="page-dialog-suppress"]')`,
      ),
    ).toBe(true);
    await click("page-dialog-accept");
    expect((await finished(fresh)).value).toBe(true);
  });

  it("the dialog stays with its tab while another tab works, and its tab says it waits", async () => {
    const dialogsKey = await app.eval<string>(ACTIVE_KEY);
    const run = await start("prompt('Still there?', 'yes')");
    await dialogShows("prompt");
    await newTab();
    await go(`${origin}/plain`);
    await loaded("Plain");
    // The other tab answers while the first waits.
    expect(await inPage<string>("document.title")).toBe("Plain");
    expect(await app.eval<boolean>(`!${DIALOG}`)).toBe(true);
    await app.waitFor(
      `!!document.querySelector('[data-point-key=${JSON.stringify(dialogsKey)}][data-page-dialog]')`,
      { label: "the waiting tab shows it waits" },
    );
    await shot("page-dialog-waiting-tab");
    expect(await running(run)).toBe(true);
    // Back to it: the dialog is there and takes focus.
    await app.eval(
      `document.querySelector('[data-point-key=${JSON.stringify(dialogsKey)}] button').click(); true`,
    );
    await dialogShows("prompt");
    await focusInDialog();
    await app.press("Enter");
    expect((await finished(run)).value).toBe("yes");
    await app.waitFor(
      `!document.querySelector('[data-point-key=${JSON.stringify(dialogsKey)}][data-page-dialog]')`,
      { label: "the tab no longer waits" },
    );
  });

  it("a navigation cancels the page's dialog", async () => {
    await start(
      "sessionStorage.setItem('answer', String(prompt('Before you go?')))",
    );
    await dialogShows("prompt");
    await go(`${origin}/plain?after=prompt`);
    await loaded("Plain");
    expect(await app.eval<boolean>(`!${DIALOG}`)).toBe(true);
    expect(await inPage<string>("sessionStorage.getItem('answer')")).toBe(
      "null",
    );
  });

  it("a page that is being left shows no dialog, not even for a moment", async () => {
    await go(`${origin}/leaving-alert`);
    await loaded("Leaving alert");
    await finished(await start("document.body.click()"));
    const mark = await markDialogs();
    await go(`${origin}/plain?after=leaving-alert`);
    await loaded("Plain");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await dialogsSince(mark)).filter((kinds) => kinds.length > 0),
    ).toEqual([]);
  });

  it("a sandboxed frame calling alert in a loop asks nothing and holds nothing up", async () => {
    const mark = await markDialogs();
    await go(`${origin}/sandboxed`);
    // Each call is refused in the frame itself, without a trip to main.
    await loaded("Sandboxed done");
    expect(
      (await dialogsSince(mark)).filter((kinds) => kinds.length > 0),
    ).toEqual([]);
  });

  it("Leave site? holds a reload, an address and a link, and Leave goes on", async () => {
    await go(`${origin}/unload`);
    await loaded("Unload");
    // A page the person used: Chrome asks only then.
    await finished(await start("document.body.click()"));
    await app.eval(
      `[...document.querySelectorAll('button[aria-label="Reload"]')].find(${SHOWN}).click(); true`,
    );
    await dialogShows("beforeunload");
    expect(await text("page-dialog-title")).toBe("Reload site?");
    await click("page-dialog-cancel");
    await dialogGone();
    expect(await title()).toBe("Unload");

    await go(`${origin}/plain?from=address`);
    await dialogShows("beforeunload");
    expect(await text("page-dialog-title")).toBe("Leave site?");
    await shot("page-dialog-leave-site");
    await focusInDialog();
    await app.press("Escape");
    await dialogGone();
    expect(await title()).toBe("Unload");
    // The address shows the page that stayed.
    await app.waitFor(`${ADDRESS}.value.includes('/unload')`, {
      label: "address back on the page",
    });
    await go(`${origin}/plain?from=address`);
    await dialogShows("beforeunload");
    // While the person reads it, the page tries to go elsewhere: Leave
    // still goes where they asked.
    await finished(await start("location.href = '/plain?from=page'", false));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await app.eval<string>(`${DIALOG}?.dataset.kind`)).toBe(
      "beforeunload",
    );
    await click("page-dialog-accept");
    await loaded("Plain");
    expect(await inPage<string>("location.search")).toBe("?from=address");

    // The page's own link: Leave follows it.
    await go(`${origin}/unload`);
    await loaded("Unload");
    await start("document.getElementById('away').click()");
    await dialogShows("beforeunload");
    await click("page-dialog-accept");
    await loaded("Plain");
    expect(await inPage<string>("location.search")).toBe("?from=link");
  });

  it("closes an interacted busy page without an app-owned waiting period", async () => {
    await newTab();
    await go(`${origin}/plain`);
    await loaded("Plain");
    await focusWindow(app);
    await pressInPage();
    const key = await app.eval<string>(ACTIVE_KEY);
    // A busy app such as a calendar must not answer a script probe before
    // its tab can leave. No beforeunload handler: nothing asks to stay.
    await start(
      `setTimeout(() => {
      document.title = 'Busy';
      const end = performance.now() + 5_000;
      while (performance.now() < end) {}
    }, 0); true`,
      false,
    );
    await app.waitFor(
      `(() => { try { return ${VIEW}.getTitle() === 'Busy'; } catch { return false; } })()`,
      {
        label: "the page's renderer is busy",
      },
    );
    await app.eval(`(() => {
      const tab = document.querySelector('[data-point-key=${JSON.stringify(key)}]');
      const start = performance.now();
      window.__tabCloseMs = null;
      const observer = new MutationObserver(() => {
        if (tab.isConnected) return;
        window.__tabCloseMs = performance.now() - start;
        observer.disconnect();
      });
      observer.observe(tab.parentElement, { childList: true });
      return true;
    })()`);
    await closePageKey();
    const elapsed = await app.waitFor<number>("window.__tabCloseMs", {
      label: "the interacted tab closed",
    });
    console.info("[page-dialogs] interacted tab closed in", elapsed, "ms");
    // Allows the tab's exit motion and slow CI frames, but not a timeout
    // waiting for the busy renderer or a lost guest close event.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("a tab whose page nobody touched closes at once, its beforeunload never asked", async () => {
    await newTab();
    await go(`${origin}/unload`);
    await loaded("Unload");
    const key = await app.eval<string>(ACTIVE_KEY);
    const tab = `document.querySelector('[data-point-key=${JSON.stringify(key)}]')`;
    const mark = await markDialogs();
    await app.eval(
      `${tab}.querySelector('button[aria-label^="Close"]').click(); true`,
    );
    await app.waitFor(`!${tab}`, { label: "the untouched tab closed" });
    expect(
      (await dialogsSince(mark)).filter((kinds) => kinds.length > 0),
    ).toEqual([]);
  });

  it("a newly committed document does not inherit the previous page's interaction", async () => {
    await newTab();
    await go(`${origin}/plain`);
    await loaded("Plain");
    await pressInPage();
    await go(`${origin}/unload`);
    await loaded("Unload");
    const key = await app.eval<string>(ACTIVE_KEY);
    const mark = await markDialogs();
    await focusWindow(app);
    await app.eval(`${VIEW}.focus(); true`);
    await closePageKey();
    await app.waitFor(
      `!document.querySelector('[data-point-key=${JSON.stringify(key)}]')`,
      { label: "untouched replacement document closed by shortcut" },
    );
    expect((await dialogsSince(mark)).filter((kinds) => kinds.length)).toEqual(
      [],
    );
  });

  it("closing a tab asks its page, and Cancel keeps the tab", async () => {
    await go(`${origin}/unload`);
    await loaded("Unload");
    // A real press: a tab whose page nobody touched closes without asking.
    await pressInPage();
    // The click's own activation has passed (Chromium's lasts 5 seconds).
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(await inPage<boolean>("navigator.userActivation.isActive")).toBe(
      false,
    );
    const key = await app.eval<string>(ACTIVE_KEY);
    const close = `document.querySelector('[data-point-key=${JSON.stringify(key)}] button[aria-label^="Close"]').click(); true`;
    await app.eval(close);
    await dialogShows("beforeunload");
    expect(await text("page-dialog-title")).toBe("Leave site?");
    // Electron grants the page an activation as it asks; the page opens
    // no window with it while the question is open.
    console.info(
      "[page-dialogs] activation while the close asks:",
      await inPage<boolean>("navigator.userActivation.isActive"),
    );
    const tabs = `document.querySelectorAll('[data-point-key^="browser:"]').length`;
    const before = await app.eval<number>(tabs);
    await inPage("window.open('/plain?from=popup'); true");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await app.eval<number>(tabs)).toBe(before);
    await click("page-dialog-cancel");
    await dialogGone();
    expect(
      await app.eval<boolean>(
        `!!document.querySelector('[data-point-key=${JSON.stringify(key)}]')`,
      ),
    ).toBe(true);
    await app.eval(close);
    await dialogShows("beforeunload");
    await click("page-dialog-accept");
    await app.waitFor(
      `!document.querySelector('[data-point-key=${JSON.stringify(key)}]')`,
      { label: "the tab closed" },
    );
  });

  it("a sign-in asks in the tab: Cancel shows the 401 page, a wrong password asks again, the right one signs in", async () => {
    await go(`${origin}/auth`);
    await dialogShows("auth");
    expect(await text("page-dialog-title")).toBe("Sign in");
    expect(await text("page-dialog-origin")).toBe(host(origin));
    expect(await text("page-dialog-realm")).toContain("Work test");
    await focusInDialog();
    await shot("page-dialog-sign-in");
    await click("page-dialog-cancel");
    await loaded("Unauthorized");
    expect(await inPage<string>("document.body.innerText")).toContain(
      "Sign-in required",
    );

    // Many requests for the same sign-in ask once, as in Chrome.
    const mark = await markDialogs();
    const fetches = await start(
      "Promise.all(Array.from({ length: 6 }, () => fetch('/auth?api').then((response) => response.status)))",
    );
    await dialogShows("auth");
    for (let round = 0; round < 20 && (await running(fetches)); round++) {
      if (await app.eval<boolean>(`!!${DIALOG}`))
        await click("page-dialog-cancel");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect((await finished(fetches)).value).toEqual(Array(6).fill(401));
    expect(
      Math.max(...(await dialogsSince(mark)).map((kinds) => kinds.length)),
    ).toBe(1);

    await go(`${origin}/auth?again`);
    await dialogShows("auth");
    const field = (id: string) =>
      `${DIALOG}?.querySelector('[data-testid="${id}"]')`;
    await app.eval(`(() => {
      ${setReactValueJs}
      setReactValue(${field("page-dialog-username")}, 'work');
      setReactValue(${field("page-dialog-password")}, 'wrong');
      return true;
    })()`);
    await click("page-dialog-accept");
    // Refused: asked again, with the username kept.
    await app.waitFor(
      `${DIALOG}?.dataset.kind === 'auth' && ${field("page-dialog-username")}?.value === 'work' && !!${DIALOG}.querySelector('[role="alert"]')`,
      { label: "asked again" },
    );
    await focusInDialog();
    await shot("page-dialog-sign-in-retry");
    await app.insertText("secret");
    // Clicked: an Enter's key-up would follow focus back into a page that
    // is loading, and the test's key input waits for it.
    await click("page-dialog-accept");
    await loaded("Signed in");
    // The sign-in that worked is offered for saving.
    await app.waitFor(
      `document.querySelector('[data-testid="password-prompt"]')?.dataset.kind === 'save'`,
      { label: "save offer" },
    );
  });
});

describe("agents and page dialogs", () => {
  let serial = 0;
  const helpers = `${setReactValueJs}
const composer=()=>[...document.querySelectorAll('section[aria-label]')].find(el=>!el.closest('[inert]') && el.querySelector('[data-composer-input]'))?.querySelector('[data-composer-input]');
const logs=()=>[...document.querySelectorAll('[role="log"]')].map(el=>el.textContent).join('\\n');`;
  /** A workspace tool, called by the fake agent as a model would. */
  const tool = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    serial++;
    const prefix = `E2E result ${serial}: `;
    const prompt = `E2E workspace tool ${JSON.stringify({ name, input, serial })}`;
    // The call before has ended: this one is a turn of its own (ADR 0240).
    await app.waitFor(
      `(()=>{${helpers};const section=composer()?.closest('section[aria-label]');return !!section && !section.querySelector('[data-testid="chat-stop"]');})()`,
      { label: "the call before settled" },
    );
    await app.eval(
      `(()=>{${helpers};setReactValue(composer(),${JSON.stringify(prompt)});composer().closest('form').requestSubmit();})()`,
    );
    const result = await app.waitFor<string>(
      `(()=>{${helpers};const text=logs();const start=text.lastIndexOf(${JSON.stringify(prefix)});return start<0?false:text.slice(start+${prefix.length}).split('E2E end')[0];})()`,
      { label: `${name} result` },
    );
    return JSON.parse(result);
  };

  const openChat = async () => {
    await app.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true})); true`,
    );
    await app.waitFor(`(()=>{${helpers};return !!composer();})()`, {
      label: "chat composer",
    });
  };

  it("an agent reads the page's dialog and answers as a person would, but a sign-in is the person's", async () => {
    await openChat();
    const { key } = await tool("open_browser", { url: `${origin}/dialogs` });
    expect(
      await tool("browser_act", {
        key,
        action: "wait_for",
        text: "Dialogs lab",
      }),
    ).toEqual({ found: true });

    const buttonUid = async (label: string) => {
      const snapshot = await tool("browser_snapshot", { key });
      const button = Array.isArray(snapshot.elements)
        ? snapshot.elements.find(
            (element: unknown): element is { uid: string } =>
              typeof element === "object" &&
              element !== null &&
              "label" in element &&
              element.label === label &&
              "uid" in element &&
              typeof element.uid === "string",
          )
        : undefined;
      if (!button) throw new Error(`Page button not found: ${label}`);
      return button.uid;
    };

    // What opens a dialog reports it instead of hanging on the page.
    // Page-owned handlers keep waiting while the agent inspects the dialog;
    // an agent's bounded Runtime.evaluate would time out after 10 seconds.
    const opened = await tool("browser_act", {
      key,
      action: "click",
      uid: await buttonUid("Ask confirmation"),
    });
    expect(opened.dialog).toMatchObject({
      kind: "confirm",
      message: "Proceed?",
      origin,
    });
    expect(String(opened.note)).toContain("press");
    // Clearing pointers does not wait on a page that waits on its dialog.
    expect(await tool("point_at", { target: null })).toEqual({ ok: true });
    expect((await tool("browser_snapshot", { key })).dialog).toMatchObject({
      kind: "confirm",
    });
    expect(
      String((await tool("browser_act", { key, action: "read" })).error ?? ""),
    ).toContain("waits on a dialog");
    expect(
      await tool("browser_act", { key, action: "press", press_key: "Enter" }),
    ).toEqual({ ok: true, answered: "confirm", accepted: true });
    expect(
      await tool("browser_act", {
        key,
        action: "evaluate",
        expression: "window.answer",
      }),
    ).toMatchObject({ value: true });

    // A prompt's field takes fill, and Enter sends it.
    const prompt = await tool("browser_act", {
      key,
      action: "click",
      uid: await buttonUid("Ask name"),
    });
    expect(prompt.dialog).toMatchObject({
      kind: "prompt",
      uid: "dialog",
      value: "Ada",
    });
    expect(
      await tool("browser_act", {
        key,
        action: "fill",
        uid: "dialog",
        text: "Grace",
      }),
    ).toEqual({ ok: true });
    await tool("browser_act", { key, action: "press", press_key: "Enter" });
    expect(
      await tool("browser_act", {
        key,
        action: "evaluate",
        expression: "window.named",
      }),
    ).toMatchObject({ value: "Grace" });

    // A sign-in is the person's. (Another origin: the profile remembers
    // the sign-in the person made above, as Chrome does.) They have one
    // saved for it.
    await app.eval(`window.catamorphicDesktop.profilesList().then((data) =>
      window.catamorphicDesktop.vaultSave({
        profileId: data.defaultProfileId,
        origin: ${JSON.stringify(otherOrigin)},
        username: 'work',
        password: 'secret',
      })).then(() => true)`);
    const signIn = await tool("browser_act", {
      key,
      action: "navigate",
      url: `${otherOrigin}/auth?agent`,
    });
    expect(signIn.dialog).toMatchObject({
      kind: "auth",
      origin: otherOrigin,
      realm: "Work test",
    });
    expect(String(signIn.note)).toContain("Never answer a sign-in");
    expect(
      String(
        (
          await tool("browser_act", {
            key,
            action: "press",
            press_key: "Enter",
          })
        ).error ?? "",
      ),
    ).toContain("only the person answers");
    // The person comes to the tab and signs in with the saved sign-in,
    // whose password main reads from the vault.
    await app.eval(
      `document.querySelector('[data-point-key=${JSON.stringify(key)}] button').click(); true`,
    );
    await dialogShows("auth");
    expect(await text("page-dialog-saved")).toContain("work");
    // The chat floating over the page stays in reach, above the dialog.
    expect(
      await app.eval<boolean>(`(()=>{${helpers};
        const input = composer();
        const box = input.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && input.closest('section').contains(hit);
      })()`),
    ).toBe(true);
    await shot("page-dialog-under-chat");
    // Out of the chat's way, for a look at the sign-in itself.
    await app.eval(
      `document.querySelector('button[aria-label="Minimize chat to bubble"]').click(); true`,
    );
    await app.waitFor(`(()=>{${helpers};return !composer();})()`, {
      label: "chat minimized",
    });
    await shot("page-dialog-saved-sign-in");
    await app.eval(
      `${DIALOG}.querySelector('[data-testid="page-dialog-saved"] button').click(); true`,
    );
    await loaded("Signed in");
    await openChat();
    // Going elsewhere still works for the agent.
    expect(
      await tool("browser_act", {
        key,
        action: "navigate",
        url: `${origin}/plain?from=agent`,
      }),
    ).toMatchObject({ ok: true });
  });

  it("a chat's page closes back to its chip still loaded; removing it from the chat asks the page", async () => {
    const { key } = await tool("open_browser", { url: `${origin}/unload` });
    await tool("browser_act", { key, action: "wait_for", text: "Away" });
    // A real click in the page: it may hold on to it from now on.
    await tool("browser_act", { key, action: "click", x: 200, y: 200 });
    const tab = `document.querySelector('[data-point-key=${JSON.stringify(key)}]')`;
    await app.eval(`${tab}.querySelector('button').click(); true`);
    await loaded("Unload");
    // Closing the tab only takes it back to the chat's chip: the page is
    // neither asked nor unloaded.
    const mark = await markDialogs();
    await app.eval(
      `${tab}.querySelector('button[aria-label^="Close"]').click(); true`,
    );
    await app.waitFor(`!${tab}`, { label: "tab back to its chip" });
    expect(
      await tool("browser_act", {
        key,
        action: "evaluate",
        expression: "document.title",
      }),
    ).toMatchObject({ value: "Unload" });
    expect(
      (await dialogsSince(mark)).filter((kinds) => kinds.length > 0),
    ).toEqual([]);
    // Removing it from the chat disposes of the page, so the page is
    // asked, and its tab comes forward to ask.
    const removeButton = `document.querySelector('[data-chip-root=${JSON.stringify(key)}] [data-chip-button="remove"]')`;
    const remove = `${removeButton}.click(); true`;
    const anyDialog = `document.querySelector('[data-testid="page-dialog"]:not([inert])')`;
    await app.eval(remove);
    await app.waitFor(`${anyDialog}?.dataset.kind === 'beforeunload'`, {
      label: "Leave site? for the chip's page",
    });
    await app.eval(
      `${anyDialog}.querySelector('[data-testid="page-dialog-cancel"]').click(); true`,
    );
    await app.waitFor(`!${anyDialog}`, { label: "stayed" });
    expect(await app.eval<boolean>(`!!${removeButton}`)).toBe(true);
    await app.eval(remove);
    await app.waitFor(`${anyDialog}?.dataset.kind === 'beforeunload'`, {
      label: "Leave site? again",
    });
    await app.eval(
      `${anyDialog}.querySelector('[data-testid="page-dialog-accept"]').click(); true`,
    );
    await app.waitFor(`!${removeButton} && !${tab}`, {
      label: "the page went with its chip",
    });
  });
});
