import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
  "animate-veil-touch": 760,
};

let app: AppHandle;
let pairingDist: string;

beforeAll(async () => {
  pairingDist = fs.mkdtempSync(path.join(os.tmpdir(), "motion-pwa-stub-"));
  fs.writeFileSync(
    path.join(pairingDist, "index.html"),
    "<!doctype html><title>motion-pwa-stub</title>",
  );
  fs.writeFileSync(
    path.join(pairingDist, "manifest.webmanifest"),
    JSON.stringify({ name: "Work", start_url: "/" }),
  );
  app = await launchApp({
    // Motion verification must not block on the host's macOS local-network
    // permission prompt. The HTTP pairing contract has its own E2E suite.
    env: {
      CATAMORPHIC_E2E_MOBILE_PAIRING_ADDRESS: "127.0.0.1",
      CATAMORPHIC_PWA_DIST: pairingDist,
    },
  });
});

afterAll(async () => {
  await app?.stop();
  fs.rmSync(pairingDist, { recursive: true, force: true });
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  // A floating chat: the dock's + (Cmd+N would take a New Tab in front).
  const newFloatingChat = () => {
    const plus = $('[data-dock-rail] button[aria-label="New chat"]');
    plus?.click();
    return !!plus;
  };
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
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
  /**
   * Sample element state every ~25ms until it unmounts or times out. The
   * bound is for a stuck exit, not a duration check: removal waits for the
   * exit animation's end event, which a busy CI host delivers late.
   */
  const EXIT_BOUND_MS = 5000;
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

/** All `.animate-*` and shared `.cat-*` single-class rules in the loaded stylesheets. */
const collectAnimationRules = () =>
  run<AnimationRule[]>(`
    return allStyleRules()
      .filter((rule) => rule.selectorText && /^\\.(?:animate|cat)-[a-z0-9-]+$/.test(rule.selectorText))
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
    await runWait(`return !!byText('button', 'Create or import project');`);
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
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
  it("composer recall moves by direction without fading", async () => {
    const keyframes = await run<Array<{ name: string; css: string }>>(`
      return allStyleRules()
        .filter((rule) => rule instanceof CSSKeyframesRule &&
          rule.name.startsWith('input-recall-'))
        .map((rule) => ({ name: rule.name, css: rule.cssText }));
    `);
    expect(keyframes.map((entry) => entry.name).sort()).toEqual([
      "input-recall-down-a",
      "input-recall-down-b",
      "input-recall-up-a",
      "input-recall-up-b",
    ]);
    for (const keyframe of keyframes) {
      expect(keyframe.css, keyframe.name).not.toContain("opacity");
    }
    expect(
      keyframes.find((entry) => entry.name === "input-recall-up-a")?.css,
    ).toContain("translate: 0px -3px");
    expect(
      keyframes.find((entry) => entry.name === "input-recall-down-a")?.css,
    ).toContain("translate: 0px 3px");
  });

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

  it("reduced motion collapses every animation and transition", async () => {
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      // A transition that started before the preference flipped keeps its
      // duration; wait for those to finish so only motion started under
      // reduce is measured.
      await app.waitFor(
        `document.getAnimations().every((animation) => (Number(animation.effect?.getTiming().duration) || 0) <= 1)`,
        { label: "pre-switch motion settled", timeoutMs: 5000 },
      );
      const longest = await run<number>(`
        return Math.max(0, ...allStyleRules()
          .filter((rule) => rule.selectorText)
          .map((rule) => Math.max(
            toMs(getComputedStyle(document.body).animationDuration) || 0,
            0,
          )));
      `);
      expect(longest).toBeLessThanOrEqual(1);
      const running = await run<{ duration: number; target: string }[]>(`
        document.body.offsetHeight;
        return document.getAnimations().map((animation) => {
          const target = animation.effect?.target;
          return {
            duration: Number(animation.effect?.getTiming().duration) || 0,
            target: target
              ? target.tagName.toLowerCase() +
                (target.className && typeof target.className === 'string'
                  ? '.' + target.className.trim().split(/\\s+/).join('.')
                  : '') +
                ' [' + (animation.animationName ?? animation.id ?? 'script') + ']'
              : 'detached',
          };
        });
      `);
      for (const { duration, target } of running)
        expect(duration, target).toBeLessThanOrEqual(1);
      const rail = await run<number>(
        `const el = document.querySelector('[data-dock-rail]') ?? document.body; return parseFloat(getComputedStyle(el).transitionDuration) * 1000;`,
      );
      expect(rail).toBeLessThanOrEqual(1);
    } finally {
      await app.cdp("Emulation.setEmulatedMedia", { features: [] });
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

  it("transition utilities without an ease-* class use the standard easing", async () => {
    // Every generated transition-* utility, resolved on a probe element so
    // the theme's default curve is what gets measured, not the rule text.
    const easings = await run<{ utility: string; easing: string }[]>(`
      const utilities = allStyleRules()
        .filter((rule) => rule.selectorText && /^\\.transition(-|$)/.test(rule.selectorText))
        .filter((rule) => rule.style && rule.style.transitionTimingFunction)
        .map((rule) => rule.selectorText.slice(1).replace(/\\\\(.)/g, '$1'));
      const probe = document.createElement('div');
      document.body.append(probe);
      const measured = [...new Set(utilities)].map((utility) => {
        probe.className = utility;
        return { utility, easing: getComputedStyle(probe).transitionTimingFunction };
      });
      probe.remove();
      return measured;
    `);
    expect(easings.map((entry) => entry.utility)).toEqual(
      expect.arrayContaining(["transition", "transition-colors"]),
    );
    for (const entry of easings) {
      expect(entry.easing, entry.utility).toBe(STANDARD_EASING);
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

  it("a sidebar tab and its strip arrive and leave on one reversible transition (ADR 0226)", async () => {
    const transitions = await run<
      Array<{ selector: string; durations: string; easing: string }>
    >(`
      return allStyleRules()
        .filter((rule) => rule.selectorText === '.sidebar-tab-slot' || rule.selectorText === '.sidebar-strip')
        .map((rule) => ({
          selector: rule.selectorText,
          durations: rule.style.transitionDuration,
          easing: rule.style.transitionTimingFunction,
        }));
    `);
    expect(transitions.map((rule) => rule.selector).sort()).toEqual([
      ".sidebar-strip",
      ".sidebar-tab-slot",
    ]);
    for (const rule of transitions) {
      // One duration and the standard curve both ways: leaving reverses
      // arriving from wherever it is.
      // The production build writes 200ms as 0.2s.
      expect(
        new Set(
          rule.durations.split(",").map((value) => {
            const duration = value.trim();
            return duration.endsWith("ms")
              ? Number.parseFloat(duration)
              : Number.parseFloat(duration) * 1000;
          }),
        ),
        rule.selector,
      ).toEqual(new Set([200]));
      expect(
        new Set(rule.easing.split(",").map((value) => value.trim())),
        rule.selector,
      ).toEqual(new Set(["var(--ease-standard)"]));
    }
  });

  it("dock-in and dock-out match in duration and easing", async () => {
    const rules = await collectAnimationRules();
    const enter = rules.find((rule) => rule.selector === "animate-dock-in");
    const exit = rules.find((rule) => rule.selector === "animate-dock-out");
    expect(enter).toBeDefined();
    expect(exit).toBeDefined();
    expect(exit?.durationMs).toBe(enter?.durationMs);
    expect(exit?.easing).toBe(enter?.easing);
  });

  it("the dock's minimized pose mirrors dock-in's starting pose", async () => {
    await runWait(
      `if (visibleDock()) return true;
       newFloatingChat();
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
    // The prior test may have opened this dock less than 250ms ago. Let its
    // enter animation finish before reversing it, otherwise cancelling the
    // keyframe and starting the transition in the same frame can expose the
    // expanded pose as a false "settled" sample on a fast CI compositor.
    await runWait(
      `const el = visibleDock();
       if (!el) return false;
       const cs = getComputedStyle(el);
       return parseFloat(cs.opacity) === 1 &&
         el.getAnimations().every((animation) => animation.playState === 'finished');`,
      { label: "dock enter animation settled" },
    );
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
    // Settled = its collapse transition finished, fully faded, still mounted.
    const restingPose = await runWait<{ translate: string; scale: string }>(
      `const el = window.__dock;
       if (!el || !el.isConnected || !el.inert) return false;
       const cs = getComputedStyle(el);
       if (parseFloat(cs.opacity) !== 0) return false;
       if (el.getAnimations().some((animation) => animation.playState !== 'finished')) return false;
       return { translate: cs.translate, scale: cs.scale };`,
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
      const enter = [];
      let enterTransition = false;
      let loadingLayout = null;
      // Observe commits before requesting the modal. Its async mount can take
      // longer than an animation, and a busy frame can miss the loading pose.
      const sampleEntrance = () => {
        const heading = byText('h2', 'Continue on mobile');
        const overlay = heading?.closest('[aria-hidden]');
        if (!overlay) return;
        enter.push(parseFloat(getComputedStyle(overlay).opacity));
        enterTransition ||= overlay.getAnimations().some(
          (animation) => animation instanceof CSSAnimation &&
            animation.animationName === 'fade-in');
        const modal = $('[data-testid="mobile-pairing-modal"]');
        const stage = $('[data-testid="mobile-pairing-qr-stage"]');
        if (modal?.dataset.state === 'loading' && stage) {
          const panel = heading.closest('[role="dialog"]');
          loadingLayout = {
            height: panel.offsetHeight,
            stage: { width: stage.offsetWidth, height: stage.offsetHeight },
          };
        }
      };
      const observer = new MutationObserver(sampleEntrance);
      observer.observe(document.body, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['data-state'],
      });
      try {
        setReactValue(input, 'continue on mobile');
        await new Promise((resolve) => setTimeout(resolve, 0));
        input.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'Enter', bubbles: true, cancelable: true }));
        // Ready waits on the pairing listener starting in the main process,
        // which a busy host takes longer than 5 s to do. The loop ends as
        // soon as the modal is ready; the bound is for one that never is.
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
          sampleEntrance();
          if ($('[data-testid="mobile-pairing-modal"]')?.dataset.state === 'ready') break;
          await new Promise(requestAnimationFrame);
        }
      } finally {
        observer.disconnect();
      }
      const modal = $('[data-testid="mobile-pairing-modal"]');
      if (!loadingLayout || modal?.dataset.state !== 'ready') {
        throw new Error('Pairing modal did not expose stable loading and ready states: loading ' + (loadingLayout ? 'seen' : 'missed') + ', state ' + modal?.dataset.state);
      }
      const heading = byText('h2', 'Continue on mobile');
      const overlay = heading.closest('[aria-hidden]');
      const panel = heading.closest('[role="dialog"]');
      while (!$('[data-testid="mobile-pairing-qr"]')) {
        await new Promise(requestAnimationFrame);
      }
      const readyStageElement = $('[data-testid="mobile-pairing-qr-stage"]');
      const readyStage = { width: readyStageElement.offsetWidth, height: readyStageElement.offsetHeight };
      const readyHeight = panel.offsetHeight;
      const qrAnimation = getComputedStyle(
        $('[data-testid="mobile-pairing-qr"]'),
      ).animationName;
      pressKey('Escape');
      await new Promise(requestAnimationFrame);
      const exitTransition = overlay.getAnimations().some(
        (animation) => animation instanceof CSSAnimation &&
          animation.animationName === 'fade-out');
      const exit = await sampleUntilGone(overlay, null, 400);
      return {
        enter,
        enterTransition,
        exit,
        exitTransition,
        loadingHeight: loadingLayout.height,
        readyHeight,
        loadingStage: loadingLayout.stage,
        readyStage,
        qrAnimation,
      };
      })();
    `);
    expect(samples.enterTransition).toBe(true);
    expect(samples.exitTransition).toBe(true);
    expect(samples.readyHeight).toBe(samples.loadingHeight);
    expect(samples.loadingStage).toEqual({ width: 240, height: 240 });
    expect(samples.readyStage).toEqual(samples.loadingStage);
    expect(samples.qrAnimation).toBe("pairing-qr-in");
  });

  it("dismissing an empty floating chat tweens out, then unmounts", async () => {
    await runWait(`return newFloatingChat();`, { label: "the dock's +" });
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
      return sampleUntilGone(dock, null, EXIT_BOUND_MS);
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
    expect(samples.at(-1)?.gone, `samples: ${JSON.stringify(samples)}`).toBe(
      true,
    );
  });

  it("minimizing a floating chat never replays dock-in between the two poses", async () => {
    await runWait(`return newFloatingChat();`, { label: "the dock's +" });
    await runWait(
      `const dock = visibleDock();
       return !!dock && getComputedStyle(dock).opacity === '1';`,
      { label: "dock fully visible" },
    );
    // A draft makes Escape minimize instead of close. The mode flip travels
    // through the entry owner, so the exit pose must hold until it lands.
    await run(`
      const input = visibleDock().querySelector('[data-composer-input]');
      input.focus();
      document.execCommand('insertText', false, 'Keep this draft');
      return true;
    `);
    await runWait(
      `return visibleDock().querySelector('[data-composer-input]').innerText.includes('Keep this draft');`,
      { label: "draft typed" },
    );
    const classes = await run<string[]>(`
      const dock = visibleDock();
      pressKey('Escape');
      return new Promise((resolve) => {
        const seen = [];
        const started = performance.now();
        const tick = () => {
          const cls = [...dock.classList].filter((c) => c.startsWith('animate-')).join(' ');
          if (seen.at(-1) !== cls) seen.push(cls);
          if (performance.now() - started > 1200 || (dock.inert && !cls)) resolve(seen);
          else requestAnimationFrame(tick);
        };
        tick();
      });
    `);
    const exitAt = classes.indexOf("animate-dock-out");
    expect(exitAt, `classes: ${JSON.stringify(classes)}`).toBeGreaterThan(-1);
    expect(
      classes.slice(exitAt + 1),
      `classes: ${JSON.stringify(classes)}`,
    ).not.toContain("animate-dock-in");
  });

  it("closing a workspace tab plays tab-out before removal", async () => {
    await run(`$('button[aria-label="New tab"]').click(); return true;`);
    // Scope to tab-strip elements (bubble close buttons share the
    // "Close …" aria-label prefix).
    await runWait(
      `return $$('[data-tab-orientation="horizontal"] [data-point-key] button[aria-label^="Close"]').length >= 2;`,
      { label: "second workspace tab open" },
    );
    const samples = await run<
      { t: number; exiting?: boolean; gone?: boolean }[]
    >(`
      const buttons = $$('[data-tab-orientation="horizontal"] [data-point-key] button[aria-label^="Close"]');
      const button = buttons[buttons.length - 1];
      const tab = button.closest('[data-point-key]');
      button.click();
      return sampleUntilGone(tab, 'animate-tab-out', EXIT_BOUND_MS);
    `);
    expect(
      samples.some((sample) => sample.exiting),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone, `samples: ${JSON.stringify(samples)}`).toBe(
      true,
    );
  });

  it("tab hover cards fade out before unmounting", async () => {
    await run(`
      const tab = $('[data-tab-orientation="horizontal"] [data-point-key]');
      const body = [...tab.querySelectorAll('button')]
        .find((button) => !button.getAttribute('aria-label')?.startsWith('Close'));
      body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    `);
    await runWait(
      `const card = $('[data-testid="tab-hover-card"].animate-fade-in');
       return !!card && getComputedStyle(card).opacity === '1';`,
      { label: "tab hover card entered" },
    );
    const samples = await run<
      { t: number; exiting?: boolean; gone?: boolean }[]
    >(`
      const tab = $('[data-tab-orientation="horizontal"] [data-point-key]');
      const body = [...tab.querySelectorAll('button')]
        .find((button) => !button.getAttribute('aria-label')?.startsWith('Close'));
      const card = $('[data-testid="tab-hover-card"]');
      body.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: document.body,
      }));
      return sampleUntilGone(card, 'animate-fade-out', EXIT_BOUND_MS);
    `);
    expect(
      samples.some((sample) => sample.exiting),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone, `samples: ${JSON.stringify(samples)}`).toBe(
      true,
    );
  });

  it("chat messages tween in on every arrival path", async () => {
    // The "preamble" script lands messages on all arrival paths: the
    // optimistic user echo, flushed mid-turn preambles, and the final
    // settled reply. Each must MOUNT in the hidden pose (opacity 0) and
    // tween to visible — a message that appears already-opaque skipped
    // its entrance (the pre-paint effect-flush regression).
    await runWait(`return newFloatingChat();`, { label: "the dock's +" });
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    // Every arrival has to stay on screen to be measured: by default the
    // preambles are replaced as they come and folded once answered.
    await run(
      `return window.catamorphicDesktop.setPrefs({ chatWorkLive: 'all', chatWorkSettled: 'keep' }).then(() => true);`,
    );
    // Then again on a renderer slowed fourfold, as on a busy CI runner:
    // events arrive between late frames, and the turn's first steps line
    // comes with work and prose that joined it in the same frame, taking
    // the place the turn line kept for it (it fades in there, unmoved).
    // And on one that stalls for 600 ms in the frame that first shows the
    // turn and again in the one that first shows the agent's words, as a
    // macOS runner did: the rest of the turn lands in one late frame.
    for (const { rate, stalls } of [
      { rate: 1, stalls: false },
      { rate: 4, stalls: false },
      { rate: 1, stalls: true },
    ]) {
      const pass = stalls ? "stalled" : `${rate}x slower`;
      await app.cdp("Emulation.setCPUThrottlingRate", { rate });
      try {
        await run(`
          const log = visibleDock().querySelector('[role="log"]');
          if (${stalls}) {
            // A long task after the frame's styles, before its motion.
            window.__stalls = 0;
            const stalled = new ResizeObserver((entries) => {
              for (const { target } of entries) {
                stalled.unobserve(target);
                const end = performance.now() + 600;
                while (performance.now() < end);
                window.__stalls++;
              }
            });
            // The first of each to arrive in this turn.
            const firsts = ['[data-testid="chat-activity"]', 'article:not([data-user-message])'];
            window.__stallObs = new MutationObserver((muts) => {
              for (const m of muts) for (const n of m.addedNodes) {
                if (!(n instanceof HTMLElement)) continue;
                for (const [i, selector] of firsts.entries()) {
                  const el = selector && (n.matches(selector) ? n : n.querySelector(selector));
                  if (!el) continue;
                  firsts[i] = undefined;
                  stalled.observe(el);
                }
              }
            });
            window.__stallObs.observe(log, { childList: true, subtree: true });
          }
          window.__mounts = [];
          window.__mountEls = [];
          window.__mountsObs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
              if (!(n instanceof HTMLElement)) continue;
              const articles = n.matches('article') ? [n] : [...n.querySelectorAll('article')];
              for (const a of articles) {
                window.__mounts.push({
                  atInsert: getComputedStyle(a).opacity,
                  // What arrived, for a failure to name.
                  what: a.hasAttribute('data-user-message') ? 'user echo'
                    : a.hasAttribute('data-live-work') ? 'live work' : 'reply',
                  text: a.textContent.slice(0, 60),
                });
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
        // 1 user echo + 2 flushed preambles + 1 final reply — each must
        // have mounted hidden and (eventually) settled fully visible.
        const mounts = await runWait<{ atInsert: string }[]>(
          `if (window.__mounts.length < 4) return false;
           const settled = window.__mountEls.every((el) =>
             el.isConnected && getComputedStyle(el).opacity === '1');
           if (!settled) return false;
           window.__mountsObs.disconnect();
           window.__stallObs?.disconnect();
           return window.__mounts;`,
          {
            timeoutMs: 30_000,
            label: `all arrival paths mounted and settled (${pass})`,
          },
        );
        for (const mount of mounts)
          expect(
            Number(mount.atInsert),
            `${pass}: ${JSON.stringify(mount)}`,
          ).toBeLessThan(1);
        if (stalls)
          expect(
            await run<number>("return window.__stalls;"),
            "the renderer stalled as the turn and the agent's words came",
          ).toBe(2);
        // The turn has ended before the next one starts.
        await runWait(
          `return !visibleDock().querySelector('[data-testid="chat-activity"]');`,
          { timeoutMs: 30_000, label: "turn settled" },
        );
      } finally {
        await app.cdp("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    }
    await run(
      `return window.catamorphicDesktop.setPrefs({ chatWorkLive: 'latest', chatWorkSettled: 'collapse' }).then(() => true);`,
    );
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
      return sampleUntilGone(bubble, 'animate-bubble-out', EXIT_BOUND_MS);
    `);
    expect(
      samples.some((sample) => sample.exiting),
      `samples: ${JSON.stringify(samples)}`,
    ).toBe(true);
    expect(samples.at(-1)?.gone, `samples: ${JSON.stringify(samples)}`).toBe(
      true,
    );
  });
});

const sidebarSettled = (open: boolean) =>
  runWait(
    `const side = $('[data-workspace-visible="true"] [data-sidebar="left"]');
     return side?.getAttribute('aria-hidden') === '${!open}' && side.dataset.settled === 'true' &&
       !document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith('::view-transition')) &&
       !('contentSettling' in document.documentElement.dataset);`,
    { label: `left sidebar ${open ? "open" : "closed"} and settled` },
  );

describe("chats over a settling sidebar", () => {
  const settled = sidebarSettled;
  // A web page lays out in its own process, so its content settles once
  // the panel is still (ADR 0200); content Work draws moves with the
  // panel instead (below).
  const page = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Motion page</title><p>A page beside the sidebar</p>");
  });
  afterAll(() => {
    page.close();
  });

  it("puts a web page in front", async () => {
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
    const address = page.address();
    if (!address || typeof address === "string") throw new Error("No address");
    await run(`
      window.catamorphicDesktop.workspaceNavigate({
        projectId: $('[data-workspace-visible="true"]').dataset.projectRuntime,
        surface: { url: 'http://127.0.0.1:${address.port}/', title: 'Motion page', mode: 'tab', nonce: 'motion-page', open: 'browser' },
      });
      return true;
    `);
    await app.waitFor(
      `[...document.querySelectorAll('[data-workspace-visible="true"] webview')].some((view) => { try { return view.checkVisibility() && view.getTitle() === 'Motion page' && !view.isLoading(); } catch { return false; } })`,
      { label: "web page in front", timeoutMs: 30_000 },
    );
  });

  it("a floating chat glides with the content instead of vanishing under it", async () => {
    await runWait(`return newFloatingChat();`, { label: "the dock's +" });
    await runWait(
      `const dock = visibleDock();
       return !!dock && getComputedStyle(dock).opacity === '1' && dock.getAnimations().every((a) => a.playState !== 'running');`,
      { label: "floating chat at rest" },
    );
    // Where everything rests: the dock on the visible chat region (anchored),
    // the chat centred in it.
    const geometry = () =>
      run<{ host: number[]; region: number[]; offCentre: number }>(`
        const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
        const region = $('[data-workspace-visible="true"] [data-workspace-chat-region]').getBoundingClientRect();
        const chat = visibleDock().getBoundingClientRect();
        return {
          host: box($('[data-dock-host]')),
          region: box($('[data-workspace-visible="true"] [data-workspace-chat-region]')),
          offCentre: Math.round(Math.abs(chat.left + chat.width / 2 - (region.left + region.width / 2))),
        };
      `);
    const before = await geometry();
    expect(before.host).toEqual(before.region);
    expect(before.offCentre).toBeLessThanOrEqual(1);
    // While the content settles, the chat is in a layer of its own above
    // the content's snapshot (the content would otherwise cover it).
    const seen = await run<{ layered: boolean; dockGroup: boolean }>(`
      $('[aria-label="Collapse sidebar"]').click();
      return new Promise((resolve) => {
        const started = performance.now();
        const seen = { layered: false, dockGroup: false };
        const tick = () => {
          const dock = visibleDock();
          if (dock && 'contentSettling' in document.documentElement.dataset) {
            const style = getComputedStyle(dock);
            seen.layered ||= style.getPropertyValue('view-transition-name') === 'match-element' && style.getPropertyValue('view-transition-class') === 'dock-float';
            // A group beyond the content's, the sidebars' and the root's:
            // the chat's own layer, whatever name the browser generates.
            seen.dockGroup ||= document.getAnimations().some((a) => {
              const name = /^::view-transition-group((.+))$/.exec(a.effect?.pseudoElement ?? '')?.[1];
              return !!name && !['root', 'workspace-content', 'workspace-tabs', 'sidebar-left', 'sidebar-right'].includes(name);
            });
          }
          if ((seen.layered && seen.dockGroup) || performance.now() - started > 5000) resolve(seen);
          else requestAnimationFrame(tick);
        };
        tick();
      });
    `);
    expect(seen).toEqual({ layered: true, dockGroup: true });
    await settled(false);
    const collapsed = await geometry();
    expect(collapsed.host).toEqual(collapsed.region);
    expect(collapsed.offCentre).toBeLessThanOrEqual(1);
    const [, , widthBefore = 0] = before.region;
    const [, , widthCollapsed = 0] = collapsed.region;
    expect(widthCollapsed).toBeGreaterThan(widthBefore);
    await run(`$('[aria-label="Expand sidebar"]').click(); return true;`);
    await settled(true);
    expect(await geometry()).toEqual(before);
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("the tab strip's + slides with the sidebar and lands without a jump", async () => {
    await settled(true);
    // Toggles the left sidebar and follows the + and the panel's edge every
    // frame until both are still and the content has settled.
    type Frame = {
      plus: number;
      edge: number;
      docked: string;
      seen: boolean;
      rightToggle: boolean;
    };
    const toggle = (label: string) =>
      run<Frame[]>(`
        const plus = () => $('[data-workspace-visible="true"] .workspace-chrome [aria-label="New tab"]');
        const side = () => $('[data-workspace-visible="true"] [data-sidebar="left"]');
        // What a press at an element's centre would reach: drawn, not clipped.
        const reached = (element) => {
          const box = element?.getBoundingClientRect();
          return !!box && element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        };
        const frames = [];
        [...document.querySelectorAll('[aria-label="${label}"]')]
          .find((b) => !b.closest('[inert]') && b.getBoundingClientRect().width > 0)
          .click();
        return new Promise((resolve) => {
          const started = performance.now();
          const tick = () => {
            frames.push({
              plus: Math.round(plus().getBoundingClientRect().left),
              edge: Math.round(side().querySelector('.sidebar-inner').getBoundingClientRect().right),
              docked: side().dataset.docked,
              seen: reached(plus()),
              rightToggle: reached($('[data-workspace-visible="true"] .workspace-chrome [aria-label$="right sidebar"]')),
            });
            if (side().dataset.settled === 'true' && performance.now() - started > 200) resolve(frames);
            else if (performance.now() - started > 5000) resolve(frames);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      `);
    const check = (frames: Frame[], from: number) => {
      const to = frames.at(-1)?.plus ?? from;
      const width = Math.max(...frames.map((frame) => frame.edge));
      // While the panel is midway, so is the +.
      const midway = frames.filter(
        (frame) => frame.edge > width * 0.25 && frame.edge < width * 0.75,
      );
      expect(midway.length, JSON.stringify(frames)).toBeGreaterThan(0);
      for (const frame of midway) {
        expect(frame.plus).toBeGreaterThan(Math.min(from, to) + 2);
        expect(frame.plus).toBeLessThan(Math.max(from, to) - 2);
        // Drawn where it is, even past where the content's edge was, and
        // never over the right sidebar's toggle.
        expect(frame.seen, JSON.stringify(frame)).toBe(true);
        expect(frame.rightToggle, JSON.stringify(frame)).toBe(true);
      }
      // Once the content has taken or given back the space, the + is where
      // it rests: no jump when the layout changes.
      const flipped = frames.findIndex(
        (frame) => frame.docked !== frames[0]?.docked,
      );
      expect(flipped, JSON.stringify(frames)).toBeGreaterThan(0);
      for (const frame of frames.slice(flipped)) expect(frame.plus).toBe(to);
      return to;
    };
    const open = await run<number>(
      `return Math.round($('[data-workspace-visible="true"] .workspace-chrome [aria-label="New tab"]').getBoundingClientRect().left);`,
    );
    const closed = check(await toggle("Collapse sidebar"), open);
    expect(closed).toBeLessThan(open);
    await settled(false);
    expect(check(await toggle("Expand sidebar"), closed)).toBe(open);
    await settled(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});

describe("content Work draws moves with the sidebar", () => {
  it("rides the panel's edge every frame, the tabs with it, and lands without a jump", async () => {
    await run(
      `$('[data-workspace-visible="true"] [aria-label="Settings"]').click(); return true;`,
    );
    await runWait(
      `return [...document.querySelectorAll('[data-workspace-visible="true"] webview')].every((view) => !view.checkVisibility()) &&
        !!$('[data-workspace-visible="true"] [data-settings-scroll]');`,
      { label: "Settings in front" },
    );
    await sidebarSettled(true);
    // The Settings tab grows into the strip first (tab-in).
    await runWait(
      `return document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity);`,
      { label: "the window at rest" },
    );
    type Frame = {
      edge: number;
      content: number;
      plus: number;
      push: boolean;
      settling: boolean;
    };
    const toggle = (label: string) =>
      run<Frame[]>(`
        const side = () => $('[data-workspace-visible="true"] [data-sidebar="left"]');
        const frames = [];
        [...document.querySelectorAll('[aria-label="${label}"]')]
          .find((b) => !b.closest('[inert]') && b.getBoundingClientRect().width > 0)
          .click();
        return new Promise((resolve) => {
          const started = performance.now();
          const tick = () => {
            frames.push({
              edge: Math.round(side().querySelector('.sidebar-inner').getBoundingClientRect().right),
              content: Math.round($('[data-workspace-visible="true"] .workspace-surface').getBoundingClientRect().left),
              plus: Math.round($('[data-workspace-visible="true"] .workspace-chrome [aria-label="New tab"]').getBoundingClientRect().left),
              push: side().hasAttribute('data-push'),
              settling: 'contentSettling' in document.documentElement.dataset,
            });
            if ((side().dataset.settled === 'true' && performance.now() - started > 200) || performance.now() - started > 5000) resolve(frames);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      `);
    const check = (frames: Frame[]) => {
      // No settle after the slide: the content was where it belongs all
      // along, its edge on the panel's.
      expect(frames.some((frame) => frame.push)).toBe(true);
      expect(frames.some((frame) => frame.settling)).toBe(false);
      for (const frame of frames)
        expect(
          Math.abs(Math.max(frame.edge, 0) - frame.content),
          JSON.stringify(frame),
        ).toBeLessThanOrEqual(1);
      // The + travels one way only and is still once the panel is.
      const plus = frames.map((frame) => frame.plus);
      const rising = (plus.at(-1) ?? 0) >= (plus[0] ?? 0);
      for (let index = 1; index < plus.length; index += 1)
        expect(
          rising
            ? (plus[index] ?? 0) >= (plus[index - 1] ?? 0)
            : (plus[index] ?? 0) <= (plus[index - 1] ?? 0),
          JSON.stringify(plus),
        ).toBe(true);
      const width = Math.max(...frames.map((frame) => frame.edge));
      const midway = frames.filter(
        (frame) => frame.edge > width * 0.25 && frame.edge < width * 0.75,
      );
      expect(midway.length, JSON.stringify(frames)).toBeGreaterThan(0);
      return plus.at(-1) ?? 0;
    };
    const open = await run<number>(
      `return Math.round($('[data-workspace-visible="true"] .workspace-chrome [aria-label="New tab"]').getBoundingClientRect().left);`,
    );
    const closed = check(await toggle("Collapse sidebar"));
    expect(closed).toBeLessThan(open);
    await sidebarSettled(false);
    expect(check(await toggle("Expand sidebar"))).toBe(open);
    await sidebarSettled(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});

describe("a floating chat grows into its tab", () => {
  it("over what was in front, which stays until covered, its card easing into the tab", async () => {
    // Settings in front (the sidebar's test left it there), a new floating
    // chat over it, which the person then makes a tab.
    await run(
      `$('[data-workspace-visible="true"] [aria-label="Settings"]').click(); return true;`,
    );
    const settings = `$('[data-workspace-visible="true"] [data-surface-key^="settings:"]')`;
    await runWait(`return !!${settings}?.checkVisibility();`, {
      label: "Settings in front",
    });
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(
      `const dock = visibleDock();
       return !!dock && dock.dataset.floatingChat === 'true' &&
         getComputedStyle(dock).opacity === '1';`,
      { label: "a floating chat over Settings" },
    );
    const frames = await run<
      Array<{
        t: number;
        tab: boolean;
        behind: boolean;
        width: number;
        title: number;
      }>
    >(`
      const dock = visibleDock();
      const title = dock.querySelector('header');
      const frames = [];
      const started = performance.now();
      return new Promise((resolve) => {
        const sample = () => {
          frames.push({
            t: Math.round(performance.now() - started),
            tab: dock.dataset.chatTab === 'true',
            behind: !!${settings}?.checkVisibility(),
            width: Math.round(dock.getBoundingClientRect().width),
            title: Number(getComputedStyle(title).opacity),
          });
          if (performance.now() - started < 700) requestAnimationFrame(sample);
          else resolve(frames);
        };
        pressKey('M', { metaKey: true, shiftKey: true });
        requestAnimationFrame(sample);
      });`);
    const grown = frames.filter((frame) => frame.tab);
    expect(grown.length, JSON.stringify(frames)).toBeGreaterThan(5);
    const from = grown[0]?.t ?? 0;
    // What was in front stays beneath the growing chat, then goes once it
    // is covered: never the bare backdrop around the chat.
    expect(
      grown
        .filter((frame) => frame.t < from + 150)
        .every((frame) => frame.behind),
      JSON.stringify(frames),
    ).toBe(true);
    expect(grown.at(-1)?.behind, JSON.stringify(frames)).toBe(false);
    // It grows through the sizes between (by however much the window
    // leaves it: 48px on a narrow one), and its title fades rather than
    // vanishing in the first frame.
    const [first = 0, last = 0] = [grown[0]?.width, grown.at(-1)?.width];
    expect(last - first, JSON.stringify(frames)).toBeGreaterThan(8);
    expect(
      grown.some((frame) => frame.width > first + 1 && frame.width < last - 1),
      JSON.stringify(frames),
    ).toBe(true);
    expect(
      grown.some((frame) => frame.title > 0 && frame.title < 1),
      JSON.stringify(frames),
    ).toBe(true);
    expect(app.getRendererErrors()).toEqual([]);
  });
});

describe("inputs grow by gliding", () => {
  const SHIFT = 8;
  const paletteInput = `$$('textarea[aria-label="Search commands, pages, and more"]').find((el) => !el.closest('[inert]'))`;
  const composerInput = `visibleDock()?.querySelector('[data-composer-input]')`;
  interface Glide {
    before: number;
    frames: { at: number; height: number; scrolled: number; inset: number }[];
    /** The frame's height transitions: begun, finished and cut short. */
    transitions: { ran: number; ended: number; cancelled: number };
  }
  /**
   * The frame's height while a real Shift+Enter adds a line, with how far
   * the input sits from the frame's top edge. A value set by script adds a
   * line too, but only the browser's own newline scrolls to the caret.
   */
  const glide = async (input: string): Promise<Glide> => {
    await run(`
      const input = ${input};
      const frame = input.parentElement;
      input.focus();
      if (input instanceof HTMLTextAreaElement) {
        input.setSelectionRange(input.value.length, input.value.length);
      } else {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      const before = frame.getBoundingClientRect().height;
      const frames = [];
      const transitions = { ran: 0, ended: 0, cancelled: 0 };
      const counted = (field) => (event) => {
        if (event.target === frame && event.propertyName === 'height') transitions[field] += 1;
      };
      const listeners = [['transitionrun', counted('ran')], ['transitionend', counted('ended')], ['transitioncancel', counted('cancelled')]];
      for (const [type, listener] of listeners) frame.addEventListener(type, listener);
      const started = performance.now();
      window.__glide = new Promise((resolve) => {
        const tick = () => {
          const box = frame.getBoundingClientRect();
          frames.push({
            at: Math.round(performance.now() - started),
            height: box.height,
            scrolled: frame.scrollTop,
            inset: input.getBoundingClientRect().top - box.top,
          });
          // Half a second of frames, and on until the glide has ended (a
          // slow renderer can end it late), two seconds at most.
          const elapsed = performance.now() - started;
          if (elapsed < 500 || (transitions.ended === 0 && elapsed < 2000))
            requestAnimationFrame(tick);
          else {
            for (const [type, listener] of listeners) frame.removeEventListener(type, listener);
            resolve({ before, frames, transitions });
          }
        };
        requestAnimationFrame(tick);
      });
      return true;
    `);
    await app.press("Enter", SHIFT);
    return run<Glide>("return window.__glide;");
  };
  const expectGlide = ({ before, frames, transitions }: Glide) => {
    const end = frames.at(-1)?.height ?? 0;
    const trace = JSON.stringify({ before, frames, transitions });
    expect(end, trace).toBeGreaterThan(before);
    // The frame's height transitioned to its end: it glided rather than
    // snapped. Told by the transition itself, not by frames caught midway,
    // which a slow renderer (macOS CI draws without a GPU) can space past
    // its 150 ms. One retargeted as the height settles is cut short for
    // the next, which ends: only an ending counts.
    expect(transitions.ran, trace).toBeGreaterThan(0);
    expect(transitions.ended, trace).toBeGreaterThan(0);
    // The new line is clipped until it has glided into view, never scrolled
    // to: the first line stays on the frame's top edge throughout.
    expect(
      frames.every(
        ({ scrolled, inset }) => scrolled === 0 && Math.abs(inset) < 0.5,
      ),
      trace,
    ).toBe(true);
  };

  it("the palette's input glides taller for a new line, its first line in place", async () => {
    await run(
      `if (!(${paletteInput})) pressKey('p', { metaKey: true }); return true;`,
    );
    await runWait(`return !!(${paletteInput});`, { label: "palette open" });
    await run(`setReactValue(${paletteInput}, 'first line'); return true;`);
    expectGlide(await glide(paletteInput));
    await run(`setReactValue(${paletteInput}, ''); return true;`);
    // Cancelable, as a real key is: the palette takes it, and the chat
    // behind keeps its place.
    await run(`pressKey('Escape'); return true;`);
    await runWait(`return !(${paletteInput});`, { label: "palette closed" });
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("the composer glides taller for a new line the same way", async () => {
    await run(`if (!(${composerInput})) newFloatingChat(); return true;`);
    await runWait(`return !!(${composerInput});`, {
      label: "a chat to type in",
    });
    await run(`setReactValue(${composerInput}, 'first line'); return true;`);
    expectGlide(await glide(composerInput));
    await run(`setReactValue(${composerInput}, ''); return true;`);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
