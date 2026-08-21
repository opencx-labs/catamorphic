import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CompanionHandle,
  chromeBinary,
  launchCompanion,
} from "./harness.js";

/** Set a React-controlled input's value through the native setter. */
const TYPE = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;

const CLICK = (selector: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()
`;

const CLICK_BY_TEXT = (selector: string, text: string) => `
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()
`;

describe.skipIf(!chromeBinary())("companion PWA", () => {
  let app: CompanionHandle;

  beforeAll(async () => {
    app = await launchCompanion();
  }, 90_000);

  afterAll(async () => {
    await app?.stop();
  });

  it("redeems a connect link and lands on the project's sessions", async () => {
    // Fresh profile with no connections: the connect screen is home.
    await app.waitFor(
      "!!document.querySelector('[data-testid=connect-input]')",
    );
    expect(
      await app.eval(TYPE("[data-testid=connect-input]", app.connectLink)),
    ).toBe(true);
    await app.waitFor(
      "!document.querySelector('[data-testid=connect-submit]').disabled",
    );
    await app.eval(CLICK("[data-testid=connect-submit]"));
    await app.waitFor(
      "document.body.innerText.includes('Acme Brain') && !!document.querySelector('[data-testid=new-chat]')",
      { label: "sessions screen", timeoutMs: 20_000 },
    );
  });

  it("starts a chat, sends a message, and renders the reply with steps", async () => {
    await app.eval(CLICK("[data-testid=new-chat]"));
    await app.waitFor("!!document.querySelector('[data-testid=chat-input]')");
    await app.eval(TYPE("[data-testid=chat-input]", "hello there"));
    await app.eval(CLICK("[data-testid=chat-send]"));
    // Optimistic user bubble, then the scripted reply + collapsed steps.
    await app.waitFor("document.body.innerText.includes('hello there')");
    await app.waitFor("document.body.innerText.includes('You said:')", {
      timeoutMs: 20_000,
      label: "assistant reply",
    });
    await app.waitFor(
      "!!document.querySelector('[data-testid=chat-turn-steps]')",
    );
  });

  it("surfaces a tool-permission ask and resolves it from the phone", async () => {
    await app.eval(TYPE("[data-testid=chat-input]", "ask to post"));
    await app.eval(CLICK("[data-testid=chat-send]"));
    await app.waitFor(
      "!!document.querySelector('[data-testid=tool-permission-card]')",
      { timeoutMs: 20_000, label: "permission card" },
    );
    await app.eval(CLICK("[data-testid=tool-permission-allow]"));
    await app.waitFor(
      "document.body.innerText.includes('Posted the summary')",
      { timeoutMs: 20_000, label: "allowed tool result" },
    );
  });

  it("renders agent questions and submits a picked answer", async () => {
    await app.eval(TYPE("[data-testid=chat-input]", "question time"));
    await app.eval(CLICK("[data-testid=chat-send]"));
    await app.waitFor(
      "document.body.innerText.includes('Which environment should I target?')",
      { timeoutMs: 20_000, label: "question panel" },
    );
    await app.eval(CLICK_BY_TEXT("button", "Staging"));
    await app.eval(CLICK_BY_TEXT("button", "Submit"));
    // The answer goes back as a plain user message.
    await app.waitFor(
      "[...document.querySelectorAll('article')].some(a => a.innerText.includes('Staging'))",
      { timeoutMs: 20_000, label: "answer in transcript" },
    );
  });

  it("navigates back through the stack to projects", async () => {
    await app.eval(CLICK("[data-testid=screen-back]"));
    await app.waitFor("!!document.querySelector('[data-testid=new-chat]')", {
      label: "sessions screen again",
    });
    await app.eval(CLICK("[data-testid=screen-back]"));
    await app.waitFor("!!document.querySelector('[data-testid=project-row]')", {
      label: "projects screen",
    });
    expect(await app.eval<string>("document.body.innerText")).toContain(
      "Acme Brain",
    );
  });
});
