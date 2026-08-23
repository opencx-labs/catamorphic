import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Motion-contract tests. These do NOT measure frame rate (machine-dependent,
 * flaky) — they assert the deterministic layer of "feel":
 *
 * 1. Design-system bounds: every app animation uses the standard easing,
 *    stays within the sanctioned duration range, and never loops (except
 *    the indeterminate-progress spinners).
 * 2. Paired motion: enter/exit animations of the same surface match
 *    (duration, easing, mirrored poses).
 * 3. Animate-before-unmount: dismissing a surface plays its exit animation
 *    while still mounted, then unmounts — nothing vanishes instantly.
 *
 * The rules live in DESIGN.md ("Motion contract"). Changing a duration or
 * easing is fine — do it deliberately and update both there and here.
 */

/** The one easing for app motion (--ease-standard). */
const STANDARD_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** Structural motion bounds (ms). */
const MIN_MS = 100;
const MAX_MS = 300;
/** Sanctioned exceptions: indeterminate-progress loops + the title flash. */
const LOOP_ALLOWLIST = new Set(["animate-spin", "animate-pulse"]);
const DURATION_EXCEPTIONS: Record<string, number> = {
  "animate-title-change": 1200,
};

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp();
});

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  /** All rules, recursing into grouping rules (@layer, @media, @supports). */
  const allStyleRules = () => {
    const rules = [];
    const walk = (list) => {
      for (const rule of list) {
        rules.push(rule);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch {}
    }
    return rules;
  };
  const toMs = (value) => {
    const raw = (value ?? '').trim();
    if (raw.endsWith('ms')) return parseFloat(raw);
    if (raw.endsWith('s')) return parseFloat(raw) * 1000;
    return Number.NaN;
  };
  /** Sample element state every ~25ms until it unmounts or times out. */
  const sampleUntilGone = (el, exitClass, timeoutMs) => new Promise((resolve) => {
    const samples = [];
    const started = performance.now();
    const tick = () => {
      const t = Math.round(performance.now() - started);
      if (!el.isConnected) { samples.push({ t, gone: true }); resolve(samples); return; }
      const cs = getComputedStyle(el);
      samples.push({ t, opacity: parseFloat(cs.opacity),
        exiting: exitClass ? el.classList.contains(exitClass) : undefined });
      if (performance.now() - started > timeoutMs) resolve(samples);
      else setTimeout(tick, 25);
    };
    tick();
  });
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

interface AnimationRule {
  selector: string;
  name: string;
  durationMs: number;
  easing: string;
  iterationCount: string;
}

/** All `.animate-*` single-class rules in the loaded stylesheets. */
const collectAnimationRules = () =>
  run<AnimationRule[]>(`
    return allStyleRules()
      .filter((rule) => rule.selectorText && /^\\.animate-[a-z0-9-]+$/.test(rule.selectorText))
      .filter((rule) => rule.style && rule.style.animationName && rule.style.animationName !== 'none')
      .map((rule) => ({
        selector: rule.selectorText.slice(1),
        name: rule.style.animationName,
        durationMs: toMs(rule.style.animationDuration),
        easing: rule.style.animationTimingFunction,
        iterationCount: rule.style.animationIterationCount || '1',
      }));
  `);

describe("setup", () => {
  it("creates a project workspace", async () => {
    await runWait(`return !!byText('button', 'New project');`);
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'motion-project');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
    );
    await runWait(`return !!byText('button', 'New Tab');`, {
      timeoutMs: 60_000,
      label: "workspace ready",
    });
  });
});

