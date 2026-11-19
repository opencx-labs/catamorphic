import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

/**
 * The composer shrinks as smoothly as it grows: a line deleted with a real
 * Backspace glides away at every height, the draft scrolled past the
 * composer's own height included, where the browser pulls the scroll back
 * to the shorter end in a single frame. The palette's text input too.
 *
 * Frames are recorded with the page's animations at a tenth of their pace
 * (as motion.e2e.ts inspects them), so a slow runner's long frame cannot
 * pass for a snap, nor a snap hide inside one.
 */

let app: AppHandle;
const editor = `[...document.querySelectorAll('[data-composer-input]')].find(root => !root.closest('[inert], [data-workspace-visible="false"]'))`;
const paletteInput = `[...document.querySelectorAll('[data-palette="overlay"] textarea[aria-label="Search commands, pages, and more"]')].find((el) => !el.closest('[inert]'))`;
const MOD = process.platform === "darwin" ? 4 : 2;

beforeAll(async () => {
  app = await launchApp();
  await createProjectWorkspace({
    app,
    name: "Composer shrinking",
    rootPath: `${app.userDataDir}/composer-shrink`,
  });
  await app.press("n", MOD);
  await app.waitFor(`!!${editor}`);
});
afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

interface Frame {
  at: number;
  height: number;
  /** Where the watched text is painted, in the window. */
  y: number | null;
  scrollTop: number;
}

/** A draft of `lines` lines ("L1 words" …), the caret at its end, settled. */
async function prepare(lines: number) {
  const draft = Array.from(
    { length: lines },
    (_, index) => `L${index + 1} words`,
  ).join("\n");
  await app.eval(`(async () => {
    const root = ${editor};
    root.focus({preventScroll:true});
    root.textContent = ${JSON.stringify(draft)};
    root.dispatchEvent(new InputEvent('input', {bubbles:true}));
    const selection = getSelection();
    selection.setPosition(root.firstChild, root.firstChild.length);
    await new Promise(resolve => setTimeout(resolve, 400));
    root.scrollTo({top: root.scrollHeight, behavior:'instant'});
    await new Promise(resolve => setTimeout(resolve, 400));
  })()`);
}

/** Backspace until the last line is empty: "L<n> words" is 8 characters. */
async function emptyLastLine() {
  for (let index = 0; index < 8; index += 1) await app.press("Backspace");
}

/** Select All as the platform does it (macOS runs it as an editing command). */
async function selectAll() {
  for (const type of ["keyDown", "keyUp"])
    await app.cdp("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: MOD,
      ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
    });
}

/**
 * Sample every painted frame of `input` inside its frame (the parent that
 * clips it), slowed. `locate` returns where the watched text is painted.
 */
async function record(input: string, locate: string) {
  await app.cdp("Animation.enable");
  await app.cdp("Animation.setPlaybackRate", { playbackRate: 0.1 });
  await app.eval(`(() => {
    const input = ${input};
    const frame = input.parentElement.closest('.overflow-clip');
    const locate = ${locate};
    const started = performance.now();
    window.__shrink = [];
    window.__shrinkRecording = true;
    const sample = () => {
      const y = locate(input);
      window.__shrink.push({
        at: Math.round(performance.now() - started),
        height: Math.round(frame.getBoundingClientRect().height * 10) / 10,
        y: y === null ? null : Math.round(y * 10) / 10,
        scrollTop: input.scrollTop,
      });
      if (window.__shrinkRecording) requestAnimationFrame(sample);
    };
    sample();
  })()`);
}

/** The first character of the line starting `watch`, in the composer. */
const lineOf = (watch: string) => `(root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.nodeValue.indexOf(${JSON.stringify(watch)});
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at); range.setEnd(node, at + 1);
    return range.getBoundingClientRect().top;
  }
  return null;
}`;

/** A textarea's text, where its first line is painted (glide included). */
const textareaText = `(input) => input.getBoundingClientRect().top - input.scrollTop`;

async function stop(): Promise<Frame[]> {
  try {
    return await app.eval<Frame[]>(`(async () => {
      // 150ms at a tenth of the pace, and some.
      await new Promise(resolve => setTimeout(resolve, 2200));
      window.__shrinkRecording = false;
      return window.__shrink;
    })()`);
  } finally {
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
    await app.cdp("Animation.disable");
  }
}

/** The glide as recorded: 150ms at a tenth of the pace. */
const RECORDED_GLIDE_MS = 1500;

