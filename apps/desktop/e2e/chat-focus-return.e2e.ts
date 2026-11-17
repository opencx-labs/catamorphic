import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  focusWindow,
  launchApp,
  setReactValueJs,
  workspaceDomHelpersJs,
} from "./harness.js";

/**
 * An action taken in a chat gives its composer the keys back: answers
 * submitted, Retry pressed with the pointer or with a key. A question
 * being answered keeps focus among its options.
 */

let app: AppHandle;

const helpers = `
  ${workspaceDomHelpersJs}
  ${setReactValueJs}
  // The chat in front, a tab or floating; one behind it is inert or hidden.
  const chat = () => $$('section[data-chat-local-id]').find((el) => !el.closest('[inert]') && el.checkVisibility());
  const composer = () => chat()?.querySelector('[data-composer-input]');
  const panel = () => chat()?.querySelector('section[aria-label="The agent has a question"]');
  const byText = (root, selector, text) =>
    [...(root?.querySelectorAll(selector) ?? [])].find((el) => el.textContent.trim().includes(text));
  const send = (text) => { const input = composer(); setReactValue(input, text); input.closest('form').requestSubmit(); };
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

/** A real press of the pointer, as a person clicks (a click with detail). */
async function click(locate: string, label: string) {
  const point = await runWait<{ x: number; y: number }>(
    `const el = ${locate};
     if (!el || el.closest('[inert]') || el.disabled) return false;
     return center(el);`,
    { label },
  );
  await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}

const composerFocused = (label: string) =>
  runWait(
    "return document.hasFocus() && !!composer() && document.activeElement === composer();",
    { label },
  );

beforeAll(async () => {
  app = await launchApp();
  await createProjectWorkspace({
    app,
    name: "Focus returns",
    rootPath: `${app.userDataDir}/focus-returns`,
  });
  await app.press("n", process.platform === "darwin" ? 4 : 2);
  await runWait("return !!composer();", { label: "a chat to type in" });
  await focusWindow(app);
});
afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

it("answers submitted with the pointer give the composer its keys", async () => {
  await run(`send('ask me a bunch of questions about myself'); return true;`);
  await runWait("return !!panel();", {
    timeoutMs: 30_000,
    label: "question panel",
  });
  await click(`byText(panel(), 'button', 'Orange')`, "first answer");
  // Answering moves on to the next question and keeps focus there.
  await runWait(
    `const cats = byText(panel(), 'button', 'Cats');
     return !!cats && !cats.closest('[inert]') && panel().contains(document.activeElement);`,
    { label: "focus stays with the next question" },
  );
  await click(`byText(panel(), 'button', 'Cats')`, "second answer");
  // A frame later, a press on an option still leaves focus in the panel.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(
    await run<boolean>("return panel().contains(document.activeElement);"),
  ).toBe(true);
  await click(`byText(panel(), 'button', 'Submit')`, "submit");
  await composerFocused("the composer has the keys after submitting");
  await runWait(
    "return chat().textContent.includes('Got it, noted') && !panel();",
    { timeoutMs: 30_000, label: "answered" },
  );
  expect(
    await run<boolean>("return document.activeElement === composer();"),
  ).toBe(true);
});

it("Retry pressed with the pointer gives the composer its keys", async () => {
  await run(`send('please fail with an auth error, then click'); return true;`);
  await click(
    `chat()?.querySelector('[data-testid="chat-retry"]')`,
    "retry on the failed turn",
  );
  await composerFocused("the composer has the keys after Retry");
  await runWait(
    "return chat().textContent.includes('Recovered after reconnecting.');",
    { timeoutMs: 30_000, label: "retried" },
  );
  expect(
    await run<boolean>("return document.activeElement === composer();"),
  ).toBe(true);
});

it("Retry pressed with a key keeps focus until it goes, then the composer has it", async () => {
  await run(`send('please fail with an auth error, then press'); return true;`);
  await runWait(
    `const retry = [...chat().querySelectorAll('[data-testid="chat-retry"]')].at(-1);
     if (!retry) return false; retry.focus(); return document.activeElement === retry;`,
    { timeoutMs: 30_000, label: "retry focused" },
  );
  await app.press("Enter");
  await composerFocused("the composer has the keys once Retry is gone");
  await runWait(
    "return chat().textContent.split('Recovered after reconnecting.').length > 2;",
    { timeoutMs: 30_000, label: "retried" },
  );
});
