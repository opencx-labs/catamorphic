import http from "node:http";
import path from "node:path";
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
  if (url.pathname === "/framed") {
    const mode = url.searchParams.get("mode") ?? "inline";
    const authOrigin = origin.replace("127.0.0.1", "localhost");
    response.end(
      page(
        "Framed sign in",
        `
      <iframe id=auth ${mode === "sandbox" ? 'sandbox="allow-scripts allow-forms"' : ""}
        style="width:500px;height:400px" src="${authOrigin}/auth-frame?mode=${mode}"></iframe>
      <iframe id=sibling src="/empty-frame"></iframe>
      <script>
        addEventListener('message', ({data, source}) => {
          if (source !== document.querySelector('#auth')?.contentWindow) return;
          if (data.focused) document.body.dataset.focused = data.focused;
          if (data.typed) document.body.dataset.typed = data.typed;
          if (data.phase) document.body.dataset.phase = data.phase;
          if (data.done) {
            document.title = 'Frame finished';
            if (${JSON.stringify(mode)} === 'remove') document.querySelector('#auth').remove();
          }
        });
      </script>`,
      ),
    );
    return;
  }
  if (url.pathname === "/empty-frame") {
    response.end(page("Empty frame", "<p>No login here</p>"));
    return;
  }
  if (url.pathname === "/auth-frame") {
    const mode = url.searchParams.get("mode") ?? "inline";
    const rejected = url.searchParams.has("rejected");
    response.end(
      page(
        "Authentication",
        `
      <form><label for=email>Email</label><input id=email type=email autocomplete=username>
        <button>Continue</button></form>
      <script>
        const form = document.querySelector('form');
        let expectedInput;
        form.addEventListener('input', (event) => {
          if (event.isTrusted && event.target === expectedInput?.element && event.target.value === expectedInput.text)
            parent.postMessage({typed:event.target.id}, '*');
        });
        const passwordStep = () => {
          form.innerHTML = '<label for=pw>Password</label><input id=pw type=password autocomplete=current-password><button>Sign in</button>';
          parent.postMessage({phase:'password'}, '*');
        };
        addEventListener('message', ({data}) => {
          if (data.focus) {
            const element = document.querySelector('#' + data.focus);
            element.value = '';
            expectedInput = {element, text:data.text};
            element.focus();
            const ready = () => {
              if (document.activeElement === element && document.hasFocus()) parent.postMessage({focused:data.focus}, '*');
              else requestAnimationFrame(ready);
            };
            ready();
          }
        });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!document.querySelector('#pw')) { passwordStep(); return; }
          if (document.querySelector('#pw').value !== 'correct horse') {
            location.href = '/auth-frame?rejected=1';
            return;
          }
          if (${JSON.stringify(mode)} === 'pending') {
            parent.postMessage({phase:'pending'}, '*');
            return;
          }
          if (${JSON.stringify(mode)} === 'top') {
            top.location.href = ${JSON.stringify(`${origin}/welcome`)};
            return;
          }
          if (${JSON.stringify(mode)} !== 'remove') form.remove();
          parent.postMessage({done:true}, '*');
        });
        if (${rejected}) {
          passwordStep();
          parent.postMessage({phase:'rejected'}, '*');
        } else parent.postMessage({phase:'email'}, '*');
      </script>`,
      ),
    );
    return;
  }
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
    `(() => { try { return ${guest}?.getTitle?.() === ${JSON.stringify(title)} && !${guest}.isLoading(); } catch { return false; } })()`,
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
/**
 * Press a key in the page until its effect shows. The native macOS runner
 * sometimes drops the first key into a freshly launched page; a repeat
 * of Enter or ArrowDown is harmless once the first one has landed.
 */
async function pressUntil(
  key: "Enter" | "ArrowDown",
  effect: string,
  label: string,
) {
  // A guest between documents throws instead of answering; that is "not yet".
  const settled = `Promise.resolve().then(() => ${effect}).catch(() => false)`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && (await app.eval(settled))) return;
    await app.press(key);
    try {
      await app.waitFor(settled, { timeoutMs: 3_000, label });
      return;
    } catch {
      // Not yet: press again.
    }
  }
  await app.waitFor(settled, { label });
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
  app.eval<
    Array<{ id: string; origin: string; username: string; hasNote: boolean }>
  >(
    `window.catamorphicDesktop.vaultList({ profileId: ${JSON.stringify(await profileId())} })`,
  );