/**
 * The watched text rides one way through the frames between: never back,
 * and no single frame carries much of the way (a snap carries all of it,
 * the step back within the composer's height half of it). A runner that
 * paints no frame for a while records that stretch as one step, so a step
 * may carry what the glide covers in its time: the standard curve's
 * steepest stretch runs about four times its average pace.
 */
function expectGlide(frames: Frame[], label: string) {
  const painted = frames.filter(
    (frame): frame is Frame & { y: number } => frame.y !== null,
  );
  const trace = `${label}: ${JSON.stringify(frames)}`;
  const first = painted[0]?.y ?? 0,
    last = painted.at(-1)?.y ?? 0;
  const total = last - first;
  expect(Math.abs(total), trace).toBeGreaterThan(5);
  const direction = Math.sign(total);
  for (let index = 1; index < painted.length; index += 1) {
    const previous = painted[index - 1],
      current = painted[index];
    if (!previous || !current) continue;
    const step = current.y - previous.y;
    expect(
      step * direction,
      `${trace}\nback at frame ${index}`,
    ).toBeGreaterThan(-0.6);
    const share = Math.max(
      0.25,
      (5 * (current.at - previous.at)) / RECORDED_GLIDE_MS,
    );
    expect(Math.abs(step), `${trace}\nsnap at frame ${index}`).toBeLessThan(
      Math.abs(total) * share,
    );
  }
}

/** The watched text stays where it was painted, and the scroll with it. */
function expectStill(frames: Frame[], label: string) {
  const trace = `${label}: ${JSON.stringify(frames)}`;
  const [first] = frames;
  expect(first?.y, trace).not.toBeNull();
  for (const frame of frames) {
    expect(Math.abs((frame.y ?? 0) - (first?.y ?? 0)), trace).toBeLessThan(0.6);
    expect(frame.scrollTop, trace).toBe(first?.scrollTop);
  }
}

it("holds still when Backspace empties the last line of a draft just past the composer", async () => {
  // Chromium lays the draft out without the emptied line for a moment and
  // used to keep the scroll that allowed: the text dropped, the caret's
  // line cut off below.
  await prepare(4);
  for (let index = 0; index < 7; index += 1) await app.press("Backspace");
  await record(editor, lineOf("L2"));
  await app.press("Backspace");
  expectStill(await stop(), "4 lines, the last emptied");
});

it("glides when a deleted line leaves a draft shorter than the composer", async () => {
  await prepare(3);
  await emptyLastLine();
  await record(editor, lineOf("L2"));
  await app.press("Backspace");
  expectGlide(await stop(), "3 → 2 lines");
});

it("glides when a line is deleted from a draft scrolled past the composer", async () => {
  await prepare(6);
  await emptyLastLine();
  await record(editor, lineOf("L5"));
  await app.press("Backspace");
  expectGlide(await stop(), "6 → 5 lines, scrolled");
});

it("glides when a deleted line brings the draft back within the composer", async () => {
  await prepare(4);
  await emptyLastLine();
  await record(editor, lineOf("L3"));
  await app.press("Backspace");
  expectGlide(await stop(), "4 → 3 lines");
});

it("glides when the whole draft is replaced by a shorter one", async () => {
  await prepare(3);
  await selectAll();
  await record(editor, lineOf("L1"));
  await app.insertText("L1");
  expectGlide(await stop(), "select all, retype");
});

it("glides the palette's input the same way", async () => {
  await app.eval(`(() => {
    const root = ${editor};
    root.textContent = '';
    root.dispatchEvent(new InputEvent('input', {bubbles:true}));
  })()`);
  await app.press("p", MOD);
  await app.waitFor(`!!(${paletteInput})`, { label: "palette open" });
  const draft = Array.from(
    { length: 12 },
    (_, index) => `P${index + 1} words`,
  ).join("\n");
  await app.eval(`(async () => {
    const input = ${paletteInput};
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(draft)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 400));
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTo({top: input.scrollHeight, behavior:'instant'});
    await new Promise(resolve => setTimeout(resolve, 400));
    return input.scrollTop > 0;
  })()`);
  expect(
    await app.eval<boolean>(`(${paletteInput}).scrollTop > 0`),
    "the draft scrolls past the input",
  ).toBe(true);
  for (let index = 0; index < "P12 words".length; index += 1)
    await app.press("Backspace");
  await record(paletteInput, textareaText);
  await app.press("Backspace");
  expectGlide(await stop(), "palette, 12 → 11 lines, scrolled");
  await app.eval(`(() => {
    const input = ${paletteInput};
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await app.press("Escape");
  await app.waitFor(`!(${paletteInput})`, { label: "palette closed" });
});
