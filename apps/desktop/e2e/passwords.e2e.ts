import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * The browser's password manager, Chrome-style: a sign-in that lands
 * offers to save (a failed one does not), clicking a login field lists
 * saved accounts under it, a new-password field suggests a strong
 * password that saves itself when the form goes out, and the saved card's
 * Update edits the username and note. Input into the page is real
 * keyboard input (the guest ignores untrusted events); synthetic pointer
 * clicks into a guest are unreliable on the native macOS runner, so the
 * page is driven by keys and only the app's own overlays are clicked.
 */
let app: AppHandle;
let origin: string;
const users = new Map([["alice@example.com", "correct horse"]]);
const page = (title: string, body: string) =>
  `<!doctype html><meta charset=utf-8><title>${title}</title><style>body{font:16px system-ui;margin:40px}input,button{display:block;font:inherit;margin:8px 0 16px;padding:8px;width:320px}</style>${body}`;
const loginForm = (error = "") =>
  `${error}<form method=post action=/login><label for=email>Email</label><input id=email name=email type=email autocomplete=username><label for=pw>Password</label><input id=pw name=password type=password autocomplete=current-password><button id=submit>Sign in</button></form>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Content-Type", "text/html");
  if (request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const form = new URLSearchParams(body);
      const email = form.get("email") ?? "";
      const password = form.get("password") ?? "";
      if (url.pathname === "/signup") users.set(email, password);
      else if (users.get(email) !== password) {
        response.end(page("Sign in", loginForm("<p id=error>Wrong</p>")));
        return;
      }
      response.writeHead(302, { Location: "/welcome" });
      response.end();
    });
    return;
  }
  if (url.pathname === "/signup") {
    response.end(
      page(
        "Create account",
        `<form method=post action=/signup><label for=email>Email</label><input id=email name=email type=email autocomplete=email><label for=pw>Password</label><input id=pw name=password type=password autocomplete=new-password><label for=pw2>Confirm</label><input id=pw2 name=confirm type=password autocomplete=new-password><button id=submit>Create account</button></form>`,
      ),
    );
    return;
  }
  if (url.pathname === "/welcome") {
    response.end(page("Welcome", "<p>Signed in</p>"));
    return;
  }
  response.end(page("Sign in", loginForm()));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp({ urls: [`${origin}/login`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview')`;
const inGuest = <T = unknown>(code: string) =>
  app.eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const pageReady = (title: string) =>
  app.waitFor(
    `${guest}?.getTitle?.() === ${JSON.stringify(title)} && !${guest}.isLoading()`,
    { label: `${title} loaded` },
  );
const navigate = async (path: string, title: string) => {
  await inGuest(`location.href = ${JSON.stringify(origin + path)}`);
  await pageReady(title);
};

