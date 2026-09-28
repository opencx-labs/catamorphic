import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Passkeys in a browser tab (shared/passkeys.ts). Electron gives Web
 * Authentication no UI and no timer, so a request nothing answers used to
 * spin forever and fail every retry as already pending. Now each request
 * shows the passkey sheet, keeps its deadline, cancels into Chrome's
 * NotAllowedError, and frees the page for the next attempt. The test
 * desktop has no security key, which is exactly the reported situation.
 */
let app: AppHandle;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Sign in</title><script>
    const publicKey = (extra = {}) => ({
      challenge: new Uint8Array(32),
      rpId: location.hostname,
      userVerification: "preferred",
      ...extra,
    });
    const settle = (label, promise) => {
      document.title = label + ":pending";
      promise.then(
        () => { document.title = label + ":resolved"; },
        (error) => { document.title = label + ":" + error.name; },
      );
    };
    window.signIn = (extra) =>
      settle("get", navigator.credentials.get({ publicKey: publicKey(extra) }));
    window.secondSignIn = () =>
      navigator.credentials.get({ publicKey: publicKey() })
        .then(() => "resolved", (error) => error.name);
    window.register = () => {
      window.registration = new AbortController();
      settle("create", navigator.credentials.create({
        signal: window.registration.signal,
        publicKey: {
          challenge: new Uint8Array(32),
          rp: { id: location.hostname, name: "Lab" },
          user: { id: new Uint8Array(8), name: "ada", displayName: "Ada" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required" },
        },
      }));
    };
    window.autofill = () => {
      window.autofillAbort = new AbortController();
      window.autofillResult = "pending";
      navigator.credentials.get({
        mediation: "conditional",
        signal: window.autofillAbort.signal,
        publicKey: publicKey(),
      }).then(() => { window.autofillResult = "resolved"; },
        (error) => { window.autofillResult = error.name; });
    };
    window.capabilities = async () => ({
      conditional: await PublicKeyCredential.isConditionalMediationAvailable(),
      platform: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      client: await PublicKeyCredential.getClientCapabilities(),
    });
  </script>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  // localhost is a secure context and a valid relying party id.
  origin = `http://localhost:${address.port}`;
  app = await launchApp({ urls: [`${origin}/signin`] });
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

const guest = `document.querySelector('webview')`;
const sheet = `document.querySelector('[data-testid="passkey-sheet"]')`;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${guest}.executeJavaScript(${JSON.stringify(code)}, true)`);
const titleIs = (title: string, timeoutMs?: number) =>
  app.waitFor(`${guest}.getTitle() === ${JSON.stringify(title)}`, {
    label: `page title ${title}`,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const pageReady = () =>
  app.waitFor(
    `(() => { const view = ${guest}; try { return view.getTitle() === 'Sign in' && !view.isLoading(); } catch { return false; } })()`,
    { label: "sign-in page ready" },
  );
// The modal takes focus in the same effect that starts listening for
// keys, so a focused sheet is one that Escape reaches.
const sheetShown = (label: string) =>
  app.waitFor(
    `!!${sheet}?.closest('[role="dialog"]')?.contains(document.activeElement)`,
    {
      label,
    },
  );
const sheetGone = (label: string) => app.waitFor(`!${sheet}`, { label });

describe("passkeys", () => {
  it("tells sites which passkey paths are really available", async () => {
    await pageReady();
    const found = await inGuest<{
      conditional: boolean;
      platform: boolean;
      client: Record<string, boolean>;
    }>("capabilities()");
    expect(found.conditional).toBe(false);
    expect(found.platform).toBe(false);
    expect(found.client.hybridTransport).toBe(false);
    expect(found.client.passkeyPlatformAuthenticator).toBe(false);
    expect(found.client.conditionalGet).toBe(false);
  });

  it("shows a sign-in request and cancels it into NotAllowedError", async () => {
    await inGuest("signIn(); true");
    await sheetShown("passkey sheet");
    const text = await app.eval<string>(`${sheet}.textContent`);
    expect(text).toContain(
      `${new URL(origin).host} wants you to sign in with a passkey`,
    );
    expect(text).toContain("Waiting for a security key");
    expect(text).toContain("can't be used in Work yet");
    expect(await app.eval<string>(`${guest}.getTitle()`)).toBe("get:pending");
    await app.eval(
      `document.querySelector('[data-testid="passkey-sheet-cancel"]').click(); true`,
    );
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed after cancel");
  });

  it("frees the page for the next attempt, and Escape cancels too", async () => {
    // Before, the stuck request made this one fail as already pending.
    await inGuest("signIn(); true");
    await sheetShown("sheet for the retry");
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed after Escape");
  });

  it("keeps one sheet for the request that is really waiting", async () => {
    await inGuest("signIn(); true");
    await sheetShown("sheet for the first request");
    // Chromium refuses a second request while one waits.
    expect(await inGuest("secondSignIn()")).toBe("OperationError");
    expect(
      await app.eval(
        `document.querySelectorAll('[data-testid="passkey-sheet"]').length`,
      ),
    ).toBe(1);
    expect(await app.eval<string>(`${guest}.getTitle()`)).toBe("get:pending");
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed");
  });

  it("closes by itself when the page gives up", async () => {
    await inGuest("register(); true");
    await sheetShown("sheet for creating a passkey");
    expect(await app.eval<string>(`${sheet}.textContent`)).toContain(
      "wants to create a passkey",
    );
    await inGuest("registration.abort(); true");
    await titleIs("create:AbortError");
    await sheetGone("sheet closed after the page aborted");
  });

  it("keeps the site's deadline instead of waiting forever", async () => {
    // Chrome holds a timeout to at least ten seconds.
    const started = Date.now();
    await inGuest("signIn({ timeout: 1000 }); true");
    await sheetShown("sheet for the timed request");
    await titleIs("get:NotAllowedError", 20_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    await sheetGone("sheet closed at the deadline");
  });

  it("leaves autofill requests quiet and out of the way", async () => {
    await inGuest("autofill(); true");
    // Autofill never shows the sheet.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await app.eval(`!!${sheet}`)).toBe(false);
    // The page's own passkey button still works alongside it.
    await inGuest("signIn(); true");
    await sheetShown("sheet beside a pending autofill");
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed");
    expect(await inGuest("autofillResult")).toBe("pending");
    await inGuest("autofillAbort.abort(); true");
    await app.waitFor(
      `${guest}.executeJavaScript('autofillResult', true).then((result) => result === 'AbortError')`,
      { label: "autofill aborted by the page" },
    );
  });

  it("withdraws the sheet when the page moves on", async () => {
    await inGuest("signIn(); true");
    await sheetShown("sheet before navigating");
    await inGuest("location.href = '/signin?moved'; true");
    await sheetGone("sheet withdrawn on navigation");
    await pageReady();
    expect(app.getRendererErrors()).toEqual([]);
  });
});
