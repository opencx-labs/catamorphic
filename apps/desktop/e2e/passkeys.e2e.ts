import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import * as kdbx from "kdbxweb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/main/kdbx-argon2.js";
import { cosePublicKey, toBase64Url } from "../src/main/webauthn.js";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Passkeys in a browser tab (shared/passkeys.ts, ADRs 0185 and 0201).
 * Work keeps passkeys in the profile's vault: a site's request shows the
 * passkey sheet, which saves a new passkey or signs in with a saved one,
 * and autofill offers them under a "webauthn" field. Every credential the
 * page receives is checked here by a relying party library, as a site's
 * server would. Requests nothing answers still keep their deadline,
 * cancel into Chrome's NotAllowedError and free the page for the next
 * attempt. Passkeys from Bitwarden and KeePassXC files import and sign in.
 * The test desktop has no security key and no Touch ID.
 */
let app: AppHandle;
let origin: string;
let directory: string;
let pickFile: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset=utf-8><title>Sign in</title>
  <style>body{font:16px system-ui;margin:40px}input{display:block;font:inherit;padding:8px;width:320px}</style>
  <label for=user>Username</label><input id=user name=username autocomplete="username webauthn">
  <script>
    const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    window.unb64 = (text) => Uint8Array.from(
      atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)),
      (char) => char.charCodeAt(0));
    const challenge = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      window.lastChallenge = b64(bytes);
      return bytes;
    };
    const publicKey = (extra = {}) => ({
      challenge: challenge(),
      rpId: location.hostname,
      userVerification: "preferred",
      ...extra,
    });
    const keep = (credential) => {
      window.lastCredential = credential && {
        json: credential.toJSON(),
        isCredential: credential instanceof PublicKeyCredential,
        rawIdMatches: b64(credential.rawId) === credential.id,
        extensions: credential.getClientExtensionResults(),
        algorithm: credential.response.getPublicKeyAlgorithm?.() ?? null,
      };
    };
    const settle = (label, promise) => {
      document.title = label + ":pending";
      promise.then(
        (credential) => { keep(credential); document.title = label + ":resolved"; },
        (error) => { document.title = label + ":" + error.name; },
      );
    };
    window.signIn = (extra) =>
      settle("get", navigator.credentials.get({ publicKey: publicKey(extra) }));
    window.secondSignIn = () =>
      navigator.credentials.get({ publicKey: publicKey() })
        .then(() => "resolved", (error) => error.name);
    window.register = (extra = {}) => {
      window.registration = new AbortController();
      settle("create", navigator.credentials.create({
        signal: window.registration.signal,
        publicKey: {
          challenge: challenge(),
          rp: { id: location.hostname, name: "Lab" },
          user: { id: new TextEncoder().encode("ada-id"), name: "ada", displayName: "Ada Lovelace" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
          extensions: { credProps: true },
          ...extra,
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
      }).then((credential) => { keep(credential); window.autofillResult = "resolved"; },
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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "passkeys-e2e-"));
  pickFile = path.join(directory, "pick");
  fs.writeFileSync(pickFile, "");
  app = await launchApp({
    urls: [`${origin}/signin`],
    env: { CATAMORPHIC_E2E_PICK_FILE: pickFile },
  });
});
afterAll(async () => {
  await app?.stop();
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
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
    { label },
  );
const sheetGone = (label: string) => app.waitFor(`!${sheet}`, { label });
const click = (selector: string) =>
  app.eval(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.click(); return true; })()`,
  );
const choices = () =>
  app.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="passkey-sheet-choice"]')].map((choice) => choice.textContent)`,
  );
const choose = (username: string) =>
  app.eval(
    `(() => { [...document.querySelectorAll('[data-testid="passkey-sheet-choice"]')].find((choice) => choice.textContent.startsWith(${JSON.stringify(username)})).click(); return true; })()`,
  );
const profileId = () =>
  app.eval<string>(
    "window.catamorphicDesktop.profilesList().then((data) => data.defaultProfileId)",
  );

interface PageCredential {
  json: RegistrationResponseJSON & AuthenticationResponseJSON;
  isCredential: boolean;
  rawIdMatches: boolean;
  extensions: Record<string, unknown>;
  algorithm: number | null;
}
const lastCredential = () => inGuest<PageCredential>("window.lastCredential");
const lastChallenge = () => inGuest<string>("window.lastChallenge");

