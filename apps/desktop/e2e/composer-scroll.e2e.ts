import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

let app: AppHandle;
const editor = `[...document.querySelectorAll('[data-composer-input]')].find(root => !root.closest('[inert], [data-workspace-visible="false"]'))`;

beforeAll(async () => {
  app = await launchApp();
  await createProjectWorkspace({
    app,
    name: "Composer scrolling",
    rootPath: `${app.userDataDir}/composer-scroll`,
  });
  await app.press("n", process.platform === "darwin" ? 4 : 2);
  await app.waitFor(`!!${editor}`);
});
afterAll(async () => {
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
});

async function prepare(atEnd: boolean, scrolledDown: boolean) {
  const draft = Array.from(
    { length: 45 },
    (_, index) => `Line ${index + 1} of the draft`,
  ).join("\n");
  await app.eval(`(async () => {
    const root = ${editor};
    root.focus({preventScroll:true});
    root.textContent = ${JSON.stringify(draft)};
    root.dispatchEvent(new InputEvent('input', {bubbles:true}));
    const selection = getSelection();
    selection.setPosition(root.firstChild, ${atEnd} ? root.firstChild.length : 0);
    await new Promise(resolve => setTimeout(resolve, 400));
    root.scrollTo({top: ${scrolledDown} ? root.scrollHeight : 0, behavior:'instant'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__caretScrollSamples = [];
    window.__caretScrollRecording = true;
    const record = () => {
      window.__caretScrollSamples.push(root.scrollTop);
      if (window.__caretScrollRecording) requestAnimationFrame(record);
    };
    record();
  })()`);
}

async function result() {
  return app.eval<{
    samples: number[];
    visible: boolean;
    ancestors: number[];
    top: number;
  }>(`(async () => {
    await new Promise(resolve => setTimeout(resolve, 650));
    window.__caretScrollRecording = false;
    const root = ${editor};
    const selection = getSelection();
    const range = document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset); range.collapse(true);
    const caret = range.getBoundingClientRect(), viewport = root.getBoundingClientRect();
    return {samples: window.__caretScrollSamples, top:root.scrollTop, visible: caret.top >= viewport.top - 1 && caret.bottom <= viewport.bottom + 1,
      ancestors: [root.parentElement.scrollTop, root.parentElement.parentElement.scrollTop]};
  })()`);
}

function expectGlide(samples: number[]) {
  const start = samples[0] ?? 0,
    end = samples.at(-1) ?? 0;
  expect(Math.abs(end - start)).toBeGreaterThan(5);
  expect(
    samples.some(
      (value) =>
        value > Math.min(start, end) + 1 && value < Math.max(start, end) - 1,
    ),
  ).toBe(true);
}

it("smoothly reveals an offscreen caret when typing or using arrows in either direction", async () => {
  await prepare(true, false);
  await app.insertText("x");
  const typing = await result();
  expectGlide(typing.samples);
  expect(typing.visible).toBe(true);
  expect(typing.ancestors).toEqual([0, 0]);

  await prepare(false, true);
  await app.press("ArrowRight");
  const arrow = await result();
  expectGlide(arrow.samples);
  expect(arrow.visible).toBe(true);
  expect(arrow.ancestors).toEqual([0, 0]);

  await prepare(false, true);
  await app.press("ArrowRight", 8);
  const selection = await result();
  expectGlide(selection.samples);
  expect(selection.visible).toBe(true);
});

it("glides upward as new lines extend an overflowing draft", async () => {
  await prepare(true, true);
  await app.press("Enter", 8);
  const newline = await result();
  expectGlide(newline.samples);
  expect(newline.ancestors).toEqual([0, 0]);
  // Empty text nodes after a native line break have no DOM range rect.
  // Confirm typing continues visibly on that new line without another jump.
  await app.insertText("x");
  const continued = await result();
  expect(continued.visible).toBe(true);
  expect(continued.top).toBe(newline.top);
  await app.screenshot(
    path.join(
      process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
      "composer-overflow.png",
    ),
  );
});

it("leaves manual scrolling in control until the next edit", async () => {
  await prepare(true, true);
  const point = await app.eval<{ x: number; y: number }>(`(() => {
    const rect = ${editor}.getBoundingClientRect();
    return {x:rect.x + rect.width/2, y:rect.y + rect.height/2};
  })()`);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -200,
  });
  const manual = await result();
  expect(manual.top).toBeLessThan(manual.samples[0] ?? 0);
  expect(manual.visible).toBe(false);
});

it("reveals the caret immediately with reduced motion", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await prepare(true, false);
    await app.insertText("x");
    const reduced = await result();
    expect(reduced.visible).toBe(true);
    const start = reduced.samples[0] ?? 0,
      end = reduced.samples.at(-1) ?? 0;
    expect(
      reduced.samples.some((value) => value > start + 1 && value < end - 1),
    ).toBe(false);
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});
