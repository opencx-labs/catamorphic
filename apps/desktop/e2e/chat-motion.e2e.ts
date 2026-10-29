import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  setReactValueJs,
} from "./harness.js";

/**
 * A running turn's live chrome holds still while its words change, frame
 * by frame in the real renderer (design log 2026-10-13):
 *
 * - the activity line is a spinner and its words, nothing beside them,
 *   and a new activity fades the old words away and the new ones in
 *   without moving the spinner or the line;
 * - the turn line keeps the first steps line's place from the turn's
 *   start, so the steps line arriving moves nothing either, also on a
 *   renderer slowed until its frames come late, or one that stalls as
 *   the turn opens and lets the first step land before the opening plays;
 * - a folded steps line changes its count on a beat, and "steps" (with
 *   the turn's clock after it) slides when the count gains a digit;
 * - the turn's clock and a long silence sit on that steps line;
 * - an open list's rows keep their places as wider steps join it;
 * - the activity line closes its height when the turn ends;
 * - text pressed and selected while an answer streams holds still under
 *   the pointer, and a key or a press on the scrollbar takes the view
 *   away from the latest words for good;
 * - a lurking chat shown again mid-turn has its activity line open, not
 *   opening;
 * - a person's message shows when it was sent on hover and moves nothing,
 *   and a send not held yet shows no time.
 *
 * Positions are sampled on every animation frame and compared within the
 * phase where nothing should move, so a slow host only means fewer
 * samples, never a different answer. One pass throttles the renderer's CPU
 * and one stalls it, so late frames are tested on every host, not only on
 * a busy one.
 */

let app: AppHandle;
const paceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-motion-pace-"));
const paceGate = path.join(paceRoot, "hold-answer");

beforeAll(async () => {
  app = await launchApp({ env: { CATAMORPHIC_E2E_PACE_GATE: paceGate } });
}, 180_000);

afterAll(async () => {
  await app?.stop();
  fs.rmSync(paceRoot, { recursive: true, force: true });
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent?.includes(text));
  const frontDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  const composer = () => frontDock()?.querySelector('[data-composer-input]');
  ${setReactValueJs}
  const pressKey = (key, mods = {}) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };
  const logScroller = () => frontDock()?.querySelector('[role="log"]')?.firstElementChild;
  const following = () => {
    const s = logScroller();
    return !!s && s.scrollHeight - s.clientHeight - s.scrollTop < 2 &&
      s.firstElementChild.hasAttribute('data-pinned');
  };
  const toLatest = () => {
    const dock = frontDock();
    dock.dispatchEvent(new KeyboardEvent('keydown', {key:'PageDown',bubbles:true,cancelable:true}));
    dock.dispatchEvent(new KeyboardEvent('keydown', {key:'PageDown',repeat:true,bubbles:true,cancelable:true}));
  };
  const hoverDock = () => frontDock().dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  // A real leave: the pointer moves somewhere outside the dock first.
  const unhoverDock = () => {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 4, clientY: 4 }));
    frontDock().dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body, clientX: 4, clientY: 4 }));
  };
  const clickOutside = () =>
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

type Box = [number, number, number, number] | null;
interface Frame {
  /** Captured before React handles the real CSS animation's completion. */
  beats: { kind: "activity" | "count"; opacity: number; text: string }[];
  t: number;
  /** The spinner's center: it turns, so its box breathes. */
  spinner: [number, number] | null;
  text: Box;
  textS: string | null;
  textO: number | null;
  /** What sits in the activity line besides the spinner. */
  rowParts: string[];
  /** A timer or a silence anywhere in the activity line. */
  rowExtras: number;
  toggle: Box;
  toggleS: string | null;
  count: Box;
  countO: number | null;
  word: Box;
  clock: Box;
  clockOnLine: boolean;
  stall: Box;
  stallOnLine: boolean;
  /** The first row of the live list's left and its chevron's. */
  firstRow: Box;
  /**
   * The first row's top below the steps line's, rounded once: rounded
   * apart, two tops moving together can read 0.1 px apart.
   */
  rowToLine: number | null;
  /** The line of the answer a test pressed on (`data-e2e-held`). */
  held: Box;
  firstChevron: Box;
  reveal: Box;
  /** The activity line's opening or closing is under way. */
  revealMoving: boolean;
  /** The turn line keeping the first steps line's place. */
  turnLine: Box;
  /** The row of the turn's opening note, and whether a row is opening. */
  note: Box;
  gapping: boolean;
  /** The log's scroll position and its content's height. */
  scroll: number | null;
  content: number | null;
  /** How far the log can scroll, and the person's message's top. */
  room: number | null;
  userTop: number | null;
  answer: boolean;
  settled: boolean;
}

/** Samples the front chat on every frame until stopped. */
const RECORDER = (captureClosing: boolean) => `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [round(r.x), round(r.y), round(r.width), round(r.height)];
  };
  const frames = [];
  const beats = [];
  const closing = {anchor:null,duration:null,samples:[],error:null,at:null,activity:null};
  let lastSteadyHeight = null;
  let closingObserver;
  if (${captureClosing}) {
    closingObserver = new MutationObserver((changes) => {
      const row = frontDock()?.querySelector('[data-testid="chat-activity"]');
      const reveal = row?.closest('.cat-reveal');
      const answer = [...(frontDock()?.querySelectorAll('[role="log"] article') ?? [])]
        .some(article => article.textContent.includes('Fixed: the lexer'));
      if (!answer) return;
      if (!reveal?.hasAttribute('data-closed') ||
          !changes.some(change => change.target === reveal)) return;
      closingObserver.disconnect();
      closing.anchor = lastSteadyHeight;
      closing.at = round(performance.now());
      closing.activity = row.textContent;
      const saved = [];
      try {
        const motions = reveal.getAnimations().filter(a => a instanceof CSSTransition);
        const height = motions.find(a => a.transitionProperty === 'grid-template-rows');
        const duration = height?.effect?.getComputedTiming().duration;
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)
          throw new Error('The activity line did not start a closing grid transition');
        if (height.playState !== 'running' || typeof height.currentTime !== 'number' ||
            !Number.isFinite(height.currentTime))
          throw new Error('The closing grid transition is not running');
        closing.duration = duration;
        for (const motion of motions) saved.push([motion,motion.currentTime]);
        // Seek and restore in one task. Pausing across awaits lets the
        // line's retention timer remove it before the probe can finish.
        // Stay short of the endpoint so no transition-end event is queued.
        for (const fraction of [0,0.1,0.2,0.3,0.5,0.7,0.9,0.9995]) {
          const time = duration * fraction;
          for (const motion of motions) motion.currentTime = time;
          closing.samples.push({time,height:round(reveal.getBoundingClientRect().height)});
        }
      } catch (error) {
        closing.error = String(error);
      } finally {
        for (const [motion,time] of saved) {
          try { motion.currentTime = time; }
          catch (error) { closing.error ??= String(error); }
        }
      }
    });
    closingObserver.observe(frontDock(), {
      attributes:true,subtree:true,attributeFilter:['data-closed'],
    });
  }
  const onBeat = (event) => {
    if (event.animationName !== 'catamorphic-swap-out') return;
    const node = event.target;
    const live = frontDock()?.querySelector('[data-live-work]');
    const activity = frontDock()?.querySelector('[data-testid="activity-text"]');
    const kind = node === activity ? 'activity' :
      live?.querySelector('[data-testid="chat-turn-steps-count"] .cat-swap-text') === node ? 'count' : null;
    if (kind) beats.push({kind, opacity: +getComputedStyle(node).opacity, text: node.textContent});
  };
  document.addEventListener('animationend', onBeat, true);
  let on = true;
  const sample = () => {
    const dock = frontDock();
    const log = dock?.querySelector('[role="log"]');
    const row = log?.querySelector('[data-testid="chat-activity"]');
    const spinner = row?.querySelector('svg')?.getBoundingClientRect();
    const text = row?.querySelector('[data-testid="activity-text"]');
    const live = log?.querySelector('[data-live-work]');
    const toggle = live?.querySelector('[data-testid="chat-turn-steps-toggle"]');
    const count = toggle?.querySelector('[data-testid="chat-turn-steps-count"]');
    const word = toggle?.querySelector('[data-testid="chat-turn-steps-word"]');
    const clock = log?.querySelector('[data-testid="chat-activity-elapsed"]');
    const stall = log?.querySelector('[data-testid="chat-activity-stalled"]');
    const first = live?.querySelector('[data-testid="chat-step"]');
    const firstButton = first?.querySelector('button');
    const articles = log ? [...log.querySelectorAll('article')] : [];
    const reveal = row?.closest('.cat-reveal');
    if (reveal && !reveal.matches('[data-moving], [data-entering], [data-closed]'))
      lastSteadyHeight = round(reveal.getBoundingClientRect().height);
    frames.push({
      t: round(performance.now()),
      beats: beats.splice(0),
      spinner: spinner ? [round(spinner.x + spinner.width / 2), round(spinner.y + spinner.height / 2)] : null,
      text: box(text), textS: text?.textContent ?? null,
      textO: text ? +getComputedStyle(text).opacity : null,
      rowParts: row ? [...row.children].map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase()) : [],
      rowExtras: row ? row.querySelectorAll('[role="timer"], [data-testid="chat-activity-stalled"]').length : 0,
      toggle: box(toggle), toggleS: toggle?.textContent ?? null,
      count: box(count),
      countO: count ? +getComputedStyle(count.querySelector('.cat-swap-text')).opacity : null,
      word: box(word),
      clock: box(clock), clockOnLine: !!clock?.closest('[data-testid="chat-turn-steps"]'),
      stall: box(stall), stallOnLine: !!stall?.closest('[data-testid="chat-turn-steps"]'),
      firstRow: box(firstButton),
      rowToLine: firstButton && toggle ? round(firstButton.getBoundingClientRect().y - toggle.getBoundingClientRect().y) : null,
      firstChevron: box(first?.querySelector('button > svg.lucide-chevron-right')),
      held: box(log?.querySelector('[data-e2e-held]')),
      reveal: box(row?.closest('.cat-reveal')),
      revealMoving: !!row?.closest('.cat-reveal')?.matches('[data-moving], [data-entering], [data-closed]'),
      turnLine: box(log?.querySelector('[data-testid="chat-turn-line"]')),
      note: box([...(log?.querySelectorAll('article[data-message-id]') ?? [])]
        .find((a) => a.textContent.includes('Reading the parser and its callers first.'))
        ?.closest('.cat-row')),
      gapping: !!log?.querySelector('.cat-gap-in'),
      scroll: log ? log.firstElementChild.scrollTop : null,
      content: log ? round(log.firstElementChild.firstElementChild.getBoundingClientRect().height) : null,
      room: log ? log.firstElementChild.scrollHeight - log.firstElementChild.clientHeight : null,
      userTop: log ? round([...log.querySelectorAll('[data-user-message]')].at(-1)?.getBoundingClientRect().top ?? 0) : null,
      answer: articles.some((a) => a.textContent.includes('Fixed: the lexer')),
      settled: !row,
    });
    if (on) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__chatMotion = {
    stop() { on = false; closingObserver?.disconnect(); document.removeEventListener('animationend', onBeat, true); return frames; },
    closing,
    // Frames sampled since a moment: a window waits for enough of them,
    // whatever stalls the renderer meanwhile.
    since(t) { return frames.filter((frame) => frame.t >= t).length; },
    workFrames() { return frames.filter(frame => /^([2-9]|[0-9]{2}) steps$/.test(frame.toggleS ?? '') && frame.spinner).length; },
  };
  return true;
})()`;