const prompt = `document.querySelector('[data-testid="password-prompt"]')`;

/** Cross-origin fields focus themselves; typing and Enter still use real input. */
async function typeInFrame(field: string, text: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.eval(`${guest}.focus(); true`);
    await inGuest(`(() => {
      document.body.dataset.focused = '';
      document.body.dataset.typed = '';
      const frame = document.querySelector('#auth');
      frame.focus();
      frame.contentWindow.postMessage({focus:${JSON.stringify(field)},text:${JSON.stringify(text)}}, '*');
    })()`);
    await app.waitFor(
      `${guest}.executeJavaScript(${JSON.stringify(`document.body.dataset.focused === ${JSON.stringify(field)}`)})`,
      { label: `${field} focused in authentication frame` },
    );
    await app.insertText(text);
    try {
      await app.waitFor(
        `${guest}.executeJavaScript(${JSON.stringify(`document.body.dataset.typed === ${JSON.stringify(field)}`)})`,
        { timeoutMs: 3_000, label: `${field} received trusted input` },
      );
      return;
    } catch (error) {
      // Native macOS can drop the first input after switching frames.
      // The fixture clears the field before retrying, so text never doubles.
      if (attempt === 2) throw error;
    }
  }
}

const framePhase = (phase: string) =>
  app.waitFor(
    `${guest}.executeJavaScript(${JSON.stringify(`document.body.dataset.phase === ${JSON.stringify(phase)}`)})`,
    { label: `${phase} step in authentication frame` },
  );

async function framedLogin(mode: string, username: string, password: string) {
  await navigate(`/framed?mode=${mode}`, "Framed sign in");
  await framePhase("email");
  await typeInFrame("email", username);
  await pressUntil(
    "Enter",
    `${guest}.executeJavaScript("document.body.dataset.phase === 'password'")`,
    "password step in authentication frame",
  );
  await typeInFrame("pw", password);
  await app.press("Enter");
}

