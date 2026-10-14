import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * A tab's close button in the horizontal strip takes no room (DESIGN.md,
 * "A tab's close button shows on hover"): a tab is as wide as its icon and
 * title, and the button rides over the label's end while the tab is hovered
 * or holds keyboard focus, fading and growing in place on one reversible
 * transition. Hover is the OS pointer's (`app.movePointer`), so Chromium's
 * own hit testing decides it.
 */
let app: AppHandle;
const mac = process.platform === "darwin";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const helpers = `
  ${setReactValueJs}
  const $ = (selector) => document.querySelector(selector);
  const strip = () => $('[data-tab-orientation="horizontal"]');
  const tabs = () => [...strip().querySelectorAll('[data-point-key]')].filter((tab) => !tab.getAttribute('aria-hidden'));
  const tabByTitle = (title) => tabs().find((tab) => tab.textContent.includes(title));
  const labelOf = (tab) => tab.querySelector('button:not([aria-label^="Close"])');
  const closeOf = (tab) => tab.querySelector('.workspace-tab-close');
  const titleOf = (tab) => tab.querySelector('.workspace-tab-title');
  const shown = (tab) => {
    const style = getComputedStyle(closeOf(tab));
    return { opacity: Number(style.opacity), scale: style.scale, events: style.pointerEvents };
  };
  /** Everything in the strip a change of the close button could move. */
  const layout = () => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 100) / 100);
    };
    return JSON.stringify({
      strip: box(strip()),
      scroll: strip().scrollWidth,
      tabs: tabs().map((tab) => [box(tab), box(labelOf(tab)), box(titleOf(tab))]),
      plus: box($('button[aria-label="New tab"]')),
      room: box($('[data-tab-strip-room="end"]')),
    });
  };
  /** Per-frame samples of the layout and one tab's button, for ms. */
  const sample = (title, ms) => {
    window.__tabFrames = undefined;
    const frames = [];
    const started = performance.now();
    const tick = () => {
      const tab = tabByTitle(title);
      frames.push({ t: Math.round(performance.now() - started), layout: layout(), ...shown(tab),
        titleEnd: getComputedStyle(titleOf(tab)).getPropertyValue('--tab-title-end').trim() });
      if (performance.now() - started < ms) requestAnimationFrame(tick);
      else window.__tabFrames = frames;
    };
    requestAnimationFrame(tick);
    return true;
  };
  const settled = () => tabs().every((tab) =>
    closeOf(tab).getAnimations().length === 0 && titleOf(tab).getAnimations().length === 0);
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

interface Frame {
  t: number;
  layout: string;
  opacity: number;
  scale: string;
  events: string;
  titleEnd: string;
}
const frames = () =>
  app.waitFor<Frame[]>("window.__tabFrames", { label: "frames sampled" });
const center = (selector: string) =>
  run<{ x: number; y: number }>(`
    const rect = (${selector}).getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  `);
/** The sidebar's empty middle, away from the strip and the page. */
const away = { x: 130, y: 500 };
const rest = async () => {
  await app.movePointer(away);
  await runWait(
    "return settled() && tabs().every((tab) => shown(tab).opacity === 0);",
    {
      label: "every close button hidden",
    },
  );
};
const transparent = (color: string) =>
  color === "transparent" || /rgba\(0, 0, 0, 0\)/.test(color);

const openPage = async (title: string) => {
  // Browser tabs only: an untouched New Tab closes as another tab shows.
  const pages = `tabs().filter((tab) => tab.dataset.pointKey.startsWith('browser:')).length`;
  const before = await run<number>(`return ${pages};`);
  await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 't', bubbles: true, cancelable: true, altKey: true,
    ...(${mac} ? { metaKey: true } : { ctrlKey: true }),
  })); true`);
  const address = `[...document.querySelectorAll('input[aria-label="Address and search bar"]')].find((input) => input.checkVisibility({ visibilityProperty: true }) && input.value === '')`;
  await runWait(`return ${pages} === ${before + 1} && !!${address};`, {
    timeoutMs: 30_000,
    label: `a browser tab for ${title}`,
  });
  await run(`
    const input = ${address};
    input.focus();
    setReactValue(input, ${JSON.stringify(`data:text/html,<title>${title}</title><h1>${title}</h1>`)});
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  `);
  await runWait(`return !!tabByTitle(${JSON.stringify(title)});`, {
    timeoutMs: 30_000,
    label: title,
  });
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Create or import project')",
  );
  await run(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create or import project').click(); return true;",
  );
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Tabs'); return true;",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click(); return true;");
  await runWait("return !!strip() && tabs().length >= 1;", {
    timeoutMs: 60_000,
    label: "workspace ready",
  });
  for (const title of [
    "Launch plan",
    "Design review notes for the October release",
    "Inbox",
  ])
    await openPage(title);
  // The startup New Tab has gone, so the strip holds the three pages.
  await runWait("return tabs().length === 3 && settled();", {
    label: "three pages",
  });
});