describe("design-system bounds (static sweep)", () => {
  it("every app animation uses the standard easing and sanctioned duration", async () => {
    const rules = await collectAnimationRules();
    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) {
      if (LOOP_ALLOWLIST.has(rule.selector)) continue;
      const exception = DURATION_EXCEPTIONS[rule.selector];
      if (exception !== undefined) {
        expect(rule.durationMs, rule.selector).toBe(exception);
      } else {
        expect(rule.durationMs, rule.selector).toBeGreaterThanOrEqual(MIN_MS);
        expect(rule.durationMs, rule.selector).toBeLessThanOrEqual(MAX_MS);
      }
      expect(rule.easing, rule.selector).toBe(STANDARD_EASING);
    }
  });

  it("nothing loops except indeterminate-progress spinners", async () => {
    const rules = await collectAnimationRules();
    for (const rule of rules) {
      if (LOOP_ALLOWLIST.has(rule.selector)) continue;
      expect(rule.iterationCount, rule.selector).not.toBe("infinite");
    }
  });

  it("transition duration utilities stay within bounds", async () => {
    const durations = await run<{ selector: string; ms: number }[]>(`
      return allStyleRules()
        .filter((rule) => rule.selectorText && /^\\.duration-\\d+$/.test(rule.selectorText))
        .map((rule) => ({
          selector: rule.selectorText,
          ms: toMs(rule.style.transitionDuration),
        }))
        .filter((entry) => !Number.isNaN(entry.ms));
    `);
    expect(durations.length).toBeGreaterThan(0);
    for (const entry of durations) {
      expect(entry.ms, entry.selector).toBeGreaterThanOrEqual(MIN_MS);
      expect(entry.ms, entry.selector).toBeLessThanOrEqual(MAX_MS);
    }
  });
});

describe("paired motion (enter/exit mirrors)", () => {
  it("bubble-in and bubble-out match in duration and easing", async () => {
    const rules = await collectAnimationRules();
    const enter = rules.find((rule) => rule.selector === "animate-bubble-in");
    const exit = rules.find((rule) => rule.selector === "animate-bubble-out");
    expect(enter).toBeDefined();
    expect(exit).toBeDefined();
    expect(exit?.durationMs).toBe(enter?.durationMs);
    expect(exit?.easing).toBe(enter?.easing);
  });

  it("tab-in and tab-out share easing and near-equal duration", async () => {
    const rules = await collectAnimationRules();
    const enter = rules.find((rule) => rule.selector === "animate-tab-in");
    const exit = rules.find((rule) => rule.selector === "animate-tab-out");
    expect(enter).toBeDefined();
    expect(exit).toBeDefined();
    expect(exit?.easing).toBe(enter?.easing);
    expect(
      Math.abs((exit?.durationMs ?? 0) - (enter?.durationMs ?? 0)),
    ).toBeLessThanOrEqual(50);
  });

  it("dock open animation matches the dock's collapse transition", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "floating dock open" });
    const timing = await run<{ animationMs: number; transitionMs: number }>(`
      const cs = getComputedStyle(visibleDock());
      return {
        animationMs: toMs(cs.animationDuration.split(',')[0]),
        transitionMs: toMs(cs.transitionDuration.split(',')[0]),
      };
    `);
    // Open (dock-in keyframe) and minimize (transition) must be one system.
    expect(timing.animationMs).toBe(timing.transitionMs);
  });

  it("the dock's minimized pose mirrors dock-in's starting pose", async () => {
    await runWait(
      `if (visibleDock()) return true;
       pressKey('n', { metaKey: true });
       return false;`,
      { label: "floating dock ready for pose check" },
    );
    const enterFrom = await run<{ translateY: number; scale: number }>(`
      const keyframes = allStyleRules().find(
        (rule) => rule instanceof CSSKeyframesRule && rule.name === 'dock-in');
      const from = [...keyframes.cssRules].find(
        (rule) => rule.keyText === 'from' || rule.keyText === '0%');
      const transform = from.style.transform;
      return {
        translateY: parseFloat(/translateY\\((-?[\\d.]+)px\\)/.exec(transform)[1]),
        scale: parseFloat(/scale\\((-?[\\d.]+)\\)/.exec(transform)[1]),
      };
    `);
    // Draft first (its own eval so React renders before Escape) so Escape
    // minimizes instead of closing.
    await run(`
      setReactValue(visibleDock().querySelector('[data-composer-input]'), 'keep me around');
      return true;
    `);
    await runWait(
      `return visibleDock().querySelector('[data-composer-input]').textContent === 'keep me around';`,
      { label: "draft flushed" },
    );
    await run(`
      window.__dock = visibleDock();
      pressKey('Escape');
      return true;
    `);
    // Settled = two consecutive polls agree, fully faded, still mounted.
    const restingPose = await runWait<{ translate: string; scale: string }>(
      `const el = window.__dock;
       if (!el || !el.isConnected || !el.inert) return false;
       const cs = getComputedStyle(el);
       if (parseFloat(cs.opacity) !== 0) return false;
       const pose = { translate: cs.translate, scale: cs.scale };
       if (!window.__lastPose ||
           JSON.stringify(window.__lastPose) !== JSON.stringify(pose)) {
         window.__lastPose = pose;
         return false;
       }
       return pose;`,
      { label: "dock settled into minimized pose" },
    );
    expect(restingPose.translate).toBe(`0px ${enterFrom.translateY}px`);
    expect(Number.parseFloat(restingPose.scale)).toBeCloseTo(
      enterFrom.scale,
      3,
    );
  });
});

