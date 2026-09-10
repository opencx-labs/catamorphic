import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;

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
            const header = document.querySelector('.workspace-chrome').getBoundingClientRect();
            const toggle = document.querySelector('[aria-label="${rightOpen ? "Collapse" : "Expand"} right sidebar"]');
            if (!toggle) return false;
            const bounds = toggle.getBoundingClientRect();
            return Math.abs(header.right - bounds.right - 12) < 1;
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
});