/** How long the renderer stalls in the frame that first shows the turn. */
const TURN_STALL_MS = 600;
/** How long it stalls again as the first steps line lands. */
const STEP_STALL_MS = 700;

/**
 * Long main-thread tasks where a busy runner had them (macOS CI stalled
 * for 600 ms there): one in the frame that first shows the turn, and one
 * in the frame that first shows its steps line, each after the frame's
 * styles are worked out and before its motion starts (a resize observer
 * runs between the two). What arrives meanwhile lands between two late
 * frames, and what the frame began to open starts only after the stall.
 * Each stall is listed with its start and end.
 */
const STALLS = `(() => {
  const dock = frontDock();
  const busy = (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  };
  const stalls = [];
  const kinds = new Map();
  const resized = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const kind = kinds.get(entry.target);
      if (!kind) continue;
      kinds.delete(entry.target);
      resized.unobserve(entry.target);
      const at = performance.now();
      busy(kind === 'turn' ? ${TURN_STALL_MS} : ${STEP_STALL_MS});
      stalls.push([kind, Math.round(at), Math.round(performance.now())]);
    }
  });
  let turn = false;
  let step = false;
  const mutated = new MutationObserver(() => {
    const log = dock.querySelector('[role="log"]');
    const reveal = log?.querySelector('[data-testid="chat-activity"]')?.closest('.cat-reveal');
    if (!turn && reveal) {
      turn = true;
      kinds.set(reveal, 'turn');
      resized.observe(reveal);
    }
    const line = log?.querySelector('[data-live-work] [data-testid="chat-turn-steps-toggle"]');
    if (!step && line) {
      step = true;
      kinds.set(line, 'step');
      resized.observe(line);
    }
    if (turn && step) mutated.disconnect();
  });
  mutated.observe(dock, { childList: true, subtree: true });
  window.__stalls = stalls;
  return true;
})()`;

async function setDisplay(live: "all" | "latest" | "notes") {
  await app.eval(
    `window.catamorphicDesktop.setPrefs({ chatWorkLive: ${JSON.stringify(live)}, chatWorkSettled: 'collapse' }).then(() => true)`,
  );
  await runWait(
    `return window.catamorphicDesktop.getPrefs().then((prefs) => prefs.chatWorkLive === ${JSON.stringify(live)});`,
    { label: "work display saved" },
  );
}

/** A new floating chat: the dock's + (Cmd+N would take a New Tab in front). */
async function newChat() {
  await runWait(
    `const plus = $('[data-dock-rail] button[aria-label="New chat"]'); plus?.click(); return !!plus;`,
    { label: "the dock's +" },
  );
  await runWait(
    `const dock = frontDock();
     return !!composer() && !dock.querySelector('[role="log"] article');`,
    { label: "an empty chat", timeoutMs: 20_000 },
  );
}

/** Sends a turn, samples every frame until it settles, returns the frames. */
async function recordTurn(
  name: string,
  prompt: string,
  during?: () => Promise<void>,
  options: {
    cpuSlowdown?: number;
    stalls?: boolean;
    minWorkFrames?: number;
    captureClosing?: boolean;
  } = {},
): Promise<Frame[]> {
  // A renderer this many times slower: frames come late, and what mounted
  // between two of them starts its motion only at the later one.
  if (options.cpuSlowdown)
    await app.cdp("Emulation.setCPUThrottlingRate", {
      rate: options.cpuSlowdown,
    });
  // A renderer that stalls (see STALLS) and starts motion late: on macOS CI
  // the turn's openings were still at their first frame when the stall
  // that followed it ended, and the first step had arrived meanwhile. Here
  // motion holds from the send until the steps line's stall has passed, so
  // the turn's work always lands before anything it opened has played.
  const holding = options.stalls
    ? async () => {
        await runWait("return window.__stalls.length === 2;", {
          label: "the renderer stalled as the turn and its steps line came",
          timeoutMs: 30_000,
        });
        await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
        await during?.();
      }
    : during;
  // What the new chat opened with has played first: the dock's own
  // entrance scales what is measured, and on a slow runner its last frames
  // reached the turn's (the line read 0.9 px off on macOS CI).
  await runWait(
    `return document.getAnimations().every((animation) =>
       animation.playState !== 'running' ||
       animation.effect?.getComputedTiming().iterations === Infinity);`,
    { label: "the chat at rest" },
  );
  if (options.stalls) {
    // Only the turn's motion is held.
    await app.cdp("Animation.enable");
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 0 });
  }
  try {
    if (options.minWorkFrames) fs.writeFileSync(paceGate, "hold");
    return await sampleTurn(
      name,
      options.minWorkFrames ? `${prompt} measured frames` : prompt,
      holding,
      options.stalls,
      options.minWorkFrames,
      options.captureClosing,
    );
  } finally {
    fs.rmSync(paceGate, { force: true });
    if (options.cpuSlowdown)
      await app.cdp("Emulation.setCPUThrottlingRate", { rate: 1 });
    if (options.stalls) {
      await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
      await app.cdp("Animation.disable");
    }
  }
}

async function sampleTurn(
  name: string,
  prompt: string,
  during?: () => Promise<void>,
  stalls = false,
  minWorkFrames?: number,
  captureClosing = false,
): Promise<Frame[]> {
  await run(RECORDER(captureClosing));
  if (stalls) await run(`return ${STALLS};`);
  await run(`
    const input = composer(); input.focus();
    setReactValue(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;`);
  await during?.();
  if (minWorkFrames) {
    await runWait(
      `return window.__chatMotion.workFrames() >= ${minWorkFrames};`,
      {
        label: "enough rendered work frames to measure geometry",
        timeoutMs: 60_000,
      },
    );
    fs.rmSync(paceGate, { force: true });
  }
  await runWait(
    `const log = frontDock()?.querySelector('[role="log"]');
     return !!log && [...log.querySelectorAll('article')].some((a) => a.textContent.includes('health check.')) &&
       !log.querySelector('[data-testid="chat-activity"]');`,
    { label: "turn settled", timeoutMs: 60_000 },
  );
  // A little past the end, for the closing motion.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const frames = await run<Frame[]>("return window.__chatMotion.stop();");
  // Kept with the run's diagnostics, to read when an assertion fails.
  const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
  if (artifacts) {
    fs.writeFileSync(
      path.join(artifacts, `chat-motion-${name}.json`),
      JSON.stringify(frames),
    );
    if (captureClosing)
      fs.writeFileSync(
        path.join(artifacts, `chat-motion-${name}-closing.json`),
        JSON.stringify(await run("return window.__chatMotion.closing;")),
      );
  }
  return frames;
}

