import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * A running turn's live chrome holds still while its words change, frame
 * by frame in the real renderer (design log 2026-10-13):
 *
 * - the activity line is a spinner and its words, nothing beside them,
 *   and a new activity fades the old words away and the new ones in
 *   without moving the spinner or the line;
 * - a folded steps line changes its count on a beat, and "steps" (with
 *   the turn's clock after it) slides when the count gains a digit;
 * - the turn's clock and a long silence sit on that steps line;
 * - an open list's rows keep their places as wider steps join it;
 * - the activity line closes its height when the turn ends;
 * - text pressed and selected while an answer streams holds still under
 *   the pointer, and a key or a press on the scrollbar takes the view
 *   away from the latest words for good;
 * - a lurking chat shown again mid-turn has its activity line open, not
 *   opening.
 *
 * Positions are sampled on every animation frame and compared within the
 * phase where nothing should move, so a slow host only means fewer
 * samples, never a different answer.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
}, 180_000);

afterAll(async () => {
  await app?.stop();
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
  const toLatest = () =>
    frontDock().querySelector('[aria-label="Scroll to latest message"]')?.click();
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
  /** The line of the answer a test pressed on (`data-e2e-held`). */
  held: Box;
  firstChevron: Box;
  reveal: Box;
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
const RECORDER = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [round(r.x), round(r.y), round(r.width), round(r.height)];
  };
  const frames = [];
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
    const articles = log ? [...log.querySelectorAll('article')] : [];
    frames.push({
      t: round(performance.now()),
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
      firstRow: box(first?.querySelector('button')),
      firstChevron: box(first?.querySelector('button > svg:last-child')),
      held: box(log?.querySelector('[data-e2e-held]')),
      reveal: box(row?.closest('.cat-reveal')),
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
  window.__chatMotion = { stop() { on = false; return frames; } };
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

async function newChat() {
  await run(`pressKey('n', { metaKey: true }); return true;`);
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
): Promise<Frame[]> {
  await run(RECORDER);
  await run(`
    const input = composer(); input.focus();
    setReactValue(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;`);
  await during?.();
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
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, `chat-motion-${name}.json`),
      JSON.stringify(frames),
    );
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

    // The spinner, the words' box and the steps line hold still.
    const spinnerX = live.map((frame) => frame.spinner?.[0] ?? 0);
    const spinnerY = live.map((frame) => frame.spinner?.[1] ?? 0);
    expect(spread(spinnerX), "spinner x").toBeLessThanOrEqual(0.5);
    expect(spread(spinnerY), "spinner y").toBeLessThanOrEqual(0.5);
    expect(spread(live.map((f) => f.text?.[0] ?? 0)), "words x").toBe(0);
    expect(spread(live.map((f) => f.text?.[3] ?? 0)), "words height").toBe(0);
    expect(spread(live.map((f) => f.toggle?.[0] ?? 0)), "line x").toBe(0);
    expect(spread(live.map((f) => f.toggle?.[1] ?? 0)), "line y").toBe(0);

    // Each new activity first fades the old words away, then shows its own.
    let swaps = 0;
    for (let i = 1; i < live.length; i++) {
      const before = live[i - 1];
      const after = live[i];
      if (!before || !after || before.textS === after.textS) continue;
      swaps++;
      expect(before.textO, `faded before "${after.textS}"`).toBeLessThanOrEqual(
        0.35,
      );
    }
    expect(swaps).toBeGreaterThanOrEqual(5);

    // The count changes on a beat: its number dims before each new one.
    let counts = 0;
    for (let i = 1; i < live.length; i++) {
      const before = live[i - 1];
      const after = live[i];
      if (!before || !after || before.toggleS === after.toggleS) continue;
      counts++;
      expect(before.countO, `dimmed before ${after.toggleS}`).toBeLessThan(0.5);
    }
    expect(counts).toBeGreaterThanOrEqual(5);

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
    // At the end the activity line closes its height before it goes.
    const closing = frames
      .filter((frame) => frame.answer && frame.reveal)
      .map((frame) => frame.reveal?.[3] ?? 0);
    const full = Math.max(...closing);
    expect(
      closing.filter((height) => height > 1 && height < full - 1).length,
      "frames between open and closed",
    ).toBeGreaterThan(0);
    expect(
      await run<number>(
        `return frontDock().querySelectorAll('[role="log"] [role="timer"]').length;`,
      ),
    ).toBe(0);
  }, 120_000);

  it("keeps an open list's rows in place as wider steps join it", async () => {
    await setDisplay("all");
    await newChat();
    const frames = await recordTurn("all", "pace the work quickly");
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
    const rowToLine = work.map(
      (frame) => (frame.firstRow?.[1] ?? 0) - (frame.toggle?.[1] ?? 0),
    );
    expect(spread(rowToLine), "first row under its line").toBe(0);
    // Settling (notes folding into the answer) never pulls the scroll back.
    expect(scrollJumps(frames).map((frame) => frame.t)).toEqual([]);
    // Nothing beside the activity words here either.
    for (const frame of frames.filter((f) => f.rowParts.length > 0))
      expect(lineParts(frame)).toEqual(["svg", "activity-text"]);
  }, 120_000);

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
        await new Promise((resolve) => setTimeout(resolve, 1200));
        // A person's wheel, which is what lets go of the latest message.
        const at = await run<{ x: number; y: number }>(
          `const r = frontDock().querySelector('[role="log"]').getBoundingClientRect();
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`,
        );
        await mark("scrolled");
        await app.cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...at,
          deltaX: 0,
          deltaY: -160,
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await mark("back");
        await run(
          `frontDock().querySelector('[aria-label="Scroll to latest message"]')?.click(); return true;`,
        );
      },
    );
    const marks = await readMarks();
    const between = (from: number, to: number) =>
      frames.filter((frame) => frame.t >= from && frame.t < to);
    // Following: the activity line holds still while the words grow above it.
    const pinned = between(marks.pinned ?? 0, marks.scrolled ?? 0).filter(
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
        await streamingLong();
        // A line of the answer in the middle of the view.
        const at = await runWait<{ x: number; y: number }>(
          `const s = logScroller();
           const view = s.getBoundingClientRect();
           const line = [...s.querySelectorAll('.cat-markdown:not([data-testid]) :is(p, li)')].find((el) => {
             const r = el.getBoundingClientRect();
             return r.width > 160 && r.top > view.top + view.height * 0.25 &&
               r.bottom < view.top + view.height * 0.6 &&
               el.contains(document.elementFromPoint(r.left + 6, r.top + r.height / 2));
           });
           if (!line) return false;
           line.setAttribute('data-e2e-held', '');
           const r = line.getBoundingClientRect();
           return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) };`,
          { label: "a line in the middle of the view" },
        );
        const mouse = (type: string, x: number, buttons: number) =>
          app.cdp("Input.dispatchMouseEvent", {
            type,
            x,
            y: at.y,
            button: "left",
            buttons,
            clickCount: 1,
          });
        await mouse("mousePressed", at.x, 1);
        await mark("pressed");
        for (const dx of [20, 40, 60, 80, 100]) {
          await mouse("mouseMoved", at.x + dx, 1);
          await sleep(80);
        }
        await sleep(1200);
        await mouse("mouseReleased", at.x + 100, 0);
        expect(
          await run<string>(
            `return document.getSelection()?.toString() ?? '';`,
          ),
          "text was selected",
        ).not.toBe("");
        await sleep(800);
        await mark("after");
        // A selection lets go of the latest words: they wait below.
        expect(
          await run<boolean>(
            `return !!frontDock().querySelector('[aria-label="Scroll to latest message"]');`,
          ),
        ).toBe(true);
        await run(
          `document.getSelection()?.removeAllRanges(); toLatest(); return true;`,
        );
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
          await sleep(1200);
          await mark("barred");
          // Back to the latest.
          await run(`toLatest(); return true;`);
          await runWait(`return following();`, {
            label: "following again",
            timeoutMs: 10_000,
          });
        }
        // PageUp with focus on a control in the conversation.
        expect(
          await run<string | undefined>(
            `logScroller().querySelector('[data-testid="chat-turn-steps-toggle"]')?.focus({ preventScroll: true });
             return document.activeElement?.dataset.testid;`,
          ),
        ).toBe("chat-turn-steps-toggle");
        const pageUp = {
          key: "PageUp",
          code: "PageUp",
          windowsVirtualKeyCode: 33,
          nativeVirtualKeyCode: 33,
        };
        await app.cdp("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          ...pageUp,
        });
        await app.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...pageUp });
        await mark("key");
        await sleep(1200);
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
    const open = frames
      .filter((frame) => frame.t < (marks.lurk ?? 0) && frame.reveal)
      .map((frame) => frame.reveal?.[3] ?? 0);
    const full = Math.max(...open);
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
});