describe("browser passwords", () => {
  it("offers to save a sign-in that lands, and saves it", async () => {
    await pageReady("Sign in");
    await typeInPage("#email", "alice@example.com");
    await typeInPage("#pw", "correct horse");
    await pressUntil(
      "Enter",
      `${guest}?.getTitle?.() === 'Welcome'`,
      "signed in",
    );
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
    await pressUntil(
      "Enter",
      `${guest}.executeJavaScript("!!document.querySelector('#error')")`,
      "error page",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await app.eval(`!!${prompt}`)).toBe(false);
  });

  it("lists saved accounts under a login field and fills one", async () => {
    await navigate("/login", "Sign in");
    // ArrowDown in the field opens the list, as a click does.
    await focusInPage("#email");
    await pressUntil(
      "ArrowDown",
      `document.querySelector('[data-testid="password-suggestions"]')?.dataset.open === 'true'`,
      "suggestions open",
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

  it("fills even when the page reports its blur before the press lands", async () => {
    // Pressing the list takes focus from the page. On macOS the page's
    // blur report can reach the window before the press does; the list
    // must still take the click (it used to close first, flakily).
    await navigate("/login", "Sign in");
    await focusInPage("#email");
    await pressUntil(
      "ArrowDown",
      `document.querySelector('[data-testid="password-suggestions"]')?.dataset.open === 'true'`,
      "suggestions open",
    );
    await inGuest("document.activeElement.blur(); true");
    await clickInApp('[data-testid="password-suggestion"]');
    await app.waitFor(
      `${guest}.executeJavaScript("document.querySelector('#pw').value === 'correct horse' && document.querySelector('#email').value === 'alice@example.com'")`,
      { label: "filled after an early blur" },
    );
    await app.waitFor(
      `!document.querySelector('[data-testid="password-suggestions"]')`,
      { label: "suggestions closed" },
    );
  });

  it("closes the list when the page's field loses focus for good", async () => {
    await navigate("/login", "Sign in");
    await focusInPage("#email");
    await pressUntil(
      "ArrowDown",
      `document.querySelector('[data-testid="password-suggestions"]')?.dataset.open === 'true'`,
      "suggestions open",
    );
    await inGuest("document.activeElement.blur(); true");
    await app.waitFor(
      `!document.querySelector('[data-testid="password-suggestions"]')`,
      { label: "suggestions closed after the blur" },
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
    // Filled values can arrive before the overlay's native focus handoff.
    // Observe that handoff without focusing the field on the test's behalf.
    try {
      await app.waitFor(
        `!document.querySelector('[data-testid="password-suggestions"]') &&
          ${guest}.executeJavaScript("document.hasFocus() && document.activeElement === document.querySelector('#pw')")`,
        { label: "generated password returns keyboard focus to the page" },
      );
    } catch (error) {
      const focus = await app.eval(`(async () => ({
        hostFocused:document.hasFocus(),
        hostActive:document.activeElement?.tagName,
        suggestions:document.querySelector('[data-testid="password-suggestions"]')?.dataset.open,
        guest:await ${guest}.executeJavaScript("({focused:document.hasFocus(),active:document.activeElement?.id})"),
      }))()`);
      throw new Error(`Generated password focus: ${JSON.stringify(focus)}`, {
        cause: error,
      });
    }
    // Once the page owns its keys, Enter sends the form.
    await pressUntil(
      "Enter",
      `${prompt}?.dataset.kind === 'saved'`,
      "saved card",
    );
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

  it.each(["inline", "top", "remove"])(
    "saves an email-first iframe login when it lands via %s",
    async (mode) => {
      await app.waitFor(`!${prompt}`, {
        label: "previous password card closed",
      });
      const username = `${mode}@framed.example`;
      await framedLogin(mode, username, "correct horse");
      await pageReady(mode === "top" ? "Welcome" : "Frame finished");
      await app.waitFor(`${prompt}?.dataset.kind === 'save'`, {
        label: "framed sign-in offers to save",
      });
      expect(await app.eval(`${prompt}.textContent`)).toContain(username);
      if (mode === "inline" && process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR) {
        await app.waitFor(
          `${prompt}.getAnimations().every((animation) => animation.playState === 'finished')`,
          { label: "save card settled" },
        );
        await app.screenshot(
          path.join(
            process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
            "framed-password-offer.png",
          ),
        );
      }
      await clickInApp('[data-testid="password-prompt-save"]');
      await app.waitFor(`!${prompt}`, { label: "framed login saved" });
      const login = (await saved()).find((item) => item.username === username);
      expect(login?.origin).toBe(origin.replace("127.0.0.1", "localhost"));
      expect(
        await app.eval(
          `window.catamorphicDesktop.vaultReveal({ profileId: ${JSON.stringify(await profileId())}, id: ${JSON.stringify(login?.id)} }).then((secret) => secret.password)`,
        ),
      ).toBe("correct horse");
    },
  );

  it("does not offer a rejected iframe password or an opaque frame's login", async () => {
    await app.eval(`window.__frameOffers = [];
      window.catamorphicDesktop.onBrowserCredentialSaveOffer((offer) => window.__frameOffers.push(offer)); true`);
    await framedLogin("inline", "rejected@framed.example", "wrong");
    await framePhase("rejected");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await app.eval("window.__frameOffers.length")).toBe(0);

    await framedLogin("sandbox", "opaque@framed.example", "correct horse");
    await pageReady("Frame finished");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await app.eval("window.__frameOffers.length")).toBe(0);
    expect(await app.eval(`!!${prompt}`)).toBe(false);
  });

  it("does not treat a sibling iframe's empty landing as login success", async () => {
    await framedLogin("pending", "pending@framed.example", "correct horse");
    await framePhase("pending");
    await inGuest(
      `document.querySelector('#sibling').src = '/empty-frame?after-submit'`,
    );
    await pageReady("Framed sign in");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await app.eval("window.__frameOffers.length")).toBe(0);
    expect(await app.eval(`!!${prompt}`)).toBe(false);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