/**
 * Frames where the log's scroll fell back further than its content shrank:
 * following the latest message, the scroll only gives way to a shorter
 * conversation, so anything else is the conversation jumping.
 */
const scrollJumps = (frames: Frame[]) =>
  frames.filter((frame, i) => {
    const before = frames[i - 1];
    if (!before || before.scroll == null || frame.scroll == null) return false;
    const fell = before.scroll - frame.scroll;
    const shrank = (before.content ?? 0) - (frame.content ?? 0);
    return fell > Math.max(shrank, 0) + 2;
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Marks a moment on the renderer's clock, to read the frames around it. */
const mark = (name: string) =>
  app.eval(
    `(window.__marks ??= {})[${JSON.stringify(name)}] = performance.now()`,
  );
const readMarks = () => app.eval<Record<string, number>>("window.__marks");

/** Waits for a long answer streaming in a chat taller than its view. */
const streamingLong = () =>
  runWait(
    `const s = logScroller();
     return !!s && s.textContent.includes('Part 2') &&
       s.scrollHeight > s.clientHeight + 120 && following();`,
    { label: "a long answer streaming, followed", timeoutMs: 30_000 },
  );

/** The activity line's parts, less a Cancel at its far end. */
const lineParts = (frame: Frame) =>
  frame.rowParts.filter((part) => part !== "chat-cancel-starting");

const spread = (values: number[]) =>
  values.length ? Math.max(...values) - Math.min(...values) : 0;

/**
 * The frames from the moment the turn's line stands still to the answer:
 * the activity line open and at rest, the turn's opening note written and
 * done opening (its row at its full height, the gap above it open). Only
 * steps arrive from here on, the first one taking the turn line's place,
 * so nothing in the live chrome may move.
 */
function steadyPhase(frames: Frame[]): Frame[] {
  const end = frames.findIndex((frame) => frame.answer);
  const noteHeight = Math.max(
    ...frames.slice(0, end).map((frame) => frame.note?.[3] ?? 0),
  );
  const start = frames.findIndex(
    (frame) =>
      frame.spinner &&
      !frame.revealMoving &&
      !frame.gapping &&
      (frame.note?.[3] ?? 0) >= noteHeight - 0.1,
  );
  expect(start, "the activity line stood open").toBeGreaterThanOrEqual(0);
  expect(end, "the answer arrived").toBeGreaterThan(start);
  return frames.slice(start, end).filter((frame) => frame.spinner);
}

/** The live chrome holds still through the steady phase (see above). */
function expectStill(frames: Frame[]) {
  const steady = steadyPhase(frames);
  expect(steady.length).toBeGreaterThan(20);
  const lined = steady.filter((frame) => frame.toggle);
  expect(lined.length, "the steps line showed").toBeGreaterThan(10);
  expect(
    spread(steady.map((f) => f.spinner?.[0] ?? 0)),
    "spinner x",
  ).toBeLessThanOrEqual(0.5);
  expect(
    spread(steady.map((f) => f.spinner?.[1] ?? 0)),
    "spinner y",
  ).toBeLessThanOrEqual(0.5);
  expect(spread(steady.map((f) => f.text?.[0] ?? 0)), "words x").toBe(0);
  expect(spread(steady.map((f) => f.text?.[3] ?? 0)), "words height").toBe(0);
  expect(spread(lined.map((f) => f.toggle?.[0] ?? 0)), "line x").toBe(0);
  expect(spread(lined.map((f) => f.toggle?.[1] ?? 0)), "line y").toBe(0);
  return steady;
}

/**
 * The turn line kept the first steps line's place, and that line took it
 * in one frame and kept it: in the last frame before the first steps
 * line, the turn line sat above the activity line, as far above the
 * spinner as the steps line then sits from its first frame to the answer
 * (folded, nothing comes between them). Measured from the spinner, so it
 * holds wherever the first step lands, also on a renderer that stalls
 * through the beat before it, while something above is still opening:
 * the steady phase (see expectStill) then starts only after it.
 */
function expectHandOver(frames: Frame[]) {
  const first = frames.findIndex((frame) => frame.spinner && frame.toggle);
  const end = frames.findIndex((frame) => frame.answer);
  expect(first, "a steps line came").toBeGreaterThanOrEqual(0);
  expect(end, "the answer arrived").toBeGreaterThan(first);
  const kept = frames
    .slice(0, first)
    .filter((frame) => frame.spinner)
    .at(-1);
  const above = (frame: Frame, box: Box) =>
    (frame.spinner?.[1] ?? 0) - (box?.[1] ?? 0);
  const lined = frames
    .slice(first, end)
    .filter((frame) => frame.spinner && frame.toggle);
  expect(lined.length).toBeGreaterThan(10);
  // A renderer that drew no frame of the activity line before the first
  // step (a macOS runner's first frames can come that late) leaves no turn
  // line to measure: the steps line then holds wherever it first showed.
  if (kept)
    expect(kept.turnLine, "the turn line kept the place first").toBeTruthy();
  const landed = lined[0];
  const place = kept?.turnLine
    ? above(kept, kept.turnLine)
    : landed
      ? above(landed, landed.toggle)
      : 0;
  expect(
    lined
      .filter((frame) => Math.abs(above(frame, frame.toggle) - place) > 0.5)
      .map((frame) => [frame.t, above(frame, frame.toggle), place]),
    "the steps line in the turn line's place",
  ).toEqual([]);
}

/** The frames while steps arrive: from a second step to the answer. */
function workPhase(frames: Frame[]): Frame[] {
  const start = frames.findIndex((frame) =>
    /^([2-9]|\d\d) steps$/.test(frame.toggleS ?? ""),
  );
  const end = frames.findIndex((frame) => frame.answer);
  expect(start, "a second step arrived").toBeGreaterThanOrEqual(0);
  expect(end, "the answer arrived").toBeGreaterThan(start);
  return frames.slice(start, end);
}

describe("chat motion", () => {
  it("opens a project and a chat", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 120_000,
      label: "onboarding",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
    await runWait(
      `const input = $('[data-testid="project-name-input"]');
       if (!input) return false; setReactValue(input, 'chat-motion'); return true;`,
      { label: "project name input" },
    );
    await runWait(
      `const create = $('[data-testid="project-submit"]');
       if (!create || create.disabled) return false; create.click(); return true;`,
      { label: "create project" },
    );
    await runWait(`return !!byText('button, [role="tab"]', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
  });

  it("holds the activity line and a folded steps line still while their words change", async () => {
    await setDisplay("notes");
    await newChat();
    const frames = await recordTurn(
      "notes",
      "pace the work quickly",
      async () => {
        // A long silence, as the person would see it: the renderer's clock
        // runs half a minute ahead while the steps keep coming.
        await runWait(
          `return /^[4-9] steps$/.test(frontDock()?.querySelector('[data-live-work] [data-testid="chat-turn-steps-toggle"]')?.textContent ?? '');`,
          { label: "four steps", timeoutMs: 30_000 },
        );
        await app.eval(`(() => {
        const real = Date.now.bind(Date);
        window.__realNow = real;
        Date.now = () => real() + 31_000;
        return true;
      })()`);
        await runWait(
          `return !!frontDock()?.querySelector('[data-testid="chat-activity-stalled"]');`,
          { label: "the silence shows", timeoutMs: 5_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        await app.eval(
          `(() => { Date.now = window.__realNow; return true; })()`,
        );
      },
      { captureClosing: true },
    );
    const work = workPhase(frames);
    const live = work.filter((frame) => frame.spinner && frame.toggle);
    expect(live.length).toBeGreaterThan(20);

    // Nothing beside the activity line's words, ever (withdrawing a
    // message about to start waits at the line's far end).
    for (const frame of frames.filter((f) => f.rowParts.length > 0)) {
      expect(lineParts(frame)).toEqual(["svg", "activity-text"]);
      expect(frame.rowExtras).toBe(0);
    }

    // The spinner, the words' box and the steps line hold still once the
    // turn's line is open and at rest, and the steps line arrived where
    // the turn line kept its place.
    expectStill(frames);
    expectHandOver(frames);

    // Observe the real animation's end before React swaps the words. The
    // last RAF before it can be arbitrarily far from that end on a busy
    // renderer, so its sampled opacity cannot stand in for the endpoint.
    const ended = frames.flatMap((frame) => frame.beats);
    for (const kind of ["activity", "count"] as const) {
      const faded = ended.filter((beat) => beat.kind === kind);
      expect(faded.length, `${kind} fades completed`).toBeGreaterThanOrEqual(5);
      for (const beat of faded)
        expect(beat.opacity, `faded before replacing "${beat.text}"`).toBe(0);
    }

    // "steps" slides right as the count reaches ten (counts that arrive
    // mid-beat collapse into the latest, so it may skip a number): it
    // passes through places between where it was and where it lands.
    const nine = live.find((frame) => frame.toggleS === "9 steps");
    const last = live.at(-1);
    const from = nine?.word?.[0] ?? 0;
    const to = last?.word?.[0] ?? 0;
    expect(last?.toggleS).toMatch(/^1\d steps$/);
    expect(to - from, "the word moved right").toBeGreaterThan(2);
    expect(
      live.filter((frame) => {
        const x = frame.word?.[0] ?? 0;
        return x > from + 0.5 && x < to - 0.5;
      }).length,
      "frames between its two places",
    ).toBeGreaterThan(0);

    // The clock and the silence sit on the steps line, after the word.
    const clocked = live.filter((frame) => frame.clock);
    expect(clocked.length).toBeGreaterThan(10);
    for (const frame of clocked) {
      expect(frame.clockOnLine).toBe(true);
      expect(frame.clock?.[0] ?? 0).toBeGreaterThan(
        (frame.word?.[0] ?? 0) + (frame.word?.[2] ?? 0),
      );
    }
    const silent = frames.filter((frame) => frame.stall);
    expect(silent.length, "the silence showed").toBeGreaterThan(0);
    for (const frame of silent) expect(frame.stallOnLine).toBe(true);

    expect(scrollJumps(frames).map((frame) => frame.t)).toEqual([]);
    // Probe the real close at explicit times, separately from natural RAF
    // recording: a busy renderer can miss the entire 200 ms interval.
    const closing = await run<{
      anchor: number | null;
      duration: number | null;
      error: string | null;
      samples: { time: number; height: number }[];
    }>("return window.__chatMotion.closing;");
    const detail = JSON.stringify(closing);
    expect(closing.error, detail).toBeNull();
    expect(closing.duration ?? 0, detail).toBeGreaterThan(0);
    expect(closing.anchor ?? 0, detail).toBeGreaterThan(1);
    expect(closing.samples.length, detail).toBeGreaterThan(2);
    const full = closing.anchor ?? 0;
    expect(
      Math.abs((closing.samples[0]?.height ?? -1) - full),
      detail,
    ).toBeLessThanOrEqual(0.5);
    expect(
      closing.samples.filter(({ height }) => height > 1 && height < full - 1)
        .length,
      `frames between open and closed: ${detail}`,
    ).toBeGreaterThan(0);
    expect(closing.samples.at(-1)?.height ?? full, detail).toBeLessThan(1);
    expect(
      closing.samples.filter(
        ({ height }) => height < -0.5 || height > full + 0.5,
      ),
      detail,
    ).toEqual([]);
    expect(
      await run<number>(
        `return frontDock().querySelectorAll('[role="log"] [role="timer"]').length;`,
      ),
    ).toBe(0);
  }, 120_000);

  it("holds the live chrome still on a slow renderer, whose frames come late", async () => {
    await setDisplay("notes");
    await newChat();
    // The fake holds its answer until enough work frames have actually
    // rendered, so a busy runner still supplies a meaningful sample.
    const frames = await recordTurn("notes-slow", "pace the work", undefined, {
      cpuSlowdown: 6,
      minWorkFrames: 32,
    });
    for (const frame of frames.filter((f) => f.rowParts.length > 0))
      expect(lineParts(frame)).toEqual(["svg", "activity-text"]);
    expectStill(frames);
    expectHandOver(frames);
    expect(scrollJumps(frames).map((frame) => frame.t)).toEqual([]);
    // An open list's first row stays under its line as the list opens.
    await setDisplay("all");
    await newChat();
    expectRowsInPlace(
      await recordTurn("all-slow", "pace the work quickly", undefined, {
        cpuSlowdown: 6,
        minWorkFrames: 32,
      }),
    );
  }, 120_000);

  it("holds the turn's start still when the renderer stalls as it opens", async () => {
    for (const live of ["notes", "all"] as const) {
      await setDisplay(live);
      await newChat();
      const frames = await recordTurn(
        `${live}-stalled`,
        "pace the work quickly",
        undefined,
        { stalls: true },
      );
      expect(
        (await run<[string, number, number][]>("return window.__stalls;")).map(
          ([kind]) => kind,
        ),
        "where the renderer stalled",
      ).toEqual(["turn", "step"]);
      // The first step landed while the activity line's opening was held:
      // in the frame before the steps line, the line had yet to open. Read
      // from its height, not its moving mark: the line stops waiting on an
      // opening 2 s past its length (afterMotion), and the hold here lasts
      // until the agent's first step, which macOS CI took 2.4 s to send.
      const first = frames.findIndex((frame) => frame.spinner && frame.toggle);
      const kept = frames
        .slice(0, first)
        .filter((frame) => frame.spinner)
        .at(-1);
      expect(kept?.reveal?.[3], "the activity line yet to open").toBeLessThan(
        1,
      );
      expect(scrollJumps(frames).map((frame) => frame.t)).toEqual([]);
      if (live === "notes") {
        expectStill(frames);
        expectHandOver(frames);
      } else expectRowsInPlace(frames);
    }
  }, 120_000);

  it("keeps an open list's rows in place as wider steps join it", async () => {
    await setDisplay("all");
    await newChat();
    const frames = await recordTurn("all", "pace the work quickly");
    expectRowsInPlace(frames);
    // Nothing beside the activity words here either.
    for (const frame of frames.filter((f) => f.rowParts.length > 0))
      expect(lineParts(frame)).toEqual(["svg", "activity-text"]);
  }, 120_000);

  function expectRowsInPlace(frames: Frame[]) {
    const work = workPhase(frames).filter(
      (frame) => frame.firstRow && frame.firstChevron,
    );
    expect(work.length).toBeGreaterThan(20);
    // The first step's row and its chevron keep their places (relative to
    // the line above them, which the list scrolls with).
    const left = work.map((frame) => frame.firstRow?.[0] ?? 0);
    const chevron = work.map(
      (frame) => (frame.firstChevron?.[0] ?? 0) - (frame.toggle?.[0] ?? 0),
    );
    expect(spread(left), "first row x").toBe(0);
    expect(spread(chevron), "first row's chevron x").toBe(0);
    // The line was there from the first step: the row never moved under it.
    const rowToLine = work.map((frame) => frame.rowToLine ?? 0);
    expect(spread(rowToLine), "first row under its line").toBe(0);
    // Settling (notes folding into the answer) never pulls the scroll back.
    expect(scrollJumps(frames).map((frame) => frame.t)).toEqual([]);
  }

  it("holds the latest words still as an answer streams, and lets a reader scroll away", async () => {
    await setDisplay("all");
    await newChat();
    const frames = await recordTurn(
      "streaming",
      "pace the work quickly at length",
      async () => {
        // Well into the answer, with the chat taller than its view.
        await runWait(
          `const log = frontDock()?.querySelector('[role="log"]');
           const scroller = log?.firstElementChild;
           return !!log && log.textContent.includes('Part 3') &&
             scroller.scrollHeight > scroller.clientHeight + 40;`,
          { label: "a long answer streaming", timeoutMs: 30_000 },
        );
        await mark("pinned");
        await runWait(
          `return performance.now()-window.__marks.pinned>=1200 &&
            window.__chatMotion.since(window.__marks.pinned)>20;`,
          {
            label:
              "enough rendered frames while following the streaming answer",
          },
        );
        await mark("followed");
        // A person's wheel, which is what lets go of the latest message,
        // over a code block while the answer opens a new line: the block
        // scrolls sideways, so the scroll library does not take the wheel
        // for the log's, and it reads the scroll the wheel makes as the
        // answer's growth, which used to pull the view back down.
        for (let attempt = 1; ; attempt++) {
          const wheel = await runWait<{ x: number; y: number; deltaY: number }>(
            `const s = logScroller();
             // Looked for on every frame: a line opens for 180 ms.
             return new Promise((resolve) => {
               const started = performance.now();
               const look = () => {
                 const view = s.getBoundingClientRect();
                 // The latest line's last few pixels opening: the answer
                 // grows on for a few frames, and rises only that much
                 // before the wheel arrives.
                 const grow = [...s.querySelectorAll('.cat-grow[data-growing]')].at(-1);
                 const left = grow ? grow.firstElementChild.getBoundingClientRect().height -
                   grow.getBoundingClientRect().height : 0;
                 const blocks = [...s.querySelectorAll('.cat-markdown pre')].filter((el) => {
                   const r = el.getBoundingClientRect();
                   return r.top > view.top + 20 && r.bottom < view.bottom - 20 &&
                     el.contains(document.elementFromPoint(r.left + 24, r.top + 4)) &&
                     el.contains(document.elementFromPoint(r.left + 24, r.top + 16));
                 });
                 const [upper, lower] = blocks.slice(-2);
                 if (left > 1 && left < 10 && upper && lower) {
                   // Aimed at the lower block's top, the wheel scrolling
                   // by the blocks' distance: what it lands on is read
                   // before or after the scroll it makes, a block either way.
                   window.__wheeled = undefined;
                   window.addEventListener('wheel', (event) => {
                     window.__wheeled = event.target instanceof Element && !!event.target.closest('.cat-markdown pre');
                   }, { capture: true, once: true });
                   const a = upper.getBoundingClientRect();
                   const b = lower.getBoundingClientRect();
                   resolve({ x: Math.round(b.left + 24), y: Math.round(b.top + 4), deltaY: -Math.round(b.top - a.top) });
                 } else if (performance.now() - started > 2000) resolve(false);
                 else requestAnimationFrame(look);
               };
               look();
             });`,
            { label: "code blocks in view as the answer grows" },
          );
          await app.cdp("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: wheel.x,
            y: wheel.y,
            deltaX: 0,
            deltaY: wheel.deltaY,
          });
          const { onCode } = await runWait<{ onCode: boolean }>(
            "return window.__wheeled !== undefined && { onCode: window.__wheeled };",
            { label: "the wheel reached the page" },
          );
          if (onCode || attempt === 3) {
            expect(onCode, "the wheel went over a code block").toBe(true);
            break;
          }
          // The answer moved it off the block: from the latest, again.
          await run(`toLatest(); return true;`);
          await runWait(`return following();`, {
            label: "following again",
            timeoutMs: 10_000,
          });
        }
        await mark("scrolled");
        await runWait(
          `return performance.now()-window.__marks.scrolled>=1200 &&
            window.__chatMotion.since(window.__marks.scrolled+400)>20;`,
          { label: "enough rendered frames while reading above the stream" },
        );
        await mark("back");
        await run(`toLatest(); return true;`);
      },
    );
    const marks = await readMarks();
    const between = (from: number, to: number) =>
      frames.filter((frame) => frame.t >= from && frame.t < to);
    // Following: the activity line holds still while the words grow above it.
    const pinned = between(marks.pinned ?? 0, marks.followed ?? 0).filter(
      (frame) => frame.spinner,
    );
    expect(pinned.length).toBeGreaterThan(20);
    expect(
      spread(pinned.map((frame) => frame.spinner?.[1] ?? 0)),
      "activity line while following",
    ).toBeLessThanOrEqual(1);
    expect(
      spread(pinned.map((frame) => frame.content ?? 0)),
      "the answer grew meanwhile",
    ).toBeGreaterThan(20);
    // Scrolled away: what the reader sees stays put as the answer grows.
    const reading = between((marks.scrolled ?? 0) + 400, marks.back ?? 0);
    expect(reading.length).toBeGreaterThan(20);
    expect(spread(reading.map((frame) => frame.scroll ?? 0))).toBe(0);
    expect(spread(reading.map((frame) => frame.userTop ?? 0))).toBe(0);
    // Back at the latest, it follows to the end.
    const last = frames.at(-1);
    expect((last?.room ?? 0) - (last?.scroll ?? 0)).toBeLessThan(2);
  }, 120_000);

  it("holds text still under the pointer while a person selects it as an answer streams", async () => {
    await setDisplay("all");
    await newChat();
    const frames = await recordTurn(
      "selecting",
      "pace the work quickly at length",
      async () => {
        let at = { x: 0, y: 0 };
        let lastX = 0;
        let pressed = false;
        let failed = false;
        let cleanup: PromiseSettledResult<unknown>[] = [];
        const mouse = (type: string, x: number, buttons: number) =>
          app.cdp("Input.dispatchMouseEvent", {
            type,
            x,
            y: at.y,
            button: "left",
            buttons,
            clickCount: 1,
          });
        try {
          await focusWindow(app);
          await streamingLong();
          await run(`
            window.__selectionPresses=[];
            window.__selectionSamples=[];
            window.__selectionSnapshot=(phase)=>{
              const selection=document.getSelection();
              const line=logScroller()?.querySelector('[data-e2e-held]');
              const node=window.__heldTextNode;
              const entry={phase,t:performance.now(),focused:document.hasFocus(),
                selected:selection?.toString()??'',
                anchorHeld:selection?.anchorNode===node,
                focusHeld:selection?.focusNode===node,
                nodeConnected:node?.isConnected??false,
                lineConnected:line?.isConnected??false,
                scroll:logScroller()?.scrollTop};
              window.__selectionSamples.push(entry);
              return entry;
            };
            const changed=()=>window.__selectionSnapshot('selectionchange');
            document.addEventListener('selectionchange',changed);
            window.__stopSelectionTrace=()=>document.removeEventListener('selectionchange',changed);
            return true;`);
          // A paragraph's midpoint can lie between wrapped visual lines.
          // Use a text Range, as in markdown.e2e.ts, and verify the same
          // rendered text at the real press. A missed press can try again;
          // an empty measured drag still fails without retrying.
          for (let attempt = 1; ; attempt++) {
            at = await runWait<{ x: number; y: number }>(
              `const s=logScroller(),view=s.getBoundingClientRect();
               let chosen;
               for(const line of s.querySelectorAll('.cat-markdown:not([data-testid]) :is(p,li)')) {
                 const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
                 for(let node=walker.nextNode();node;node=walker.nextNode()) {
                   if(node.parentElement.closest('pre,code,a,button'))continue;
                   const start=node.textContent.search(/\\S/);if(start<0)continue;
                   const range=document.createRange();range.setStart(node,start);
                   range.setEnd(node,node.textContent.length);
                   const visual=range.getClientRects()[0];
                   if(!visual||visual.width<120||visual.top<=view.top+view.height*.25
                     ||visual.bottom>=view.top+view.height*.6)continue;
                   range.setEnd(node,start+1);
                   const glyph=range.getClientRects()[0];if(!glyph?.width)continue;
                   const point={x:Math.round(glyph.left+glyph.width/2),y:Math.round(glyph.top+glyph.height/2)};
                   const hit=document.elementFromPoint(point.x,point.y)?.closest('.cat-markdown :is(p,li)');
                   if(hit!==line||point.x+100>=visual.right-1)continue;
                   chosen={line,node,point};break;
                 }
                 if(chosen)break;
               }
               if(!chosen)return false;
               s.querySelector('[data-e2e-held]')?.removeAttribute('data-e2e-held');
               chosen.line.setAttribute('data-e2e-held','');
               window.__heldTextNode=chosen.node;
               window.__pressedText=undefined;
               window.__stopSelectionPress?.();
               const check=event=>{
                 const pressedAt=performance.now();
                 const line=s.querySelector('[data-e2e-held]'),node=window.__heldTextNode;
                 const hit=event.target instanceof Element?event.target.closest('.cat-markdown :is(p,li)'):null;
                 const caret=document.caretPositionFromPoint(event.clientX,event.clientY);
                 const range=document.createRange();range.selectNodeContents(node);
                 const onText=[...range.getClientRects()].some(r=>
                   event.clientX>=r.left&&event.clientX+100<r.right-1
                   &&event.clientY>r.top&&event.clientY<r.bottom);
                 const valid=hit===line&&node.isConnected&&line?.contains(node)
                   &&caret?.offsetNode===node&&onText;
                 window.__pressedText=!!valid;
                 if(valid)(window.__marks??={}).pressed=pressedAt;
                 window.__selectionPresses.push({t:pressedAt,x:event.clientX,y:event.clientY,
                   valid:!!valid,hitHeld:hit===line,caretHeld:caret?.offsetNode===node,
                   caretOffset:caret?.offset,onText,focused:document.hasFocus(),
                   nodeConnected:node.isConnected});
               };
               document.addEventListener('pointerdown',check,{capture:true,once:true});
               window.__stopSelectionPress=()=>document.removeEventListener('pointerdown',check,true);
               return chosen.point;`,
              { label: "rendered text with room for the full selection drag" },
            );
            lastX = at.x;
            pressed = true;
            await mouse("mousePressed", at.x, 1);
            await run("window.__selectionSnapshot('after-press');return true;");
            if (await run<boolean>("return window.__pressedText === true;"))
              break;
            await mouse("mouseReleased", at.x, 0);
            pressed = false;
            expect(attempt, "presses that missed every text line").toBeLessThan(
              6,
            );
            await run(`toLatest(); return true;`);
            await runWait(`return following();`, {
              label: "following again",
              timeoutMs: 10_000,
            });
          }
          for (const dx of [20, 40, 60, 80, 100]) {
            lastX = at.x + dx;
            await mouse("mouseMoved", lastX, 1);
            await sleep(80);
          }
          await sleep(1200);
          await run(
            "window.__selectionSnapshot('before-release');return true;",
          );
          await mouse("mouseReleased", lastX, 0);
          pressed = false;
          await run("window.__selectionSnapshot('after-release');return true;");
          expect(
            await run<string>(
              `return document.getSelection()?.toString() ?? '';`,
            ),
            "text was selected",
          ).not.toBe("");
          await sleep(800);
          await mark("after");
          expect(await run<boolean>(`return !following();`)).toBe(true);
          await run(
            `document.getSelection()?.removeAllRanges(); toLatest(); return true;`,
          );
        } catch (cause) {
          failed = true;
          throw cause;
        } finally {
          cleanup = await Promise.allSettled(
            pressed ? [mouse("mouseReleased", lastX, 0)] : [],
          );
          const captured = await Promise.allSettled([
            run(`return {presses:window.__selectionPresses,samples:window.__selectionSamples,
              marks:window.__marks,point:${JSON.stringify(at)},
              final:window.__selectionSnapshot?.('cleanup')};`),
            ...(failed
              ? [run<Frame[]>("return window.__chatMotion.stop();")]
              : []),
          ]);
          cleanup.push(
            ...captured,
            ...(await Promise.allSettled([
              run(`window.__stopSelectionPress?.();window.__stopSelectionTrace?.();
              delete window.__stopSelectionPress;delete window.__stopSelectionTrace;
              delete window.__selectionSnapshot;return true;`),
            ])),
          );
          const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
          if (artifacts) {
            const input = captured[0];
            if (input?.status === "fulfilled")
              cleanup.push(
                ...(await Promise.allSettled([
                  fs.promises.writeFile(
                    path.join(artifacts, "chat-motion-selecting-input.json"),
                    JSON.stringify(input.value),
                  ),
                ])),
              );
            const frames = captured[1];
            if (frames?.status === "fulfilled")
              cleanup.push(
                ...(await Promise.allSettled([
                  fs.promises.writeFile(
                    path.join(artifacts, "chat-motion-selecting.json"),
                    JSON.stringify(frames.value),
                  ),
                ])),
              );
          }
        }
        // Only reached after success; cleanup cannot replace a test failure.
        for (const result of cleanup)
          if (result.status === "rejected") throw result.reason;
      },
    );
    const marks = await readMarks();
    const held = frames.filter(
      (frame) =>
        frame.held &&
        frame.t >= (marks.pressed ?? 0) &&
        frame.t < (marks.after ?? 0),
    );
    expect(held.length).toBeGreaterThan(20);
    expect(
      spread(held.map((frame) => frame.held?.[1] ?? 0)),
      "the pressed line, pressed, selected and let go",
    ).toBeLessThanOrEqual(0.5);
    expect(
      spread(held.map((frame) => frame.content ?? 0)),
      "the answer grew meanwhile",
    ).toBeGreaterThan(20);
  }, 120_000);

  it("lets a key or a press on the scrollbar take the view from the latest words as an answer streams", async () => {
    await setDisplay("all");
    await newChat();
    let onBar = false;
    // At least 1.2 s after a press, and enough frames past the browser's
    // own smooth scroll for it to judge: a renderer that stalls (CI stalled
    // for 1.4 s once) holds the window open until it has them.
    const sampled = (name: string) =>
      runWait(
        `const at = window.__marks.${name};
         return performance.now() - at >= 1200 && window.__chatMotion.since(at + 400) > 20;`,
        { label: `frames after the ${name} press`, timeoutMs: 15_000 },
      );
    const frames = await recordTurn(
      "escapes",
      "pace the work quickly at length",
      async () => {
        await streamingLong();
        // A press on the scrollbar's track, above its thumb.
        const bar = await run<{ x: number; y: number } | null>(
          `const s = logScroller();
           const r = s.getBoundingClientRect();
           const x = Math.round(r.right - 3);
           const y = Math.round(r.top + r.height * 0.2);
           return document.elementFromPoint(x, y) === s ? { x, y } : null;`,
        );
        // Overlay scrollbars (macOS) show only while scrolling.
        if (process.platform === "linux") expect(bar).not.toBeNull();
        if (bar) {
          onBar = true;
          for (const type of ["mousePressed", "mouseReleased"])
            await app.cdp("Input.dispatchMouseEvent", {
              type,
              ...bar,
              button: "left",
              buttons: type === "mousePressed" ? 1 : 0,
              clickCount: 1,
            });
          await mark("bar");
          await sampled("bar");
          await mark("barred");
          // Back to the latest.
          await run(`toLatest(); return true;`);
          await runWait(`return following();`, {
            label: "following again",
            timeoutMs: 10_000,
          });
        }
        // An ordinary scroll key, with focus on a conversation control.
        expect(
          await run<string | undefined>(
            `logScroller().querySelector('[data-testid="chat-turn-steps-toggle"]')?.focus({ preventScroll: true });
             return document.activeElement?.dataset.testid;`,
          ),
        ).toBe("chat-turn-steps-toggle");
        const pageUp = {
          key: "ArrowUp",
          code: "ArrowUp",
          windowsVirtualKeyCode: 38,
        };
        for (let i = 0; i < 6; i++) {
          await app.cdp("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            ...pageUp,
          });
          await app.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...pageUp });
        }
        await mark("key");
        await sampled("key");
        await mark("keyed");
        await run(`toLatest(); return true;`);
      },
    );
    const marks = await readMarks();
    const away = (from: number, to: number) => {
      // Past the browser's own smooth scroll for the key or the track.
      const still = frames.filter(
        (frame) => frame.t >= from + 400 && frame.t < to,
      );
      expect(still.length).toBeGreaterThan(20);
      expect(
        spread(still.map((frame) => frame.scroll ?? 0)),
        "the view stays where the person took it",
      ).toBe(0);
      expect(
        Math.min(
          ...still.map((frame) => (frame.room ?? 0) - (frame.scroll ?? 0)),
        ),
        "away from the latest words",
      ).toBeGreaterThan(100);
      expect(
        spread(still.map((frame) => frame.content ?? 0)),
        "the answer grew meanwhile",
      ).toBeGreaterThan(20);
    };
    if (onBar) away(marks.bar ?? 0, marks.barred ?? 0);
    away(marks.key ?? 0, marks.keyed ?? 0);
  }, 120_000);

  it("shows a lurking chat's activity line open, not opening, when it comes back mid-turn", async () => {
    await setDisplay("all");
    await newChat();
    const frames = await recordTurn("lurking", "pace the work", async () => {
      await runWait(
        `return /^[2-9] steps$/.test(logScroller()?.querySelector('[data-live-work] [data-testid="chat-turn-steps-toggle"]')?.textContent ?? '');`,
        { label: "two steps", timeoutMs: 30_000 },
      );
      await mark("lurk");
      await run(`unhoverDock(); clickOutside(); return true;`);
      await runWait(`return frontDock().hasAttribute('data-lurking');`, {
        label: "lurking",
        timeoutMs: 10_000,
      });
      // Steps arrive while it lurks.
      await sleep(1600);
      await mark("back");
      await run(`hoverDock(); return true;`);
      await runWait(`return !frontDock().hasAttribute('data-lurking');`, {
        label: "back from lurking",
      });
    });
    const marks = await readMarks();
    // Its height as it lurked (its steps line had taken the turn line's
    // place by then).
    const open = frames
      .filter((frame) => frame.t < (marks.lurk ?? 0) && frame.reveal)
      .map((frame) => frame.reveal?.[3] ?? 0);
    const full = open.at(-1) ?? 0;
    expect(full).toBeGreaterThan(10);
    const back = frames.filter(
      (frame) =>
        frame.t >= (marks.back ?? 0) &&
        !frame.answer &&
        (frame.reveal?.[3] ?? 0) > 0,
    );
    expect(back.length).toBeGreaterThan(20);
    expect(
      back
        .map((frame) => frame.reveal?.[3])
        .filter((height) => height !== full),
      "the activity line's height from its first frame back",
    ).toEqual([]);
  }, 120_000);

  it("shows when the person sent a message on hover, moving nothing", async () => {
    await newChat();
    // Every look at the message before the session holds it.
    await run(`
      const seen = [];
      const look = () => {
        for (const message of frontDock().querySelectorAll('[data-pending-message]'))
          seen.push(!!message.querySelector('[data-testid="chat-sent-time"]'));
      };
      const observer = new MutationObserver(look);
      observer.observe(frontDock(), {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['data-pending-message'],
      });
      window.__pendingTimes = () => { observer.disconnect(); return seen; };
      return true;`);
    const before = await app.eval<number>("Date.now()");
    await run(`
      const input = composer(); input.focus();
      setReactValue(input, 'note when I sent this');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;`);
    await runWait(
      `const log = frontDock()?.querySelector('[role="log"]');
       return !!log && log.textContent.includes('You said: note when I sent this') &&
         !log.querySelector('[data-testid="chat-activity"]');`,
      { label: "the reply settled", timeoutMs: 30_000 },
    );
    const after = await app.eval<number>("Date.now()");
    const pending = await run<boolean[]>("return window.__pendingTimes();");
    expect(
      pending.length,
      "the message showed before it was held",
    ).toBeGreaterThan(0);
    expect(pending, "a send not held yet has no time").not.toContain(true);
    interface Look {
      dateTime: string;
      text: string;
      message: [number, number, number, number];
      time: [number, number, number, number];
    }
    /** The person's latest message and its time, once it shows `opacity`. */
    const lookWhen = (opacity: string, label: string) =>
      runWait<Look>(
        `const message = [...frontDock().querySelectorAll('[data-user-message]')].at(-1);
         const time = message?.querySelector('[data-testid="chat-sent-time"]');
         if (!time || getComputedStyle(time).opacity !== ${JSON.stringify(opacity)}) return false;
         const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
         // Its words, without the room around them.
         const words = document.createRange();
         words.selectNodeContents(time);
         return { dateTime: time.dateTime, text: time.textContent, message: box(message), time: box(words) };`,
        { label },
      );
    const point = async (selector: string) =>
      run<{ x: number; y: number }>(
        `const r = ${selector}.getBoundingClientRect();
         return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2) };`,
      );
    const latest =
      "[...frontDock().querySelectorAll('[data-user-message]')].at(-1)";
    // At rest: the pointer on the composer.
    await app.movePointer(await point("composer()"));
    const rest = await lookWhen("0", "the time hidden at rest");
    expect(Date.parse(rest.dateTime)).toBeGreaterThanOrEqual(before - 5_000);
    expect(Date.parse(rest.dateTime)).toBeLessThanOrEqual(after + 5_000);
    // Sent today: the time alone, as the person's locale writes it.
    expect(rest.text).toBe(
      await app.eval<string>(
        `new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(${JSON.stringify(rest.dateTime)}))`,
      ),
    );
    await app.movePointer(await point(latest));
    const hovered = await lookWhen("1", "the time shown on hover");
    expect(hovered.message, "hovering moves nothing").toEqual(rest.message);
    expect(hovered.time, "the time shows where it waited").toEqual(rest.time);
    // Beside the message, or under its corner in a narrow chat: never on it.
    const [left, , , bottom] = hovered.message;
    const [, timeTop, timeRight] = hovered.time;
    expect(timeRight <= left || timeTop >= bottom).toBe(true);
    // Away again, it goes.
    await app.movePointer(await point("composer()"));
    await lookWhen("0", "the time hidden again");
    // Keyboard focus on the message or a control inside it reveals the
    // time too, without a broad group-has selector over the document.
    await app.press("Tab");
    await run(`${latest}.focus({ preventScroll: true }); return true;`);
    await lookWhen("1", "the time shown for keyboard focus");
    await app.press("Tab");
    await runWait(
      `return ${latest}.contains(document.activeElement) && document.activeElement !== ${latest};`,
      { label: "keyboard focus inside the message" },
    );
    await lookWhen("1", "the time stays for a focused message control");
    await run("composer().focus(); return true;");
    await lookWhen("0", "the time hidden after keyboard focus leaves");
    // A phone-narrow column: the time hangs under the message's corner,
    // inside the conversation.
    await run(`
      const style = document.createElement('style');
      style.id = 'e2e-narrow-column';
      style.textContent = '[role="log"] > div > div { max-width: 335px !important; }';
      document.head.append(style);
      return true;`);
    // The column now resizes smoothly. Aim the native pointer at its final
    // position, after the width transition, rather than at a moving message.
    await runWait(
      `const column = frontDock().querySelector('[role="log"] > div > div');
       return Math.abs(column.getBoundingClientRect().width - 335) < 1 &&
         !column.getAnimations().some(animation => animation.playState === 'running');`,
      { label: "the narrow column settled" },
    );
    await app.movePointer(await point(latest));
    const narrow = await lookWhen("1", "the time shown in a narrow column");
    const column = await run<[number, number]>(
      `const r = ${latest}.closest('.cat-row').getBoundingClientRect(); return [r.left, r.right];`,
    );
    const [, , narrowRight, narrowBottom] = narrow.message;
    const [timeLeft, underTop, underRight] = narrow.time;
    expect(underTop, "under the message").toBeGreaterThanOrEqual(narrowBottom);
    expect(underRight, "at its corner").toBeLessThanOrEqual(narrowRight);
    expect(timeLeft, "inside the conversation").toBeGreaterThanOrEqual(
      column[0],
    );
    // Drawn on top where it hangs, and the pointer can reach it there.
    expect(
      await run<boolean>(
        `const time = ${latest}.querySelector('[data-testid="chat-sent-time"]');
         const r = time.firstElementChild.getBoundingClientRect();
         return time.contains(document.elementFromPoint(r.left + r.width / 2, r.bottom - 2));`,
      ),
    ).toBe(true);
    await run(
      `document.getElementById('e2e-narrow-column').remove(); return true;`,
    );
    await app.movePointer(await point("composer()"));
  }, 120_000);

  it("keeps the latest words at the end of the view while the composer grows and shrinks", async () => {
    await newChat();
    await run(`
      const input = composer(); input.focus();
      setReactValue(input, 'pace the work quickly at length');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;`);
    await runWait(
      `const s = logScroller();
       return !!s && !frontDock().querySelector('[data-testid="chat-activity"]') &&
         s.scrollHeight > s.clientHeight + 120 && following();`,
      { label: "a long answer settled, followed", timeoutMs: 30_000 },
    );
    /** Every painted frame while the composer glides to `text`'s height. */
    const glide = (text: string) =>
      run<Array<{ height: number; fromEnd: number; pinned: boolean }>>(`
        const s = logScroller();
        const input = composer(); input.focus();
        const frames = [];
        // Each frame the view resizes, after the chat's own observer and
        // before paint: what that frame paints. A task between frames would
        // read a layout the glide has since moved on, one no frame paints.
        const observer = new ResizeObserver(() => {
          frames.push({
            height: s.clientHeight,
            fromEnd: s.scrollHeight - s.clientHeight - s.scrollTop,
            // Still following: the library never took the taller view's
            // pull back to its end for the person scrolling up.
            pinned: s.firstElementChild.hasAttribute('data-pinned'),
          });
        });
        observer.observe(s);
        setReactValue(input, ${JSON.stringify(text)});
        return new Promise((resolve) => setTimeout(() => {
          observer.disconnect();
          resolve(frames);
        }, 600));`);
    for (const [text, label] of [
      ["one\ntwo\nthree\nfour", "growing"],
      ["", "shrinking"],
    ] as const) {
      const frames = await glide(text);
      const heights = frames.map((frame) => frame.height);
      const [first = 0, last = 0] = [heights[0], heights.at(-1)];
      expect(
        Math.abs(last - first),
        `${label}: the view resized`,
      ).toBeGreaterThan(30);
      expect(
        heights.some(
          (height) =>
            height > Math.min(first, last) + 1 &&
            height < Math.max(first, last) - 1,
        ),
        `${label}: through the frames between`,
      ).toBe(true);
      // The latest words ride the composer's edge on every frame, rather
      // than slipping under it and catching up once it stops.
      expect(
        Math.max(...frames.map((frame) => frame.fromEnd)),
        `${label}: ${JSON.stringify(frames)}`,
      ).toBeLessThan(2);
      expect(
        frames.every((frame) => frame.pinned),
        `${label}: ${JSON.stringify(frames)}`,
      ).toBe(true);
    }
    expect(await run<boolean>("return following();")).toBe(true);
  }, 120_000);

  it("navigates messages with configurable PageUp and PageDown, including held keys", async () => {
    await newChat();
    for (let i = 1; i <= 4; i++) {
      const text =
        `Navigation message ${i}.\n\n` +
        Array.from({ length: 20 }, (_, j) => `Paragraph ${j + 1}.`).join(
          "\n\n",
        );
      await run(
        `setReactValue(composer(), ${JSON.stringify(text)}); composer().closest('form').requestSubmit(); return true;`,
      );
      await runWait(
        `return frontDock().textContent.includes('You said: Navigation message ${i}.') && !frontDock().querySelector('[aria-label="Stop the agent"]') && following();`,
      );
    }
    expect(
      await run(
        `return !!frontDock().querySelector('[aria-label="Scroll to latest message"], [data-testid="chat-jump-previous"]');`,
      ),
    ).toBe(false);
    await run(
      `setReactValue(composer(), 'Keep this draft'); composer().focus(); return true;`,
    );
    await focusWindow(app);
    await runWait(
      "return document.hasFocus() && document.activeElement === composer();",
      { label: "navigation composer has native focus" },
    );
    // A folding step can shrink the transcript as navigation starts. The
    // person's target must keep priority over the library's near-end follow.
    await run(`
      const content=logScroller().firstElementChild;
      const shrinking=document.createElement('div'); shrinking.style.height='8px';
      content.insertBefore(shrinking,content.lastElementChild);
      window.__navigationStarted=false; window.__navigationUnpinned=false; window.__navigationRepinned=false;
      const sample=()=>{
        if(window.__navigationStarted){
          const pinned=content.hasAttribute('data-pinned');
          if(!pinned) window.__navigationUnpinned=true;
          else if(window.__navigationUnpinned) window.__navigationRepinned=true;
        }
        window.__navigationFrame=requestAnimationFrame(sample);
      };
      window.__navigationFrame=requestAnimationFrame(sample);
      window.addEventListener('keydown',function fold(event){
        if(event.key!=='PageUp')return;
        window.__navigationStarted=true;
        // Fold after the first navigation frame has let go, while it is
        // still near the end. This proves a resize cannot take it back.
        requestAnimationFrame(()=>requestAnimationFrame(()=>shrinking.remove()));
        window.removeEventListener('keydown',fold);
      });
      return true;`);
    await runWait("return following();", {
      label: "navigation starts from the end before the row folds",
    });
    const key = async (
      name: "PageUp" | "PageDown" | "ArrowUp" | "ArrowDown",
      repeat = false,
      modifiers = 0,
    ) => {
      const code = { PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40 }[
        name
      ];
      await app.cdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
        modifiers,
        autoRepeat: repeat,
      });
      if (!repeat)
        await app.cdp("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: name,
          code: name,
          windowsVirtualKeyCode: code,
          modifiers,
        });
    };
    const atMessage = (index: number) =>
      runWait(
        `const s=logScroller(); const m=s.querySelectorAll('[data-user-message]')[${index}]; const top=m?.getBoundingClientRect().top-s.getBoundingClientRect().top; return top >= 0 && top < 80;`,
        { label: `navigation message ${index + 1} at the top` },
      );
    await key("PageUp");
    await atMessage(3);
    expect(await run("return window.__navigationRepinned;")).toBe(false);
    await run("cancelAnimationFrame(window.__navigationFrame); return true;");
    // One repeat means held: reach the end without stepping through each
    // intermediate message or waiting for more repeats.
    await key("PageUp", true);
    await app.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "PageUp",
      code: "PageUp",
      windowsVirtualKeyCode: 33,
    });
    await atMessage(0);
    await runWait("return logScroller().scrollTop < 1;", {
      label: "held Up reaches the absolute top before another press",
    });
    const oldest = await run<number>("return logScroller().scrollTop;");
    await key("PageUp");
    await key("PageUp", true);
    await run(`return new Promise(resolve => setTimeout(resolve, 300));`);
    expect(
      Math.abs((await run<number>("return logScroller().scrollTop;")) - oldest),
    ).toBeLessThan(2);
    await key("PageDown");
    await atMessage(1);
    await key("PageDown", true);
    await app.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "PageDown",
      code: "PageDown",
      windowsVirtualKeyCode: 34,
    });
    await runWait("return following();", {
      label: "held PageDown reaches the latest response",
    });
    // Settings reads the same provider as the chat. Wait for its new
    // bindings to render, not merely for the IPC broadcast to arrive.
    await app.eval(
      "document.querySelector('button[aria-label=\"Settings\"]').click()",
    );
    await app.waitFor(
      "!!document.querySelector('[data-setting-id=\"shortcut.chat-previous-message\"]')",
    );
    await app.eval(`(async () => {
      const api=window.catamorphicDesktop, current=await api.getKeybindings();
      await api.setKeybindings({...current,
        'chat-previous-message':'Alt+ArrowUp', 'chat-next-message':'Alt+ArrowDown'
      });
      return true;
    })()`);
    await app.waitFor(`
      document.querySelector('[data-setting-id="shortcut.chat-previous-message"] button')?.textContent === '⌥↑' &&
      document.querySelector('[data-setting-id="shortcut.chat-next-message"] button')?.textContent === '⌥↓'`);
    // Opening Settings minimizes the floating chat; restore it normally.
    await app.press("m", process.platform === "darwin" ? 4 : 2);
    await runWait(
      "return !!composer() && !frontDock().getAnimations().some(a=>a.playState==='running');",
      { label: "navigation chat restored after changing its shortcuts" },
    );
    await run("composer().focus(); return true;");
    // A busy renderer can deliver the upward glide's scroll notification
    // after the next key. Coalesce those notifications, then release one
    // after the Down handler, before its first animation frame.
    await run(`
      const s=logScroller();window.__delayedNavigationScrolls=0;
      const hold=event=>{window.__delayedNavigationScrolls++;event.stopImmediatePropagation();};
      const restore=()=>{
        s.removeEventListener('scroll',hold,true);
        window.removeEventListener('keydown',release);
      };
      const release=event=>{
        if(event.key!=='ArrowDown'||!event.altKey)return;
        restore();s.dispatchEvent(new Event('scroll'));
      };
      s.addEventListener('scroll',hold,true);
      window.addEventListener('keydown',release);
      window.__restoreNavigationScroll=restore;return true;
    `);
    try {
      await key("ArrowUp", false, 1);
      await atMessage(3);
      await key("ArrowDown", false, 1);
      await runWait("return following();", {
        label: "customized Down reaches latest after a delayed upward scroll",
      });
      expect(
        await run<number>("return window.__delayedNavigationScrolls;"),
      ).toBeGreaterThan(0);
    } finally {
      await run("window.__restoreNavigationScroll();return true;");
    }
    // Streaming layout can carry the viewport slightly past the endpoint
    // recorded when Down began. That also counts as arriving, so following
    // must resume rather than waiting forever for an exact old position.
    await key("ArrowUp", false, 1);
    await atMessage(3);
    await run(`
      const s=logScroller(), content=s.firstElementChild;
      const padding=content.style.paddingBottom;
      // Capture Down's real native endpoint. Contained rows can change the
      // scroll height between this setup and the key handler's measurement.
      const ownScrollTo=Object.getOwnPropertyDescriptor(s,'scrollTo');
      const scrollTo=s.scrollTo;
      let end;
      s.scrollTo=function(...args){
        if(end===undefined && typeof args[0]?.top==='number') end=args[0].top;
        return scrollTo.apply(this,args);
      };
      window.__navigationPassedEnd=false;
      window.__navigationGrowth=[];
      // Observe arrival before the scroll library's handlers. A browser can
      // coalesce scrollend with the preceding glide, so it is not the
      // signal that this fixture's simulated layout change should depend on.
      const grow=()=>{
        const max=s.scrollHeight-s.clientHeight;
        window.__navigationGrowth.push({top:s.scrollTop,end,max});
        if(end===undefined || s.scrollTop<Math.min(end,max)-2)return;
        s.removeEventListener('scroll',grow,true);
        content.style.paddingBottom=(parseFloat(getComputedStyle(content).paddingBottom)+Math.max(64,end-max+64))+'px';
        s.scrollTop=end+8;
        window.__navigationPassedEnd=s.scrollTop>end+2;
      };
      s.addEventListener('scroll',grow,true);
      window.__restoreNavigationGrowth=()=>{
        s.removeEventListener('scroll',grow,true);
        if(ownScrollTo) Object.defineProperty(s,'scrollTo',ownScrollTo);
        else delete s.scrollTo;
        content.style.paddingBottom=padding;
      };return true;
    `);
    try {
      await key("ArrowDown", false, 1);
      await runWait(
        `const s=logScroller();
         if(!window.__navigationPassedEnd || !following()) throw new Error(JSON.stringify({passed:window.__navigationPassedEnd,following:following(),top:s.scrollTop,max:s.scrollHeight-s.clientHeight,growth:window.__navigationGrowth}));
         return true;`,
        {
          label:
            "following resumes after layout carries Down past its endpoint",
        },
      );
    } finally {
      await run("window.__restoreNavigationGrowth();return true;");
    }
    // A tab's top padding must not make the first Down merely align the
    // oldest message after a held Up has reached the absolute beginning.
    const maximize = await run<{ x: number; y: number }>(`
      const r=frontDock().querySelector('button[aria-label="Open as tab"]').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};`);
    await app.clickPointer(maximize);
    await runWait(
      `const dock=frontDock();
       if(!dock.hasAttribute('data-chat-tab'))return false;
       // The wrapper's padding and the header's collapse resize the log
       // after the section itself has stopped animating.
       for(let node=dock;node;node=node.parentElement)
         if(node.getAnimations({subtree:node===dock}).some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity))return false;
       return true;`,
      { label: "navigation chat is a settled tab" },
    );
    await run("composer().focus(); return true;");
    await runWait("return document.activeElement === composer();", {
      label: "tab navigation composer has focus",
    });
    await key("ArrowUp", false, 1);
    await key("ArrowUp", true, 1);
    await app.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowUp",
      code: "ArrowUp",
      windowsVirtualKeyCode: 38,
      modifiers: 1,
    });
    await runWait("return logScroller().scrollTop < 1;", {
      label: "held Up reaches the tab's absolute top",
    });
    await key("ArrowDown", false, 1);
    await atMessage(1);
    expect(await run(`return composer().textContent;`)).toBe("Keep this draft");
    expect(app.getRendererErrors()).toEqual([]);
  });
});
