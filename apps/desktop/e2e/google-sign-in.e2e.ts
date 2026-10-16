import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Google's own sign-in, live. Google turns away a browser it takes for an
 * embedded or disguised one at the first step, before it looks the account
 * up: "Couldn't sign you in. This browser or app may not be secure"
 * (ADR 0235). A made-up address gets past that gate in Chrome, which then
 * says "Couldn't find this account"; Work must get the same answer. Only
 * the first step is checked, never a password.
 *
 * Real Chrome on the same host, where there is one, takes the step too: if
 * Google refuses Chrome as well, the network is refused and Work is not
 * judged. It runs every time, so a broken control shows the day it breaks.
 * Every run writes its verdicts to google-sign-in.json among the test
 * artifacts. Google changes its gate without notice, so this runs daily
 * (.github/workflows/google-sign-in.yml), and only with the explicit
 * external-test authority (CATAMORPHIC_EXTERNAL_INTEGRATIONS=1).
 * browser-identity.e2e.ts checks offline what this depends on.
 */
const external = process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";
const describeIf = external ? describe : describe.skip;

// English, whatever the host's language: the verdicts read Google's words.
const SIGN_IN =
  "https://accounts.google.com/v3/signin/identifier?hl=en&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin";
const FIELD = "input#identifierId, input[type=email], input[name=identifier]";
const ARTIFACTS = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir();

type Verdict = "rejected" | "admitted" | "unclear";
interface Outcome {
  verdict: Verdict;
  url: string;
  text: string;
  error?: string;
}

function verdictOf({ url, text }: { url: string; text: string }): Verdict {
  if (/\/signin\/rejected/.test(url) || /may not be secure/i.test(text))
    return "rejected";
  // Past the gate: the account lookup, or the CAPTCHA Google asks of a
  // network that tried too often. Measured on 2026-10-16, a refused
  // browser was refused outright even while Google asked others for one.
  if (
    /Couldn.t find (this|your Google) account|Type the text you hear or see/i.test(
      text,
    )
  )
    return "admitted";
  return "unclear";
}

/** Letters, digits and dots only: Gmail refuses anything else before asking. */
const madeUpAddress = () =>
  `work.signin.check.${randomUUID().replaceAll("-", "").slice(0, 12)}@gmail.com`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read until `done` holds; at the deadline, the last answer, or a throw. */
async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > deadline) {
      if (value === undefined) throw new Error("No answer before the deadline");
      return value;
    }
    await sleep(500);
  }
}

