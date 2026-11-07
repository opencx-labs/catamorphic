import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  focusWindow,
  launchApp,
} from "./harness.js";

let app: AppHandle;
const dock = "document.querySelector('[data-chat-local-id]:not([inert])')";
const editor = `${dock}.querySelector('[data-composer-input]')`;
const scroller = `${dock}.querySelector('[role="log"]').firstElementChild`;
const following = `${scroller}.firstElementChild.hasAttribute('data-pinned')`;
const shot = async (name: string) => {
  const directory = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
  if (directory) await app.screenshot(path.join(directory, `${name}.png`));
};
const send = async (text: string) => {
  await app.eval(`${editor}.focus()`);
  await app.insertText(text);
  await app.press("Enter");
  await app.waitFor(
    `${dock}.textContent.includes(${JSON.stringify(`You said: ${text.slice(0, 40)}`)}) && !${dock}.querySelector('[aria-label="Stop the agent"]')`,
  );
};
const aligned = (index: number) =>
  app.waitFor(`(()=>{
  const s=${scroller},m=s.querySelectorAll('[data-user-message]')[${index}];
  const top=m.getBoundingClientRect().top-s.getBoundingClientRect().top;
  return top>=0 && top<60;
})()`);

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  await createProjectWorkspace({
    app,
    name: "Chat input and navigation",
    rootPath: path.join("/tmp", "chat-input-navigation"),
  });
  await app.waitFor(`!!document.querySelector('[data-workspace-ready]')`);
  await app.press("n", process.platform === "darwin" ? 4 : 2);
  await app.waitFor(`!!${editor}`);
  await focusWindow(app);
  for (let index = 0; index < 2; index += 1)
    await send(
      `Tall message ${index}.\n\n${"A paragraph in a longer conversation.\n\n".repeat(28)}`,
    );
  await send("A short final message.");
  await app.waitFor(following);
});
afterAll(async () => {
  await app?.stop();
});

it("advances after a rounded PageUp landing and passes an unalignable final message", async () => {
  await app.press("PageUp");
  await aligned(1);
  // Force the settled position inside the native scroll's tolerance.
  // The row's 4px padding must not make the same message count again.
  await app.eval(
    `(()=>{const s=${scroller};s.scrollTo({top:s.scrollTop,behavior:'instant'});s.dispatchEvent(new Event('scrollend'));s.scrollTop+=1;})()`,
  );
  await app.press("PageUp");
  await aligned(0);
  await shot("chat-page-up");
  await app.press("PageDown");
  await aligned(1);
  await app.eval(`${scroller}.dispatchEvent(new Event('scrollend'))`);
  await app.press("PageDown");
  await app.waitFor(
    `${scroller}.scrollHeight-${scroller}.clientHeight-${scroller}.scrollTop<2`,
  );
  // The final short message is below the navigation line at maximum scroll.
  await app.eval(`${scroller}.dispatchEvent(new Event('scrollend'))`);
  await app.press("PageDown");
  // At an unchanged endpoint the library's public "near bottom" state
  // need not render again. Grow the answer to verify actual following,
  // including the browser's pin, rather than a stale dataset at rest.
  await app.eval(
    `(()=>{const s=${scroller};const growth=document.createElement('div');growth.style.height='64px';s.firstElementChild.insertBefore(growth,s.firstElementChild.lastElementChild);})()`,
  );
  try {
    await app.waitFor(following, {
      label: "one more tap resumes following after the short message",
    });
  } catch (error) {
    const state = await app.eval(
      `(()=>{const s=${scroller};return{top:s.scrollTop,max:s.scrollHeight-s.clientHeight,pinned:s.firstElementChild.getAttribute('data-pinned'),messages:[...s.querySelectorAll('[data-user-message]')].map(m=>({article:m.getBoundingClientRect().top-s.getBoundingClientRect().top,row:m.closest('.cat-row').getBoundingClientRect().top-s.getBoundingClientRect().top})),focus:document.activeElement===${editor}}})()`,
    );
    throw new Error(JSON.stringify(state), { cause: error });
  }
  await shot("chat-page-down-latest");
});

it("keeps character-by-character edits and caret order while the agent works", async () => {
  await app.eval(`${editor}.focus()`);
  await app.insertText("work slowly please");
  await app.press("Enter");
  await app.waitFor(`!!${dock}.querySelector('[aria-label="Stop the agent"]')`);
  await app.eval(`${editor}.focus()`);
  const text =
    "Typing steadily while the conversation changes keeps every letter in order.";
  for (const character of text) {
    await app.cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: character,
      text: character,
    });
    await app.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: character });
  }
  expect(await app.eval(`${editor}.textContent`)).toBe(text);
  for (let index = 0; index < 6; index += 1) await app.press("ArrowLeft");
  await app.press("Backspace");
  await app.insertText("X");
  const expected = `${text.slice(0, -7)}X${text.slice(-6)}`;
  expect(await app.eval(`${editor}.textContent`)).toBe(expected);
  expect(
    await app.eval(
      `(()=>{const s=getSelection();return ${editor}.contains(s.anchorNode)&&s.isCollapsed&&s.anchorOffset===${text.length - 6}})()`,
    ),
  ).toBe(true);
  await shot("chat-typing-caret");
  // Chromium groups the replacement with its preceding deletion. CDP skips
  // macOS's native key binding lookup, so supply its editing command too.
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key: "z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90,
      modifiers: process.platform === "darwin" ? 4 : 2,
      ...(type === "keyDown" ? { commands: ["undo"] } : {}),
    });
  expect(await app.eval(`${editor}.textContent`)).toBe(text);
  const stop = await app.eval<boolean>(
    `!!${dock}.querySelector('[aria-label="Stop the agent"]')`,
  );
  if (stop)
    await app.eval(
      `${dock}.querySelector('[aria-label="Stop the agent"]').click()`,
    );
  expect(app.getRendererErrors()).toEqual([]);
});