async function clickAt(point: { x: number; y: number }) {
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}
/** A real click on an element of the app. */
async function clickInApp(selector: string) {
  await app.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
    label: selector,
  });
  const point = await app.eval<{ x: number; y: number }>(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await clickAt(point);
}
/** Give a page field keyboard focus (a new-password field offers here). */
async function focusInPage(selector: string) {
  await app.eval(`${guest}.focus(); true`);
  await inGuest(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await app.waitFor(
    `${guest}.executeJavaScript(${JSON.stringify(`document.activeElement === document.querySelector(${JSON.stringify(selector)}) && document.hasFocus()`)})`,
    { label: `${selector} focused` },
  );
}
async function typeInPage(selector: string, text: string) {
  await focusInPage(selector);
  await app.insertText(text);
}
const profileId = () =>
  app.eval<string>(
    `window.catamorphicDesktop.profilesList().then((data) => data.defaultProfileId)`,
  );
const saved = async () =>
  app.eval<Array<{ id: string; username: string; hasNote: boolean }>>(
    `window.catamorphicDesktop.vaultList({ profileId: ${JSON.stringify(await profileId())} })`,
  );
const prompt = `document.querySelector('[data-testid="password-prompt"]')`;

describe("browser passwords", () => {
  it("offers to save a sign-in that lands, and saves it", async () => {
    await pageReady("Sign in");
    await typeInPage("#email", "alice@example.com");
    await typeInPage("#pw", "correct horse");
    await app.press("Enter");
    await pageReady("Welcome");
    await app.waitFor(`${prompt}?.dataset.kind === 'save'`, {
      label: "save offer",
    });
    expect(
      await app.eval(
        `document.querySelector('[data-testid="password-prompt-username"]').textContent`,
      ),
    ).toBe("alice@example.com");
    await clickInApp('[data-testid="password-prompt-save"]');
    await app.waitFor(`!${prompt}`, { label: "card closed" });
    expect((await saved()).map(({ username }) => username)).toEqual([
      "alice@example.com",
    ]);
  });

  it("does not offer a password the site rejected", async () => {
    await navigate("/login", "Sign in");
    await typeInPage("#email", "alice@example.com");
    await typeInPage("#pw", "wrong password");
    await app.press("Enter");
    await app.waitFor(
      `${guest}.executeJavaScript("!!document.querySelector('#error')")`,
      { label: "error page" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await app.eval(`!!${prompt}`)).toBe(false);
  });

  it("lists saved accounts under a login field and fills one", async () => {
    await navigate("/login", "Sign in");
    // ArrowDown in the field opens the list, as a click does.
    await focusInPage("#email");
    await app.press("ArrowDown");
    await app.waitFor(
      `document.querySelector('[data-testid="password-suggestions"]')?.dataset.open === 'true'`,
      { label: "suggestions open" },
    );
    expect(
      await app.eval(
        `document.querySelector('[data-testid="password-suggestion"]').textContent`,
      ),
    ).toContain("alice@example.com");
    await clickInApp('[data-testid="password-suggestion"]');
    await app.waitFor(
      `${guest}.executeJavaScript("document.querySelector('#pw').value === 'correct horse' && document.querySelector('#email').value === 'alice@example.com'")`,
      { label: "filled" },
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="password-suggestions"]')`,
      { label: "suggestions closed" },
    );
  });

  it("suggests a strong password for a new account and saves it on submit", async () => {
    await navigate("/signup", "Create account");
    await typeInPage("#email", "carol@example.com");
    await focusInPage("#pw");
    await app.waitFor(
      `!!document.querySelector('[data-testid="password-suggestion-generated"]')`,
      { label: "generated suggestion" },
    );
    const suggestion = await app.eval<string>(
      `document.querySelector('[data-testid="suggested-password"]').textContent`,
    );
    expect(suggestion).toMatch(/^[A-Za-z2-9\-_.:!]{15}$/);
    await clickInApp('[data-testid="password-suggestion-generated"]');
    await app.waitFor(
      `${guest}.executeJavaScript(${JSON.stringify(
        `document.querySelector('#pw').value === ${JSON.stringify(suggestion)} && document.querySelector('#pw2').value === ${JSON.stringify(suggestion)}`,
      )})`,
      { label: "both fields filled" },
    );
    // Filling leaves focus in the password field; Enter sends the form.
    await app.press("Enter");
    await app.waitFor(`${prompt}?.dataset.kind === 'saved'`, {
      label: "saved card",
    });
    expect(await app.eval(`${prompt}.textContent`)).toContain(
      "carol@example.com",
    );
    expect(users.get("carol@example.com")).toBe(suggestion);
    expect((await saved()).map(({ username }) => username)).toContain(
      "carol@example.com",
    );
  });

  it("updates the saved login's username and note from the card", async () => {
    await clickInApp('[data-testid="password-prompt-update"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="password-editor"]')`,
      { label: "editor" },
    );
    await app.eval(`(() => {
      const set = (selector, value) => {
        const element = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('[data-testid="password-username"]', 'carol');
      set('[data-testid="password-note"]', 'Recovery code 1234');
      return true;
    })()`);
    await clickInApp('[data-testid="password-editor"] button[type="submit"]');
    await app.waitFor(
      `window.catamorphicDesktop.vaultList({ profileId: ${JSON.stringify(await profileId())} }).then((list) => list.some((item) => item.username === 'carol' && item.hasNote))`,
      { label: "note saved" },
    );
    const carol = (await saved()).find(({ username }) => username === "carol");
    expect(
      await app.eval(
        `window.catamorphicDesktop.vaultReveal({ profileId: ${JSON.stringify(await profileId())}, id: ${JSON.stringify(carol?.id)} }).then((secret) => [secret.note, secret.password])`,
      ),
    ).toEqual(["Recovery code 1234", users.get("carol@example.com")]);
  });
});
