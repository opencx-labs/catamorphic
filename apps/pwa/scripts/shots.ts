/* Screenshot tour for design review: bun scripts/shots.ts <outDir> */
import { launchPwa } from "../e2e/harness.js";

const outDir = process.argv[2] ?? ".";
const app = await launchPwa();
const shot = async (name: string) => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.screenshot(`${outDir}/${name}.png`);
  console.log(`${outDir}/${name}.png`);
};

const type = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
const click = (selector: string) =>
  `(() => { document.querySelector(${JSON.stringify(selector)})?.click(); return true; })()`;

await shot("1-connect");
await app.eval(type("[data-testid=connect-input]", app.connectLink));
await app.waitFor(
  "!document.querySelector('[data-testid=connect-submit]').disabled",
);
await shot("2-connect-filled");
await app.eval(click("[data-testid=connect-submit]"));
await app.waitFor("!!document.querySelector('[data-testid=new-chat]')", {
  timeoutMs: 20_000,
});
await shot("3-sessions-empty");
await app.eval(click("[data-testid=new-chat]"));
await app.waitFor("!!document.querySelector('[data-testid=chat-input]')");
await shot("4-chat-empty");
await app.eval(type("[data-testid=chat-input]", "Summarize the project"));
await app.eval(click("[data-testid=chat-send]"));
await app.waitFor("document.body.innerText.includes('You said:')", {
  timeoutMs: 20_000,
});
await shot("5-chat-reply");
await app.eval(type("[data-testid=chat-input]", "ask to post"));
await app.eval(click("[data-testid=chat-send]"));
await app.waitFor(
  "!!document.querySelector('[data-testid=tool-permission-card]')",
  { timeoutMs: 20_000 },
);
await shot("6-permission");
await app.eval(click("[data-testid=tool-permission-allow]"));
await app.waitFor("document.body.innerText.includes('Posted the summary')", {
  timeoutMs: 20_000,
});
await app.eval(type("[data-testid=chat-input]", "question time"));
await app.eval(click("[data-testid=chat-send]"));
await app.waitFor("document.body.innerText.includes('Which environment')", {
  timeoutMs: 20_000,
});
await shot("7-question");
await app.eval(click("[data-testid=screen-back]"));
await app.waitFor("!!document.querySelector('[data-testid=new-chat]')");
await shot("8-sessions-list");
await app.eval(click("[data-testid=screen-back]"));
await app.waitFor("!!document.querySelector('[data-testid=project-row]')");
await shot("9-projects");
await app.eval(click("[data-testid=projects-profile]"));
await app.waitFor("!!document.querySelector('[data-testid=profile-row]')");
await shot("10-profiles");
await app.stop();
process.exit(0);