afterAll(async () => {
  await app?.stop();
});

describe("a tab's close button", () => {
  it("takes no room: a tab is as wide as its icon and title", async () => {
    const tabs = await run<
      {
        width: number;
        label: number;
        trailing: number;
        position: string;
        button: number;
      }[]
    >(`
      return tabs().map((tab) => {
        const rect = tab.getBoundingClientRect();
        return {
          width: rect.width,
          label: labelOf(tab).getBoundingClientRect().width,
          trailing: rect.right - titleOf(tab).getBoundingClientRect().right,
          position: getComputedStyle(closeOf(tab)).position,
          button: closeOf(tab).querySelector('button').offsetWidth,
        };
      });
    `);
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.position).toBe("absolute");
      expect(tab.button).toBe(20);
      // The label fills the tab inside its border, so a press anywhere on
      // the tab opens it; a reserved button made the tab 20px wider.
      expect(tab.width - tab.label).toBeCloseTo(2, 1);
      // After the title: the label's padding and the tab's border.
      expect(tab.trailing).toBeCloseTo(11, 1);
    }
    // The longest title stops at 160px, so the widest tab is 202px.
    expect(Math.max(...tabs.map((tab) => tab.width))).toBeCloseTo(202, 1);
  });

  it("moves on one micro-feedback transition with the standard easing", async () => {
    const transitions = await run<
      { property: string; duration: string; easing: string }[]
    >(`
      return [closeOf(tabs()[0]), titleOf(tabs()[0])].map((element) => {
        const style = getComputedStyle(element);
        return {
          property: style.transitionProperty,
          duration: style.transitionDuration,
          easing: style.transitionTimingFunction,
        };
      });
    `);
    expect(transitions.map((transition) => transition.property)).toEqual([
      "opacity, scale",
      "--tab-title-end",
    ]);
    for (const transition of transitions) {
      expect(
        new Set(transition.duration.split(",").map((value) => value.trim())),
      ).toEqual(new Set(["0.15s"]));
      expect(
        new Set(transition.easing.match(/cubic-bezier\([^)]*\)|[a-z-]+/g)),
      ).toEqual(new Set(["cubic-bezier(0.2, 0, 0, 1)"]));
    }
  });

  it("is hidden at rest, the tab in front's too, and lets presses through", async () => {
    await rest();
    const atRest = await run<
      { active: boolean; opacity: number; events: string; hit: boolean }[]
    >(`
      return tabs().map((tab) => {
        const rect = closeOf(tab).querySelector('button').getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          active: tab.hasAttribute('data-tab-active'),
          opacity: shown(tab).opacity,
          events: shown(tab).events,
          hit: labelOf(tab).contains(hit),
        };
      });
    `);
    expect(atRest.filter((tab) => tab.active)).toHaveLength(1);
    for (const tab of atRest) {
      expect(tab.opacity).toBe(0);
      expect(tab.events).toBe("none");
      expect(tab.hit).toBe(true);
    }
  });

  it("fades and grows in on hover while nothing in the strip moves", async () => {
    await rest();
    await run("return sample('Launch plan', 700);");
    await app.movePointer(await center("labelOf(tabByTitle('Launch plan'))"));
    const sampled = await frames();
    const first = sampled[0];
    const last = sampled.at(-1);
    expect(first?.opacity).toBe(0);
    expect(last?.opacity).toBe(1);
    expect(last?.scale).toBe("1");
    expect(last?.events).toBe("auto");
    expect(transparent(last?.titleEnd ?? "")).toBe(true);
    // It appears over frames, never all at once, and never turns back.
    const between = sampled.filter(
      (frame) => frame.opacity > 0 && frame.opacity < 1,
    );
    expect(between.length).toBeGreaterThan(0);
    expect(
      between.some(
        (frame) => Number(frame.scale) > 0.8 && Number(frame.scale) < 1,
      ),
    ).toBe(true);
    for (let index = 1; index < sampled.length; index += 1)
      expect(sampled[index]?.opacity ?? 0).toBeGreaterThanOrEqual(
        sampled[index - 1]?.opacity ?? 0,
      );
    // Takeable the moment it starts to show.
    expect(
      sampled.filter((frame) => frame.opacity > 0).map((frame) => frame.events),
    ).not.toContain("none");
    for (const frame of sampled) expect(frame.layout).toBe(first?.layout);
    // Only the hovered tab's button shows.
    expect(
      await run<number[]>(
        "return tabs().filter((tab) => !tab.textContent.includes('Launch plan')).map((tab) => shown(tab).opacity);",
      ),
    ).toEqual([0, 0]);
  });

  it("leaves as it arrived when the pointer goes", async () => {
    await runWait(
      "return settled() && shown(tabByTitle('Launch plan')).opacity === 1;",
      {
        label: "shown",
      },
    );
    await run("return sample('Launch plan', 700);");
    await app.movePointer(away);
    const sampled = await frames();
    const first = sampled[0];
    expect(first?.opacity).toBe(1);
    expect(sampled.at(-1)?.opacity).toBe(0);
    expect(sampled.at(-1)?.scale).toBe("0.8");
    expect(
      sampled.filter((frame) => frame.opacity > 0 && frame.opacity < 1).length,
    ).toBeGreaterThan(0);
    for (let index = 1; index < sampled.length; index += 1)
      expect(sampled[index]?.opacity ?? 1).toBeLessThanOrEqual(
        sampled[index - 1]?.opacity ?? 1,
      );
    for (const frame of sampled) expect(frame.layout).toBe(first?.layout);
  });

  it("leaves none showing after a quick sweep across the strip", async () => {
    await rest();
    const ends = await run<{ from: number; to: number; y: number }>(`
      const all = tabs().map((tab) => tab.getBoundingClientRect());
      return { from: Math.round(all[0].left + 4), to: Math.round(all.at(-1).right - 4), y: Math.round(all[0].top + all[0].height / 2) };
    `);
    await run("return sample('Inbox', 600);");
    const points: { x: number; y: number }[] = [];
    for (let x = ends.to; x >= ends.from; x -= 12)
      points.push({ x, y: ends.y });
    points.push(away);
    await app.movePointerThrough(points);
    const sampled = await frames();
    for (const frame of sampled) expect(frame.layout).toBe(sampled[0]?.layout);
    await sleep(300);
    await runWait(
      "return settled() && tabs().every((tab) => shown(tab).opacity === 0);",
      {
        label: "every close button hidden after the sweep",
      },
    );
  });

  it("shows for keyboard focus within the tab and is reached by Tab", async () => {
    await rest();
    await run("labelOf(tabByTitle('Launch plan')).focus(); return true;");
    await app.press("Tab");
    expect(
      await run<string | null>(
        "return document.activeElement?.getAttribute('aria-label') ?? null;",
      ),
    ).toBe("Close Launch plan");
    await runWait(
      "return settled() && shown(tabByTitle('Launch plan')).opacity === 1;",
      {
        label: "focused tab's button shown",
      },
    );
    // Back to the tab's label: focus is still within the tab.
    await app.press("Tab", 8);
    await runWait(
      "return document.activeElement === labelOf(tabByTitle('Launch plan')) && settled() && shown(tabByTitle('Launch plan')).opacity === 1;",
      { label: "still shown with the label focused" },
    );
    await run("document.activeElement.blur(); return true;");
    await runWait(
      "return settled() && shown(tabByTitle('Launch plan')).opacity === 0;",
      {
        label: "hidden once focus leaves",
      },
    );
  });

  it("hides while a tab is dragged", async () => {
    await app.movePointer(await center("labelOf(tabByTitle('Inbox'))"));
    await runWait(
      "return settled() && shown(tabByTitle('Inbox')).opacity === 1;",
      {
        label: "hovered",
      },
    );
    await run(`
      window.__tabDrag = new DataTransfer();
      tabByTitle('Inbox').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__tabDrag }));
      return true;
    `);
    await runWait(
      "return strip().hasAttribute('data-tab-dragging') && settled() && shown(tabByTitle('Inbox')).opacity === 0 && shown(tabByTitle('Inbox')).events === 'none';",
      { label: "hidden while dragging" },
    );
    await run(`
      tabByTitle('Inbox').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      delete window.__tabDrag;
      return true;
    `);
    await runWait(
      "return !strip().hasAttribute('data-tab-dragging') && settled() && shown(tabByTitle('Inbox')).opacity === 1;",
      { label: "shown again after the drag" },
    );
  });

  it("appears at once under reduced motion", async () => {
    await rest();
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await run("return sample('Launch plan', 400);");
      await app.movePointer(await center("labelOf(tabByTitle('Launch plan'))"));
      const sampled = await frames();
      expect(sampled.at(-1)?.opacity).toBe(1);
      expect(
        sampled.filter((frame) => frame.opacity > 0 && frame.opacity < 1),
      ).toEqual([]);
    } finally {
      await app.cdp("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("stays on the tab in front where nothing can hover", async () => {
    await rest();
    await app.cdp("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    try {
      await runWait("return matchMedia('(hover: none)').matches;", {
        label: "no hover",
      });
      await runWait(
        "return settled() && tabs().every((tab) => shown(tab).opacity === (tab.hasAttribute('data-tab-active') ? 1 : 0));",
        { label: "only the active tab's button shown" },
      );
    } finally {
      await app.cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    await rest();
  });

  it("closes its tab with a real click", async () => {
    const title = "Design review notes for the October release";
    await app.movePointer(
      await center(`labelOf(tabByTitle(${JSON.stringify(title)}))`),
    );
    await runWait(
      `return shown(tabByTitle(${JSON.stringify(title)})).events === 'auto';`,
      {
        label: "hovered",
      },
    );
    await app.clickPointer(
      await center(
        `closeOf(tabByTitle(${JSON.stringify(title)})).querySelector('button')`,
      ),
    );
    await runWait(
      `return tabs().length === 2 && !tabByTitle(${JSON.stringify(title)});`,
      { label: "tab closed" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});

describe("a tab in the strip", () => {
  /**
   * The whole tab is its press target, as in Chrome: a real click near any
   * edge of a tab, inside its border, brings it to the front. Only the
   * middle of the label used to take one, so a click on most of the tab,
   * which lit up on hover, did nothing.
   */
  it("opens with a real click anywhere inside its border", async () => {
    const titles = ["Launch plan", "Inbox"];
    // The closed tab has left the strip, so nothing in it still slides.
    await runWait(
      "return strip().querySelectorAll('[data-point-key]').length === 2;",
      { label: "the closed tab gone" },
    );
    const spots: Record<string, string> = {
      top: "{ x: rect.left + rect.width / 2, y: rect.top + 3 }",
      bottom: "{ x: rect.left + rect.width / 2, y: rect.bottom - 3 }",
      start: "{ x: rect.left + 3, y: rect.top + rect.height / 2 }",
      end: "{ x: rect.right - 3, y: rect.top + rect.height / 2 }",
    };
    for (const [spot, point] of Object.entries(spots)) {
      for (const [index, title] of titles.entries()) {
        const other = JSON.stringify(titles[1 - index]);
        await run(`labelOf(tabByTitle(${other})).click(); return true;`);
        await runWait(
          `return tabByTitle(${other}).hasAttribute('data-tab-active');`,
          { label: `${titles[1 - index]} in front` },
        );
        const at = await run<{ x: number; y: number }>(`
          const rect = tabByTitle(${JSON.stringify(title)}).getBoundingClientRect();
          return ${point};
        `);
        await app.clickPointer(at);
        await runWait(
          `return tabByTitle(${JSON.stringify(title)}).hasAttribute('data-tab-active');`,
          { label: `${title} opened by a click at its ${spot}` },
        );
      }
    }
    expect(app.getRendererErrors()).toEqual([]);
  });
});
