/* One shot of a themed project: bun scripts/theme-shot.ts <outDir> */
import { launchPwa } from "../e2e/harness.js";

const outDir = process.argv[2] ?? ".";
const app = await launchPwa({ env: { THEME: "midnight" } });
const type = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
await app.eval(type("[data-testid=connect-input]", app.connectLink));
await app.waitFor(
  "!document.querySelector('[data-testid=connect-submit]').disabled",
);
await app.eval(
  "document.querySelector('[data-testid=connect-submit]').click(); true",
);
await app.waitFor("!!document.querySelector('[data-testid=new-chat]')", {
  timeoutMs: 20_000,
});
await app.waitFor(
  "getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() === '#7aa2f7'",
  { timeoutMs: 10_000, label: "midnight accent applied" },
);
await new Promise((resolve) => setTimeout(resolve, 300));
await app.screenshot(`${outDir}/theme-midnight.png`);
console.log(`${outDir}/theme-midnight.png`);
await app.stop();
process.exit(0);
