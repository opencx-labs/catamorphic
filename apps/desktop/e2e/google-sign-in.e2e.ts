import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Google's own sign-in, live. Google turns away a browser it takes for an
 * embedded or disguised one at the first step, before it looks the account
 * up: "Couldn't sign you in. This browser or app may not be secure"
 * (ADR 0150). A made-up address gets past that gate in Chrome, which then
 * says "Couldn't find this account"; Work must get the same answer.
 * Google changes its gate without notice, so this runs every day
 * (.github/workflows/google-sign-in.yml), and only with the explicit
 * external-test authority (CATAMORPHIC_EXTERNAL_INTEGRATIONS=1).
 * browser-identity.e2e.ts checks offline what this depends on.
 */
const external = process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";
const describeIf = external ? describe : describe.skip;

const SIGN_IN =
  "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin";
const FIELD = "input#identifierId, input[type=email], input[name=identifier]";

type Verdict = "rejected" | "admitted" | "unclear";
interface Outcome {
  verdict: Verdict;
  url: string;
  text: string;
}

function verdictOf({ url, text }: { url: string; text: string }): Verdict {
  if (/\/signin\/rejected/.test(url) || /may not be secure/i.test(text))
    return "rejected";
  // Past the gate: the account lookup, or the CAPTCHA Google asks of a
  // network that tried too often (a turned-away browser is never asked).
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    await send("Page.navigate", { url: SIGN_IN });
    await poll(
      () => evaluate(`!!document.querySelector(${JSON.stringify(FIELD)})`),
      (found) => found === true,
      30_000,
    );
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
      async () => {
        const page = await evaluate(
          "({ url: location.href, text: document.body.innerText })",
        );
        if (!page || typeof page !== "object") throw new Error("No page");
        const url = "url" in page ? String(page.url) : "";
        const text = "text" in page ? String(page.text) : "";
        return { url, text, verdict: verdictOf({ url, text }) };
      },
      (page) => page.verdict !== "unclear",
      30_000,
    );
    socket.close();
    return outcome;
  } finally {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

let app: AppHandle;
const view = `document.querySelector('webview')`;
const inGuest = <T>(code: string) =>
  app.eval<T>(`${view}.executeJavaScript(${JSON.stringify(code)}, true)`);

describeIf("Google's sign-in, live", () => {
  beforeAll(async () => {
    app = await launchApp({ urls: [SIGN_IN] });
  });
  afterAll(async () => {
    await app?.stop();
  });

  it("lets Work past its supported-browser gate", async (context) => {
    // A guest between documents throws instead of answering: "not yet".
    await app.waitFor(
      `Promise.resolve().then(() => ${view}.executeJavaScript(${JSON.stringify(`!!document.querySelector(${JSON.stringify(FIELD)})`)})).catch(() => false)`,
      { timeoutMs: 60_000, label: "Google's sign-in page" },
    );
    await app.eval(`${view}.focus(); true`);
    await inGuest(`document.querySelector(${JSON.stringify(FIELD)}).focus()`);
    await app.waitFor(
      `${view}.executeJavaScript(${JSON.stringify(`document.activeElement === document.querySelector(${JSON.stringify(FIELD)}) && document.hasFocus()`)})`,
      { label: "address field focused" },
    );
    await app.insertText(madeUpAddress());
    await app.press("Enter");
    const work = await poll(
      async () => {
        const url = await app.eval<string>(`${view}.getURL()`);
        const text = await inGuest<string>("document.body.innerText");
        return { url, text, verdict: verdictOf({ url, text }) };
      },
      (page) => page.verdict !== "unclear",
      45_000,
    );
    if (work.verdict !== "admitted") {
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
          "google-sign-in.png",
        ),
      );
    }
    if (work.verdict === "rejected") {
      // Whether Google refuses Work, or everyone on this network.
      const binary = chromeBinary();
      const control = binary ? await signInWithChrome(binary) : undefined;
      if (control && control.verdict !== "admitted")
        context.skip(
          `Google turned away real Chrome here too (${control.verdict}: ${control.url}); nothing to learn about Work from this network`,
        );
    }
    expect(
      work.verdict,
      `Google's answer to Work at ${work.url}: ${work.text.replace(/\s+/g, " ").slice(0, 400)}`,
    ).toBe("admitted");
  });
});