/** Google Chrome on this host, if there is one, for the control run. */
function chromeBinary(): string | undefined {
  return [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((candidate) => candidate && existsSync(candidate));
}

async function stopChrome(chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return;
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill("SIGTERM");
  const force = setTimeout(() => chrome.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(force);
}

/**
 * The same step in real Chrome, on a fresh profile and in a window (a
 * headless Chrome names itself so and is turned away), driven over CDP.
 */
async function signInWithChrome(binary: string): Promise<Outcome> {
  const profile = mkdtempSync(path.join(os.tmpdir(), "work-google-control-"));
  const chrome: ChildProcess = spawn(
    binary,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    const port = await poll(
      async () =>
        readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(
          "\n",
        )[0],
      (value) => Boolean(value),
      30_000,
    );
    const pageSocket = await poll(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        const list: unknown = await response.json();
        const page = Array.isArray(list)
          ? list.find(
              (target) =>
                target &&
                typeof target === "object" &&
                target.type === "page" &&
                typeof target.webSocketDebuggerUrl === "string",
            )
          : undefined;
        return page ? String(page.webSocketDebuggerUrl) : "";
      },
      (url) => url !== "",
      30_000,
    );
    if (!pageSocket) throw new Error("Chrome opened no page");
    const socket = new WebSocket(pageSocket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    let next = 0;
    const waiting = new Map<number, (result: unknown) => void>();
    socket.addEventListener("message", (event) => {
      const message: { id?: number; result?: unknown } = JSON.parse(
        String(event.data),
      );
      if (message.id !== undefined) waiting.get(message.id)?.(message.result);
    });
    const send = (method: string, params: object = {}) =>
      new Promise<unknown>((resolve) => {
        next += 1;
        waiting.set(next, resolve);
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    const evaluate = async (expression: string): Promise<unknown> => {
      const answer = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      const value =
        answer && typeof answer === "object" && "result" in answer
          ? answer.result
          : undefined;
      return value && typeof value === "object" && "value" in value
        ? value.value
        : undefined;
    };
    const page = async () => {
      const read = await evaluate(
        "({ url: location.href, text: document.body ? document.body.innerText : '' })",
      );
      if (!read || typeof read !== "object") throw new Error("No page");
      const url = "url" in read ? String(read.url) : "";
      const text = "text" in read ? String(read.text) : "";
      return { url, text, verdict: verdictOf({ url, text }) };
    };
    await send("Page.navigate", { url: SIGN_IN });
    const ready = await poll(
      async () => ({
        field:
          (await evaluate(
            `!!document.querySelector(${JSON.stringify(FIELD)})`,
          )) === true,
        ...(await page()),
      }),
      (state) => state.field || state.verdict === "rejected",
      30_000,
    );
    if (ready.verdict === "rejected") return ready;
    if (!ready.field)
      throw new Error(`Chrome never showed the address field: ${ready.url}`);
    await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).focus()`);
    await send("Input.insertText", { text: madeUpAddress() });
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
    const outcome = await poll(
      page,
      (state) => state.verdict !== "unclear",
      30_000,
    );
    socket.close();
    return outcome;
  } finally {
    await stopChrome(chrome);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A leftover temporary profile must not hide the verdict.
    }
  }
}

let app: AppHandle;
const view = `document.querySelector('webview')`;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);

async function signInWithWork(): Promise<Outcome> {
  const page = async () => {
    const url = await app.eval<string>(`${view}.getURL()`);
    const text = await inGuest<string>(
      "document.body ? document.body.innerText : ''",
    );
    return { url, text, verdict: verdictOf({ url, text }) };
  };
  const ready = await poll(
    async () => ({
      field: await inGuest<boolean>(
        `!!document.querySelector(${JSON.stringify(FIELD)})`,
      ),
      ...(await page()),
    }),
    (state) => state.field || state.verdict === "rejected",
    60_000,
  );
  // Refused on arrival, before there was anything to type.
  if (ready.verdict === "rejected") return ready;
  if (!ready.field)
    throw new Error(`Work never showed the address field: ${ready.url}`);
  await app.eval(`${view}.focus(); true`);
  await inGuest(`document.querySelector(${JSON.stringify(FIELD)}).focus()`);
  await app.waitFor(
    `${view}.executeJavaScript(${JSON.stringify(`document.activeElement === document.querySelector(${JSON.stringify(FIELD)}) && document.hasFocus()`)})`,
    { label: "address field focused" },
  );
  await app.insertText(madeUpAddress());
  await app.press("Enter");
  return poll(page, (state) => state.verdict !== "unclear", 45_000);
}

const failed = (error: unknown): Outcome => ({
  verdict: "unclear",
  url: "",
  text: "",
  error: error instanceof Error ? error.message : String(error),
});
const summary = (outcome: Outcome) =>
  `${outcome.verdict} at ${outcome.url || "(no page)"}${outcome.error ? ` (${outcome.error})` : ""}: ${outcome.text.replace(/\s+/g, " ").slice(0, 300)}`;

describeIf("Google's sign-in, live", () => {
  beforeAll(async () => {
    app = await launchApp({ urls: [SIGN_IN] });
  });
  afterAll(async () => {
    await app?.stop();
  });

  it("lets Work past its supported-browser gate", {
    timeout: 300_000,
  }, async (context) => {
    const work = await signInWithWork().catch(failed);
    if (work.verdict !== "admitted")
      await app
        .screenshot(path.join(ARTIFACTS, "google-sign-in.png"))
        .catch(() => {});
    const binary = chromeBinary();
    const control = binary
      ? await signInWithChrome(binary).catch(failed)
      : undefined;
    // Work is judged unless Google refused real Chrome here too.
    const outcome =
      work.verdict === "rejected" && control?.verdict === "rejected"
        ? "network-refused"
        : work.verdict;
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      path.join(ARTIFACTS, "google-sign-in.json"),
      JSON.stringify({ outcome, work, control: control ?? null }, null, 2),
    );
    if (outcome === "network-refused")
      context.skip(
        `Google refused real Chrome here too; nothing to learn about Work from this network. Chrome: ${summary(control ?? failed("no control"))}`,
      );
    if (outcome === "admitted" && control && control.verdict !== "admitted")
      console.warn(
        `[google-sign-in] Work was admitted but the Chrome control was not, so a refusal here would go unexplained: ${summary(control)}`,
      );
    expect(
      work.verdict,
      `Work: ${summary(work)}. Chrome: ${control ? summary(control) : "not on this host"}`,
    ).toBe("admitted");
  });
});