describe("animate-before-unmount", () => {
  it("the mobile pairing modal tweens in and out instead of appearing or vanishing", async () => {
    await run(`pressKey('p', { metaKey: true }); return true;`);
    await runWait(
      `return !!$$('textarea[aria-label="Search commands, pages, and more"]')
        .find((el) => !el.closest('[inert]'));`,
      { label: "palette open for mobile pairing" },
    );
    const samples = await run<{
      enter: number[];
      enterTransition: boolean;
      exit: Array<{ opacity?: number; gone?: boolean }>;
      exitTransition: boolean;
      loadingHeight: number;
      readyHeight: number;
      loadingStage: { width: number; height: number };
      readyStage: { width: number; height: number };
      qrAnimation: string;
    }>(`
      return (async () => {
      const input = $$('textarea[aria-label="Search commands, pages, and more"]')
        .find((el) => !el.closest('[inert]'));
      setReactValue(input, 'continue on mobile');
      await new Promise((resolve) => setTimeout(resolve, 0));
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      const enter = [];
      let enterTransition = false;
      let loadingLayout = null;
      const deadline = performance.now() + 400;
      while (performance.now() < deadline) {
        const heading = byText('h2', 'Continue on mobile');
        const overlay = heading?.closest('[aria-hidden]');
        if (overlay) {
          enter.push(parseFloat(getComputedStyle(overlay).opacity));
          enterTransition ||= overlay.getAnimations().some(
            (animation) => animation instanceof CSSTransition &&
              animation.transitionProperty === 'opacity');
          const modal = $('[data-testid="mobile-pairing-modal"]');
          const stage = $('[data-testid="mobile-pairing-qr-stage"]');
          if (modal?.dataset.state === 'loading' && stage) {
            const panel = heading.closest('[role="dialog"]');
            const stageRect = stage.getBoundingClientRect();
            loadingLayout = {
              height: panel.getBoundingClientRect().height,
              stage: { width: stageRect.width, height: stageRect.height },
            };
          }
        }
        await new Promise(requestAnimationFrame);
      }
      let newCode = byText('button', 'New code');
      while (!newCode) {
        await new Promise(requestAnimationFrame);
        newCode = byText('button', 'New code');
      }
      const modal = $('[data-testid="mobile-pairing-modal"]');
      if (!loadingLayout || modal?.dataset.state !== 'ready') {
        throw new Error('Pairing modal did not expose stable loading and ready states');
      }
      const heading = byText('h2', 'Continue on mobile');
      const overlay = heading.closest('[aria-hidden]');
      const panel = heading.closest('[role="dialog"]');
      while (!$('[data-testid="mobile-pairing-qr"]')) {
        await new Promise(requestAnimationFrame);
      }
      const readyStageRect = $('[data-testid="mobile-pairing-qr-stage"]')
        .getBoundingClientRect();
      const readyHeight = panel.getBoundingClientRect().height;
      const qrAnimation = getComputedStyle(
        $('[data-testid="mobile-pairing-qr"]'),
      ).animationName;
      pressKey('Escape');
      await new Promise(requestAnimationFrame);
      const exitTransition = overlay.getAnimations().some(
        (animation) => animation instanceof CSSTransition &&
          animation.transitionProperty === 'opacity');
      const exit = await sampleUntilGone(overlay, null, 400);
      return {
        enter,
        enterTransition,
        exit,
        exitTransition,
        loadingHeight: loadingLayout.height,
        readyHeight,
        loadingStage: loadingLayout.stage,
        readyStage: {
          width: readyStageRect.width,
          height: readyStageRect.height,
        },
        qrAnimation,
      };
      })();
    `);
    expect(samples.enterTransition).toBe(true);
    expect(samples.exitTransition).toBe(true);
    expect(samples.readyHeight).toBeCloseTo(samples.loadingHeight, 0);
    expect(samples.loadingStage.width).toBeCloseTo(240, 0);
    expect(samples.loadingStage.height).toBeCloseTo(240, 0);
    expect(samples.readyStage.width).toBeCloseTo(samples.loadingStage.width, 0);
    expect(samples.readyStage.height).toBeCloseTo(
      samples.loadingStage.height,
      0,
    );
    expect(samples.qrAnimation).toBe("pairing-qr-in");
  });

  it("dismissing an empty floating chat tweens out, then unmounts", async () => {
    // Sidebar + is icon-only: select by aria-label, not text.
    await run(`$('button[aria-label="New chat"]').click(); return true;`);
    // Let the enter animation finish — dismissing a barely-mounted dock
    // (opacity still ~0) would leave the exit tween nothing to fade.
    await runWait(
      `const dock = visibleDock();
       return !!dock && getComputedStyle(dock).opacity === '1';`,
      { label: "empty dock fully visible" },
    );
    const samples = await run<
      { t: number; opacity?: number; gone?: boolean }[]
    >(`
      const dock = visibleDock();
      pressKey('Escape');
      return sampleUntilGone(dock, null, 1500);
    `);
    // Mid-tween: mounted with partial opacity. End: unmounted.
    expect(
      samples.some(
        (sample) =>
          sample.opacity !== undefined &&
          sample.opacity > 0 &&
          sample.opacity < 1,
      ),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone).toBe(true);
  });

  it("closing a workspace tab plays tab-out before removal", async () => {
    await run(`$('button[aria-label="New tab"]').click(); return true;`);
    // Scope to tab-strip elements: tabs carry animate-tab-in from mount
    // (bubble close buttons share the "Close …" aria-label prefix).
    await runWait(
      `return $$('.animate-tab-in button[aria-label^="Close"]').length >= 2;`,
      { label: "second workspace tab open" },
    );
    const samples = await run<
      { t: number; exiting?: boolean; gone?: boolean }[]
    >(`
      const buttons = $$('.animate-tab-in button[aria-label^="Close"]');
      const button = buttons[buttons.length - 1];
      const tab = button.closest('.animate-tab-in');
      button.click();
      return sampleUntilGone(tab, 'animate-tab-out', 1500);
    `);
    expect(
      samples.some((sample) => sample.exiting),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone).toBe(true);
  });

  it("chat messages tween in on every arrival path", async () => {
    // The "preamble" script lands messages on all arrival paths: the
    // optimistic user echo, flushed mid-turn preambles, and the final
    // settled reply. Each must MOUNT in the hidden pose (opacity 0) and
    // tween to visible — a message that appears already-opaque skipped
    // its entrance (the pre-paint effect-flush regression).
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    await run(`
      const log = visibleDock().querySelector('[role="log"]');
      window.__mounts = [];
      window.__mountEls = [];
      window.__mountsObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          const articles = n.matches('article') ? [n] : [...n.querySelectorAll('article')];
          for (const a of articles) {
            window.__mounts.push({ atInsert: getComputedStyle(a).opacity });
            window.__mountEls.push(a);
          }
        }
      });
      window.__mountsObs.observe(log, { childList: true, subtree: true });
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'preamble entrance check');
      ta.closest('form').requestSubmit();
      return true;
    `);
    // 1 user echo + 2 flushed preambles + 1 final reply — each must have
    // mounted hidden and (eventually) settled fully visible.
    const mounts = await runWait<{ atInsert: string }[]>(
      `if (window.__mounts.length < 4) return false;
       const settled = window.__mountEls.every((el) =>
         el.isConnected && getComputedStyle(el).opacity === '1');
       if (!settled) return false;
       window.__mountsObs.disconnect();
       return window.__mounts;`,
      { timeoutMs: 30_000, label: "all arrival paths mounted and settled" },
    );
    for (const mount of mounts) {
      expect(Number(mount.atInsert)).toBeLessThan(1);
    }
  });

  it("closing a chat bubble plays bubble-out before removal", async () => {
    // The pose test minimized a drafted chat — it lives as a bubble now.
    await runWait(
      `return $$('.animate-bubble-in button[aria-label^="Close"]').length >= 1;`,
      { label: "bubble with close button" },
    );
    const samples = await run<
      { t: number; exiting?: boolean; gone?: boolean }[]
    >(`
      const button = $$('.animate-bubble-in button[aria-label^="Close"]').at(-1);
      const bubble = button.closest('.animate-bubble-in');
      button.click();
      return sampleUntilGone(bubble, 'animate-bubble-out', 1500);
    `);
    expect(
      samples.some((sample) => sample.exiting),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone).toBe(true);
  });
});