/** A sign-in the site's server accepts, for the credential it holds. */
async function verifySignIn(credential: WebAuthnCredential) {
  const page = await lastCredential();
  expect(page.isCredential).toBe(true);
  expect(page.rawIdMatches).toBe(true);
  expect(page.json.id).toBe(credential.id);
  const result = await verifyAuthenticationResponse({
    response: page.json,
    expectedChallenge: await lastChallenge(),
    expectedOrigin: origin,
    expectedRPID: "localhost",
    credential,
    requireUserVerification: false,
  });
  expect(result.verified).toBe(true);
  return result.authenticationInfo;
}

let created: WebAuthnCredential;

describe("passkeys", () => {
  it("tells sites which passkey paths are really available", async () => {
    await pageReady();
    const found = await inGuest<{
      conditional: boolean;
      platform: boolean;
      client: Record<string, boolean>;
    }>("capabilities()");
    expect(found.conditional).toBe(true);
    expect(found.client.conditionalGet).toBe(true);
    expect(found.client.passkeyPlatformAuthenticator).toBe(true);
    expect(found.client.hybridTransport).toBe(false);
    expect(found.client.conditionalCreate).toBe(false);
    // Touch ID verifies users; the test desktop has none.
    expect(found.client.userVerifyingPlatformAuthenticator).toBe(
      found.platform,
    );
  });

  it("shows a sign-in Work cannot answer and cancels it into NotAllowedError", async () => {
    await inGuest("signIn(); true");
    await sheetShown("passkey sheet");
    const text = await app.eval<string>(`${sheet}.textContent`);
    expect(text).toContain(
      `${new URL(origin).host} wants you to sign in with a passkey`,
    );
    expect(text).toContain("Waiting for a security key");
    expect(text).toContain("No passkey for localhost is saved in Work.");
    expect(await choices()).toEqual([]);
    expect(await app.eval<string>(`${guest}.getTitle()`)).toBe("get:pending");
    await click('[data-testid="passkey-sheet-cancel"]');
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
  });

  it("saves a new passkey in Work, and the site accepts it", async () => {
    await inGuest("register(); true");
    await sheetShown("sheet offering to save");
    expect(
      await app.eval<string>(
        `document.querySelector('[data-testid="passkey-sheet-account"]').textContent`,
      ),
    ).toBe("ada");
    expect(await app.eval<string>(`${sheet}.textContent`)).toContain(
      "Ada Lovelace",
    );
    await click('[data-testid="passkey-sheet-save"]');
    await titleIs("create:resolved");
    await sheetGone("sheet closed once saved");
    const page = await lastCredential();
    expect(page.isCredential).toBe(true);
    expect(page.rawIdMatches).toBe(true);
    expect(page.algorithm).toBe(-7);
    expect(page.extensions).toEqual({ credProps: { rk: true } });
    const result = await verifyRegistrationResponse({
      response: page.json,
      expectedChallenge: await lastChallenge(),
      expectedOrigin: origin,
      expectedRPID: "localhost",
      requireUserVerification: false,
    });
    expect(result.verified).toBe(true);
    if (!result.registrationInfo) throw new Error("No registration info");
    expect(result.registrationInfo.fmt).toBe("none");
    created = result.registrationInfo.credential;
  });

  it("signs in with the saved passkey from the sheet", async () => {
    await inGuest("signIn(); true");
    await sheetShown("sheet listing the saved passkey");
    expect(await choices()).toEqual(["adaPasskey saved in Work"]);
    expect(await app.eval<string>(`${sheet}.textContent`)).toContain(
      "Or use a security key",
    );
    await choose("ada");
    await titleIs("get:resolved");
    await sheetGone("sheet closed after signing in");
    const page = await lastCredential();
    expect(page.json.response.userHandle).toBe(
      toBase64Url(Buffer.from("ada-id")),
    );
    const info = await verifySignIn(created);
    // Passkeys Work creates do not count, as synced passkeys do not.
    expect(info.newCounter).toBe(0);
  });

  it("offers only the passkeys a site asks for", async () => {
    await inGuest(
      `signIn({ allowCredentials: [{ type: "public-key", id: new Uint8Array([1, 2, 3]) }] }); true`,
    );
    await sheetShown("sheet for an unknown credential");
    expect(await choices()).toEqual([]);
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed");
    await inGuest(
      `signIn({ allowCredentials: [{ type: "public-key", id: unb64(${JSON.stringify(created.id)}) }] }); true`,
    );
    await sheetShown("sheet for the known credential");
    expect(await choices()).toEqual(["adaPasskey saved in Work"]);
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed");
  });

  it("tells a site the account already has a passkey here", async () => {
    await inGuest(
      `register({ excludeCredentials: [{ type: "public-key", id: unb64(${JSON.stringify(created.id)}) }] }); true`,
    );
    await sheetShown("sheet for an excluded account");
    expect(await app.eval<string>(`${sheet}.textContent`)).toContain(
      "A passkey for this account is already saved in Work.",
    );
    await click('[data-testid="passkey-sheet-cancel"]');
    await titleIs("create:InvalidStateError");
    await sheetGone("sheet closed");
  });

  it("does not claim Touch ID a Mac does not have", async () => {
    const verifies = await inGuest<boolean>(
      "PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()",
    );
    await inGuest(`signIn({ userVerification: "required" }); true`);
    await sheetShown("sheet for a request that requires verification");
    if (verifies) expect(await choices()).toHaveLength(1);
    else {
      expect(await choices()).toEqual([]);
      expect(await app.eval<string>(`${sheet}.textContent`)).toContain(
        "requires Touch ID to sign in with a passkey",
      );
    }
    await app.press("Escape");
    await titleIs("get:NotAllowedError");
    await sheetGone("sheet closed");
  });

  it("offers the passkey under a webauthn field and signs in with it", async () => {
    await inGuest("autofill(); true");
    await app.eval(`${guest}.focus(); true`);
    await inGuest(`document.querySelector('#user').focus()`);
    await app.waitFor(
      `${guest}.executeJavaScript("document.activeElement?.id === 'user' && document.hasFocus()")`,
      { label: "username field focused" },
    );
    // ArrowDown in the field opens the suggestions, as a click does.
    const listed = `document.querySelector('[data-testid="passkey-suggestion"]') !== null`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await app.press("ArrowDown");
      try {
        await app.waitFor(listed, {
          timeoutMs: 3_000,
          label: "passkey listed",
        });
        break;
      } catch {
        // The first key into a fresh page is sometimes dropped.
      }
    }
    expect(
      await app.eval<string>(
        `document.querySelector('[data-testid="passkey-suggestion"]').textContent`,
      ),
    ).toBe("adaPasskey");
    await click('[data-testid="passkey-suggestion"]');
    await app.waitFor(
      `${guest}.executeJavaScript('autofillResult', true).then((result) => result === 'resolved')`,
      { label: "autofill signed in" },
    );
    await verifySignIn(created);
    expect(await app.eval(`!!${sheet}`)).toBe(false);
  });

  it("imports a Bitwarden passkey that keeps counting where it left off", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "der" });
    const guid = "4c1d7a52-93f0-4c1f-b0a4-0b1e5e1f2a3b";
    const file = path.join(directory, "bitwarden.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        encrypted: false,
        items: [
          {
            type: 1,
            name: "Lab",
            login: {
              username: "grace",
              password: "fixture-password",
              uris: [{ uri: `${origin}/signin` }],
              fido2Credentials: [
                {
                  credentialId: guid,
                  keyType: "public-key",
                  keyAlgorithm: "ECDSA",
                  keyCurve: "P-256",
                  keyValue: toBase64Url(pkcs8),
                  rpId: "localhost",
                  userHandle: toBase64Url(Buffer.from("grace-id")),
                  userName: "grace",
                  counter: "5",
                  discoverable: "true",
                },
              ],
            },
          },
        ],
      }),
    );
    fs.writeFileSync(pickFile, file);
    const result = await app.eval(
      `window.catamorphicDesktop.passwordFileImport({ profileId: ${JSON.stringify(await profileId())} })`,
    );
    expect(result).toEqual({
      status: "imported",
      passwords: 1,
      passkeys: 1,
      existing: 0,
      skipped: 0,
    });

    await inGuest("signIn(); true");
    await sheetShown("sheet listing both passkeys");
    expect(await choices()).toEqual([
      "adaPasskey saved in Work",
      "gracePasskey saved in Work",
    ]);
    await choose("grace");
    await titleIs("get:resolved");
    const info = await verifySignIn({
      id: toBase64Url(Buffer.from(guid.replace(/-/g, ""), "hex")),
      publicKey: new Uint8Array(cosePublicKey(pair.publicKey)),
      counter: 5,
    });
    expect(info.newCounter).toBe(6);
  });

  it("imports a KeePassXC database from the Passwords page and deletes a passkey", async () => {
    const db = kdbx.Kdbx.create(
      new kdbx.Credentials(kdbx.ProtectedValue.fromString("db-fixture")),
      "KeePassXC",
    );
    const entry = db.createEntry(db.getDefaultGroup());
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    entry.fields.set("Title", "Lab (Passkey)");
    entry.fields.set("UserName", "keepass");
    entry.fields.set("KPEX_PASSKEY_USERNAME", "keepass");
    entry.fields.set(
      "KPEX_PASSKEY_CREDENTIAL_ID",
      kdbx.ProtectedValue.fromString(toBase64Url(Buffer.from("kpxc"))),
    );
    entry.fields.set(
      "KPEX_PASSKEY_PRIVATE_KEY_PEM",
      kdbx.ProtectedValue.fromString(
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
    );
    entry.fields.set("KPEX_PASSKEY_RELYING_PARTY", "localhost");
    entry.fields.set(
      "KPEX_PASSKEY_USER_HANDLE",
      kdbx.ProtectedValue.fromString(toBase64Url(Buffer.from("kpxc-user"))),
    );
    const file = path.join(directory, "Passwords.kdbx");
    fs.writeFileSync(file, Buffer.from(await db.save()));
    fs.writeFileSync(pickFile, file);

    // The sheet's way to Passwords, for a site Work has no passkey for.
    await inGuest(
      `signIn({ allowCredentials: [{ type: "public-key", id: new Uint8Array([9]) }] }); true`,
    );
    await sheetShown("sheet without a passkey for the request");
    await click('[data-testid="passkey-sheet-import"]');
    // The request ends as a cancel; Passwords opens in front of the page.
    await sheetGone("sheet closed for Passwords");
    await app.waitFor(
      `document.querySelectorAll('[data-testid="passkey-row"]').length === 2`,
      { label: "Passwords page lists both passkeys" },
    );
    expect(
      await app.eval<string>(
        `document.querySelector('[data-testid="passwords-count"]').textContent`,
      ),
    ).toBe("1 password, 2 passkeys");

    await click('[data-testid="passwords-import"]');
    await app.waitFor(
      `!!document.querySelector('[data-testid="password-file-unlock"]')`,
      { label: "unlock dialog" },
    );
    expect(
      await app.eval<string>(
        `document.querySelector('[data-testid="password-file-unlock"]').textContent`,
      ),
    ).toContain("Unlock Passwords.kdbx");
    await app.waitFor(
      `document.activeElement?.dataset.testid === 'password-file-password'`,
      { label: "password field focused" },
    );
    await app.insertText("not it");
    await click('[data-testid="password-file-unlock-submit"]');
    await app.waitFor(
      `document.querySelector('[data-testid="password-file-unlock"]')?.textContent.includes('That password does not open this database.')`,
      { label: "wrong password explained" },
    );
    await app.eval(
      `(() => { const field = document.querySelector('[data-testid="password-file-password"]'); field.focus(); field.select(); return true; })()`,
    );
    await app.insertText("db-fixture");
    await click('[data-testid="password-file-unlock-submit"]');
    await app.waitFor(
      `document.querySelector('[data-testid="passwords-import-status"]')?.textContent === 'Imported 1 passkey.'`,
      { label: "import summary" },
    );
    await app.waitFor(
      `document.querySelectorAll('[data-testid="passkey-row"]').length === 3`,
      { label: "imported passkey listed" },
    );

    await click('[aria-label="Delete passkey for localhost"]');
    await app.waitFor(
      `document.body.textContent.includes('Delete the passkey for localhost?')`,
      { label: "delete confirmation" },
    );
    await click('[data-testid="password-delete-confirm"]');
    await app.waitFor(
      `document.querySelectorAll('[data-testid="passkey-row"]').length === 2`,
      { label: "passkey deleted" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
