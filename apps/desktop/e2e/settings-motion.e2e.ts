import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
const run = <T>(body: string) =>
  app.eval<T>(`(async () => {
  const $ = (selector) => document.querySelector(selector);
  const navigate = (label) => [...document.querySelectorAll('nav[aria-label="Settings categories"] button')]
    .find(button => button.textContent.trim() === label).click();
  ${setReactValueJs}
  ${body}
})()`);

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Settings preview',rootPath:${JSON.stringify(`${app.userDataDir}/settings-preview`)}})`,
  );
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Settings preview')`);
  await run(`$('[aria-label="Settings"]').click()`);
  await app.waitFor(`!!document.querySelector('[data-settings-scroll]')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize', 1300, 900)`);
  await app.waitFor(`innerWidth >= 1200`);
});
afterAll(async () => {
  await app?.stop();
});

it("animates category navigation while preserving the forms and settling at the destination", async () => {
  const motion = await run<{
    duration: number;
    easing: string;
    start: string;
    end: string;
    preserved: boolean;
    top: number;
  }>(`
    const root = $('[data-settings-scroll]');
    const input = $('[aria-label="Search keyboard shortcuts"]');
    root.scrollTop = 0;
    const original = root.animate;
    return new Promise(resolve => {
      root.animate = function(...args) {
        root.animate = original;
        const animation = original.apply(this, args);
        const timing = animation.effect.getTiming();
        const start = getComputedStyle(root).transform;
        animation.finished.then(() => resolve({
          duration: timing.duration, easing: timing.easing, start,
          end: getComputedStyle(root).transform,
          preserved: input === $('[aria-label="Search keyboard shortcuts"]'),
          top: $('#settings-shortcuts').getBoundingClientRect().top - root.getBoundingClientRect().top,
        }));
        return animation;
      };
      navigate('Keyboard shortcuts');
    });
  `);
  expect(motion.duration).toBe(200);
  expect(motion.easing).toBe("cubic-bezier(0.2, 0, 0, 1)");
  expect(motion.start).not.toBe("none");
  expect(motion.end).toBe("none");
  expect(motion.preserved).toBe(true);
  expect(Math.abs(motion.top)).toBeLessThan(12);
});

it("moves filtered shortcut rows, preserves search focus, and recovers from no results", async () => {
  await run(`$('[aria-label="Search keyboard shortcuts"]').focus();`);
  await app.waitFor(
    `document.activeElement?.getAttribute('aria-label') === 'Search keyboard shortcuts'`,
  );
  await app.insertText("floating");
  await app.waitFor(`(() => {
    const rows = [...document.querySelectorAll('[data-shortcut-results] [data-item-id]')];
    return rows.length > 1 && rows.every(row => row.textContent.toLowerCase().includes('floating')) &&
      rows.some(row => row.style.transition.includes('200ms'));
  })()`);
  expect(
    await app.eval(`document.activeElement?.getAttribute('aria-label')`),
  ).toBe("Search keyboard shortcuts");
  await app.insertText(" no matching shortcut");
  await app.waitFor(
    `document.querySelector('[data-shortcut-results] [role=status]')?.textContent.includes('No shortcuts match')`,
  );
  await run(`setReactValue($('[aria-label="Search keyboard shortcuts"]'), '')`);
  await app.waitFor(`document.querySelectorAll('[data-shortcut-results] [data-item-id]').length > 20 &&
    !document.querySelector('[data-shortcut-results] [role=status]')`);
  expect(
    await app.eval(`document.activeElement?.getAttribute('aria-label')`),
  ).toBe("Search keyboard shortcuts");
});

it("honors reduced motion and the last rapid category choice, including the compact selector", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await run(`navigate('Appearance'); navigate('Workspace');`);
    await app.waitFor(
      `document.querySelector('nav[aria-label="Settings categories"] [aria-current]')?.textContent === 'Workspace'`,
    );
    expect(
      await app.eval(
        `document.querySelector('[data-settings-scroll]').getAnimations().length`,
      ),
    ).toBe(0);
    await app.eval(`window.catamorphicDesktop.devWindow('setSize', 900, 600)`);
    await run(`const category = $('[aria-label="Settings category"]');
      category.value = 'shortcuts'; category.dispatchEvent(new Event('change', { bubbles: true }));`);
    await app.waitFor(
      `document.querySelector('[aria-label="Settings category"]').value === 'shortcuts'`,
    );
    await run(
      `setReactValue($('[aria-label="Search keyboard shortcuts"]'), 'floating')`,
    );
    await app.waitFor(`(() => {
      const rows = [...document.querySelectorAll('[data-shortcut-results] [data-item-id]')];
      return rows.length > 1 && rows.every(row => row.textContent.toLowerCase().includes('floating') &&
        !row.style.transform && !row.style.opacity && !row.style.transition);
    })()`);
    expect(
      await app.eval(
        `document.querySelector('[data-settings-scroll]').getAnimations().length`,
      ),
    ).toBe(0);
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});

it.each([1300, 900])(
  "keeps the requested final category selected at window width %i",
  async (width) => {
    await app.eval(
      `window.catamorphicDesktop.devWindow('setSize', ${width}, 600)`,
    );
    await app.waitFor(`(() => {
      const nav = document.querySelector('nav[aria-label="Settings categories"]');
      return (nav.getClientRects().length > 0) === ${width === 1300};
    })()`);
    const headerTop = await run<number>(
      `return $('[data-settings] > header').getBoundingClientRect().top;`,
    );
    for (const id of ["notifications", "import"]) {
      await run(`
        const select = $('[aria-label="Settings category"]');
        const option = [...select.options].find(option => option.value === '${id}');
        if (select.getClientRects().length) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          navigate(option.textContent);
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      `);
      await app.waitFor(`(() => {
        const root = document.querySelector('[data-settings-scroll]');
        return root.scrollTop > 0 && root.getAnimations().length === 0;
      })()`);
      expect(
        await run(`return $('[aria-label="Settings category"]').value;`),
      ).toBe(id);
      expect(
        await run(
          `return $('[data-settings] > header').getBoundingClientRect().top;`,
        ),
      ).toBe(headerTop);
      expect(
        await run(`
          let parent = $('[data-settings-scroll]').parentElement;
          while (parent) {
            if (parent.scrollTop !== 0) return false;
            parent = parent.parentElement;
          }
          return true;
        `),
      ).toBe(true);
    }
  },
);
