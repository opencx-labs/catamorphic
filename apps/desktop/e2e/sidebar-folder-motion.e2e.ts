import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  NEW_TAB_INPUT,
  openProjectSwitcher,
  setReactValueJs,
  workspaceDomHelpersJs,
} from "./harness.js";

let app: AppHandle;
let folderId: string;
const helpers = `${setReactValueJs} ${workspaceDomHelpersJs} const button = text => $$('button').find(b => !b.closest('[inert]') && b.textContent.trim() === text);`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers} ${body} })()`);
const wait = (body: string) =>
  app.waitFor(`(() => { ${helpers} return (${body}); })()`);

const SECTION =
  '[data-workspace-visible="true"] [data-sidebar-section=bookmarks]';
const ROW = 28;
/** One linear second per beat, so every frame lands well inside it. */
const BEAT_MS = 1000;
const CHILDREN = ["One", "Two", "Three", "Four"];

type Frame = Record<
  string,
  {
    top: number;
    /** Its visible part, inside any clip. */
    visibleTop: number;
    visibleBottom: number;
    opacity: number;
    /** Drawn by a row folding under its folder. */
    folding: boolean;
  }
>;
type Recording = { frames: Frame[]; turn: number; duplicates: string[] };

/**
 * Presses the folder's chevron and records, every frame for the beat, where
 * each bookmark row is drawn and how opaque it looks. `then` presses it
 * again partway, between two samples taken in the same frame (`turn`).
 * The presses are synthetic: they must land inside the frame loop.
 */
const record = async (
  label: string,
  then?: { label: string; afterMs: number },
) => {
  // Slow and linear: the rows below slide on the same tokens.
  await run(
    `const section=$(${JSON.stringify(SECTION)});section.style.setProperty('--cat-motion-base','${BEAT_MS}ms');section.style.setProperty('--ease-standard','linear')`,
  );
  // Starting from rest: the section settles after its rows arrive.
  await wait(
    `$(${JSON.stringify(SECTION)}).getAnimations({subtree:true}).every(a=>a.playState!=='running' || a.effect?.getTiming().iterations===Infinity)`,
  );
  return app.eval<Recording>(`new Promise(resolve => {
    const section = document.querySelector(${JSON.stringify(SECTION)});
    const tree = section.querySelector('[role=tree]');
    const origin = tree.getBoundingClientRect().top;
    const frames = [];
    const duplicates = [];
    const sample = () => {
      const frame = {};
      for (const row of tree.querySelectorAll('[data-point-key^="sidebar:"]')) {
        const name = row.dataset.pointKey.slice(8);
        if (frame[name]) duplicates.push(name);
        const box = row.getBoundingClientRect();
        let opacity = 1;
        let clipTop = 0;
        let clipBottom = 0;
        for (let node = row; node && node !== tree; node = node.parentElement) {
          const style = getComputedStyle(node);
          opacity *= Number(style.opacity);
          if (!style.clipPath.startsWith('inset(')) continue;
          const [top, right = top, bottom = top] = (style.clipPath.match(/-?[\\d.]+(?:e-?\\d+)?/g) ?? []).map(Number);
          clipTop = Math.max(clipTop, top ?? 0);
          clipBottom = Math.max(clipBottom, bottom ?? 0);
        }
        const top = Math.round(box.top - origin);
        frame[name] = {
          top,
          visibleTop: top + Math.round(clipTop),
          visibleBottom: Math.round(box.bottom - origin - clipBottom),
          opacity: Math.round(opacity * 100) / 100,
          folding: !!row.closest('[data-tree-folding]'),
        };
      }
      frames.push(frame);
    };
    const press = text => section.querySelector('button[aria-label="' + text + '"]').click();
    sample();
    press(${JSON.stringify(label)});
    const start = performance.now();
    let turn = ${then ? -1 : 0};
    const tick = async () => {
      if (turn < 0 && performance.now() - start >= ${then?.afterMs ?? 0}) {
        sample();
        turn = frames.length - 1;
        press(${JSON.stringify(then?.label)});
        // React commits the press in a microtask, still within this frame.
        await new Promise(queueMicrotask);
      }
      sample();
      if (performance.now() - start < ${BEAT_MS * 1.3}) requestAnimationFrame(tick);
      else resolve({ frames, turn, duplicates });
    };
    requestAnimationFrame(tick);
  })`);
};

/**
 * The folder's children never draw over the row below its branch or over
 * the folder itself, and that row slides rather than jumps.
 */
function expectSmooth({ frames, duplicates }: Recording) {
  expect(duplicates).toEqual([]);
  for (const [index, frame] of frames.entries()) {
    const folder = frame.Cloud;
    const below = frame.After;
    for (const child of CHILDREN) {
      const row = frame[child];
      if (!row || row.opacity < 0.05 || row.visibleBottom <= row.visibleTop)
        continue;
      if (below)
        expect(
          row.visibleBottom,
          `frame ${index}: ${child} over After`,
        ).toBeLessThanOrEqual(below.top + 1);
      if (folder)
        expect(
          row.visibleTop,
          `frame ${index}: ${child} over Cloud`,
        ).toBeGreaterThanOrEqual(folder.top + ROW - 1);
    }
  }
  const tops = frames.flatMap((frame) =>
    frame.After ? [frame.After.top] : [],
  );
  const first = tops[0] ?? 0;
  const last = tops.at(-1) ?? 0;
  const low = Math.min(first, last);
  const high = Math.max(first, last);
  // Drawn along the way, not only at either end.
  expect(
    tops.filter(
      (top) =>
        top > low + (high - low) * 0.2 && top < high - (high - low) * 0.2,
    ).length,
  ).toBeGreaterThan(5);
}

/** Each child stays in its slot and is drawn partly revealed on the way. */
function expectRevealed(frames: Frame[], folding: boolean) {
  for (const child of CHILDREN) {
    const drawn = frames.flatMap((frame) => {
      const row = frame[child];
      return row && row.folding === folding ? [row] : [];
    });
    expect(new Set(drawn.map((row) => row.top)).size, child).toBe(1);
    expect(
      drawn.some(
        (row) =>
          row.opacity > 0.05 &&
          row.visibleBottom - row.visibleTop > 2 &&
          row.visibleBottom - row.visibleTop < ROW - 2,
      ),
      child,
    ).toBe(true);
  }
}

beforeAll(async () => {
  app = await launchApp();
  await openProjectSwitcher(app);
  await wait("[...$$('button')].some(b=>b.textContent.trim()==='New project')");
  await run("button('New project').click()");
  await wait("!!$('[data-testid=project-name-input]')");
  await run("setReactValue($('[data-testid=project-name-input]'),'Folders')");
  await wait("!$('[data-testid=project-submit]').disabled");
  await run("$('[data-testid=project-submit]').click()");
  await wait(`!!$(${JSON.stringify(NEW_TAB_INPUT)})`);
  await wait(
    "window.catamorphicDesktop.getPrefs().then(prefs=>prefs.lastProjectId===$('[data-workspace-visible=true]')?.dataset.projectRuntime)",
  );
  folderId = await app.eval(
    `(async()=>{const api=window.catamorphicDesktop;const scope={profileId:await api.windowProfile(),projectId:(await api.getPrefs()).lastProjectId};
      const folder=await api.bookmarksAddFolder({...scope,label:'Cloud'});
      for (const label of ['One','Two','Three','Four'])
        await api.bookmarksAdd({...scope,label,url:'https://example.test/'+label,folderId:folder.id});
      await api.bookmarksAdd({...scope,label:'After',url:'https://example.test/after'});
      return folder.id})()`,
  );
  await wait(
    "!!$('[data-point-key=\"sidebar:After\"]') && !!$('button[aria-label=\"Expand Cloud\"]')",
  );
});
afterAll(async () => {
  await app?.stop();
});

it("opens a folder with its children revealed under it", async () => {
  const recording = await record("Expand Cloud");
  await wait(
    `$('[data-tree-id="${folderId}"]').getAttribute('aria-expanded')==='true'`,
  );
  expectSmooth(recording);
  expectRevealed(recording.frames, false);
  const last = recording.frames.at(-1);
  for (const child of CHILDREN) {
    expect(last?.[child]?.opacity, child).toBe(1);
    expect(
      (last?.[child]?.visibleBottom ?? 0) - (last?.[child]?.visibleTop ?? 0),
      child,
    ).toBe(ROW);
  }
  expect(app.getRendererErrors()).toEqual([]);
});

it("closes a folder with its children covered again", async () => {
  const recording = await record("Collapse Cloud");
  expectSmooth(recording);
  expectRevealed(recording.frames, true);
  expect(Object.keys(recording.frames.at(-1) ?? {}).sort()).toEqual([
    "After",
    "Cloud",
  ]);
  expect(app.getRendererErrors()).toEqual([]);
});

it("turns back mid-beat from where the rows are drawn", async () => {
  // Closing as it opens: each child is covered from where it is revealed.
  const closing = await record("Expand Cloud", {
    label: "Collapse Cloud",
    afterMs: BEAT_MS / 2,
  });
  expectTurn(closing, true);
  await record("Expand Cloud");
  // Opening as it closes: each child is revealed from where it is covered.
  const opening = await record("Collapse Cloud", {
    label: "Expand Cloud",
    afterMs: BEAT_MS / 2,
  });
  expectTurn(opening, false);
  for (const child of CHILDREN)
    expect(opening.frames.at(-1)?.[child]?.opacity).toBe(1);
  expect(app.getRendererErrors()).toEqual([]);
});

/** The press mid-slide changes who draws each child, never where or how. */
function expectTurn({ frames, turn, duplicates }: Recording, folding: boolean) {
  expect(duplicates).toEqual([]);
  const before = frames[turn] ?? {};
  const after = frames[turn + 1] ?? {};
  for (const child of CHILDREN) {
    const from = before[child];
    const to = after[child];
    // Mid-slide when pressed, and taken over in the same frame.
    expect(from?.opacity, child).toBeGreaterThan(0.05);
    expect(from?.opacity, child).toBeLessThan(0.95);
    expect(to?.folding, child).toBe(folding);
    expect(Math.abs((to?.top ?? 0) - (from?.top ?? 0)), child).toBeLessThan(2);
    expect(
      Math.abs((to?.visibleBottom ?? 0) - (from?.visibleBottom ?? 0)),
      child,
    ).toBeLessThan(2);
    expect(
      Math.abs((to?.opacity ?? 0) - (from?.opacity ?? 0)),
      child,
    ).toBeLessThan(0.05);
  }
}
