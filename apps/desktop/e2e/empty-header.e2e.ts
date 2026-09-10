import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;

const click = async (selector: string) => {
  const target = await app.eval<{
    x: number;
    y: number;
    hit: boolean;
  }>(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return { x, y, hit: button.contains(document.elementFromPoint(x, y)) };
  })()`);
  expect(target.hit).toBe(true);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
  }
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    "!!document.querySelector('[aria-label=\"Expand right sidebar\"]')",
  );
});

afterAll(async () => {
  await app?.stop();
});

describe("empty workspace header", () => {
  it("anchors the right sidebar control to the right edge without a project or tabs", async () => {
    for (const width of [1200, 800]) {
      await app.eval(
        `window.catamorphicDesktop.devWindow('setSize', ${width}, 700)`,
      );
      await app.waitFor(`window.innerWidth === ${width}`);
      for (const leftOpen of [true, false]) {
        await app.eval(`(() => {
          const toggle = document.querySelector('[aria-label="${leftOpen ? "Expand" : "Collapse"} sidebar"]');
          toggle?.click();
        })()`);
        await app.waitFor(
          `document.querySelector('[data-sidebar="left"]')?.getAttribute('aria-hidden') === '${!leftOpen}'`,
        );
        for (const rightOpen of [false, true]) {
          // Wait for the native sidebar layout to settle before hit testing.
          await app.waitFor(`(() => {
            if ([...document.querySelectorAll('[data-sidebar]')].some(sidebar => sidebar.getAnimations().some(animation => animation.playState === 'running'))) return false;
            const header = document.querySelector('.workspace-chrome').getBoundingClientRect();
            const toggle = document.querySelector('[aria-label="${rightOpen ? "Collapse" : "Expand"} right sidebar"]');
            if (!toggle) return false;
            const bounds = toggle.getBoundingClientRect();
            return ${
              rightOpen
                ? "Math.abs(bounds.left - document.querySelector('[data-sidebar=\"right\"]').getBoundingClientRect().left - 8) < 1"
                : "Math.abs(header.right - bounds.right - 12) < 1"
            };
          })()`);
          const target = await app.eval<{
            x: number;
            y: number;
            hit: boolean;
          }>(`(() => {
            const toggle = document.querySelector('[aria-label="${rightOpen ? "Collapse" : "Expand"} right sidebar"]');
            const bounds = toggle.getBoundingClientRect();
            const x = bounds.left + bounds.width / 2;
            const y = bounds.top + bounds.height / 2;
            return {x, y, hit: toggle.contains(document.elementFromPoint(x, y))};
          })()`);
          expect(target.hit).toBe(true);
          for (const type of ["mousePressed", "mouseReleased"]) {
            await app.cdp("Input.dispatchMouseEvent", {
              type,
              x: target.x,
              y: target.y,
              button: "left",
              clickCount: 1,
            });
          }
          await app.waitFor(
            `document.querySelector('[data-sidebar="right"]')?.getAttribute('aria-hidden') === '${rightOpen}'`,
          );
        }
      }
    }
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("centers customization in a projectless sidebar and shares its chat with the left button", async () => {
    await click('[aria-label="Expand right sidebar"]');
    const action = '[data-sidebar="right"] [aria-label="Customize sidebar"]';
    for (const width of [1200, 800]) {
      await app.cdp("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-reduced-motion",
            value: width === 800 ? "reduce" : "no-preference",
          },
        ],
      });
      await app.eval(
        `window.catamorphicDesktop.devWindow('setSize', ${width}, 700)`,
      );
      await app.waitFor(
        `innerWidth === ${width} && [...document.querySelectorAll('[data-sidebar]')].every(e => e.getAnimations().every(a => a.playState !== 'running'))`,
      );
      const centered = await app.eval<boolean>(`(() => {
        const button = document.querySelector(${JSON.stringify(action)});
        const rect = button.getBoundingClientRect(), area = button.parentElement.getBoundingClientRect();
        return Math.abs(rect.left + rect.width / 2 - area.left - area.width / 2) < 1 && Math.abs(rect.top + rect.height / 2 - area.top - area.height / 2) < 1;
      })()`);
      expect(centered).toBe(true);
      await app.screenshot(`/tmp/cat-sidebar-customize-${width}.png`);
    }
    await click(action);
    await app.waitFor(
      `document.querySelector('[data-floating-chat]:not([inert])')?.innerText.includes('Help me customize my right sidebar')`,
      { label: "customization chat from an empty window" },
    );
    const chatId = await app.eval<string>(
      `document.querySelector('[data-floating-chat]:not([inert])').dataset.chatLocalId`,
    );
    await app.screenshot("/tmp/cat-sidebar-customization-chat.png");
    await click(
      `[data-chat-bubble="${chatId}"] button[aria-label^="Minimize"]`,
    );
    await app.waitFor(
      `window.catamorphicDesktop.dockSnapshot().then(s => s.chats.find(c => c.entry.localId === ${JSON.stringify(chatId)})?.entry.mode === 'min')`,
    );
    await click('[aria-label="Expand sidebar"]');
    await app.waitFor(
      `document.querySelector('[data-sidebar="left"]').getAnimations().every(a => a.playState !== 'running')`,
    );
    await click('[data-sidebar="left"] [aria-label="Customize sidebar"]');
    await app.waitFor(
      `document.querySelector('[data-floating-chat]:not([inert])')?.dataset.chatLocalId === ${JSON.stringify(chatId)}`,
      { label: "left customization button restores the same chat" },
    );
    expect(
      await app.eval(`document.querySelectorAll('[data-chat-bubble]').length`),
    ).toBe(1);
    expect(app.getRendererErrors()).toEqual([]);
  });
});
