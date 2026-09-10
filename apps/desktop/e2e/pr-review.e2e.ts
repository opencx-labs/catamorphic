import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
const helper = `${setReactValueJs}; const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);`;
const run = <T>(body: string) => app.eval<T>(`(()=>{${helper};${body}})()`);
const wait = (body: string) =>
  app.waitFor(`(()=>{${helper};${body}})()`, { timeoutMs: 60000 });
beforeAll(async () => {
  app = await launchApp({ env: { CATAMORPHIC_E2E_REVIEW: "1" } });
  await wait("return !!button('New project');");
  await run("button('New project').click();");
  await wait("return !!$('[data-testid=project-name-input]');");
  await run(
    "setReactValue($('[data-testid=project-name-input]'), 'Review fixture');",
  );
  await wait("return !$('[data-testid=project-submit]').disabled;");
  await run("$('[data-testid=project-submit]').click();");
  await wait(
    "return !!$('[data-sidebar=right] [role=tab][aria-label=\"Pull requests\"]');",
  );
  await run(
    "$('[data-sidebar=right] [role=tab][aria-label=\"Pull requests\"]').click();",
  );
  await wait(
    "return [...document.querySelectorAll('[data-sidebar=right] button')].some(b=>b.textContent.includes('Validate input before processing'));",
  );
  await run(
    "[...document.querySelectorAll('[data-sidebar=right] button')].find(b=>b.textContent.includes('Validate input before processing')).click();",
  );
  await wait("return !!$('[aria-label=\"Pull request details\"]');");
});
afterAll(async () => {
  await app?.stop();
});

it("shows real-shaped CI and people context without expanding files in the workspace sidebar", async () => {
  const text = await run<string>(
    "return $('[aria-label=\"Pull request details\"]').textContent;",
  );
  expect(text).toContain("Unit tests");
  expect(text).toContain("failure");
  expect(text).toContain("owner");
  expect(
    await run(
      "return $('[data-sidebar=right]').textContent.includes('src/guard.ts');",
    ),
  ).toBe(false);
  await app.screenshot("/tmp/catamorphic-review-overview-e2e.png");
});

it("generates a guide, follows its code link, and preserves it when revisiting", async () => {
  await run("button('Guide').click();");
  await wait(
    "return !!button('Generate guide') && !button('Generate guide').disabled;",
  );
  await run("button('Generate guide').click();");
  await wait("return !!button('input guard');");
  await wait(
    "return document.querySelectorAll('[aria-label=\"Guide sections\"] a').length === 2;",
  );
  await run(
    "document.querySelectorAll('[aria-label=\"Guide sections\"] a')[1].click();",
  );
  expect(
    await run(
      "return document.activeElement?.tagName === 'H2' && document.activeElement.textContent === 'Check the boundary';",
    ),
  ).toBe(true);
  await app.screenshot("/tmp/catamorphic-review-guide-e2e.png");
  await run("button('input guard').click();");
  await wait("return !!$('[data-testid=code-diff]');");
  await run("button('Guide').click();");
  await wait("return !!button('input guard');");
  expect(await run("return !!button('Regenerate');")).toBe(true);
  await run("button('input guard').click();");
});

it("navigates between a file and its thread without losing the parent reply", async () => {
  await wait("return !!button('Comments · 2');");
  await run("button('Comments · 2').click();");
  await wait(
    "return document.body.textContent.includes('The guard rejects it.');",
  );
  expect(
    await run(
      "return document.querySelectorAll('[aria-label=\"Pull request review\"] article').length;",
    ),
  ).toBe(1);
  expect(
    await run(
      "return $('[aria-label=\"Pull request review\"]').textContent.includes('Build report');",
    ),
  ).toBe(false);
  await run("button('Open file in Changes').click();");
  await wait("return !!button('Comments · 2');");
  await run("button('Discussion').click();");
  await wait("return !!button('Read full comment');");
  await app.screenshot("/tmp/catamorphic-review-discussion-e2e.png");
  await run("button('Read full comment').click();");
  expect(await run("return !!button('Show less');")).toBe(true);
});

it("keeps local drafts and posts comments and inline replies through the isolated fixture", async () => {
  await run(
    "setReactValue($('textarea[aria-label=Comment]'), 'A conversation comment');",
  );
  await run("button('Changes').click();");
  await run("button('Discussion').click();");
  await wait(
    "return $('textarea[aria-label=Comment]')?.value === 'A conversation comment';",
  );
  await run("$('[aria-label=\"New pull request comment\"]').requestSubmit();");
  await wait(
    "return $('[aria-label=\"Comment threads\"]').textContent.includes('A conversation comment');",
  );
  await run("button('Leave a reply…').click();");
  await run(
    "setReactValue($('textarea[aria-label=Reply]'), 'Verified the empty input boundary');",
  );
  await run("$('[aria-label=\"Reply to code thread\"]').requestSubmit();");
  await wait(
    "return $('[aria-label=\"Comment threads\"]').textContent.includes('Verified the empty input boundary');",
  );
  await run("button('Refresh').click();");
  await wait(
    "return $('[aria-label=\"Comment threads\"]')?.textContent.includes('Verified the empty input boundary');",
  );
  expect(
    await run(
      "return $('[aria-label=\"Comment threads\"]').textContent.includes('A conversation comment');",
    ),
  ).toBe(true);
  await run(
    "const area=$('[aria-label=\"Comment threads\"]');area.scrollTop=area.scrollHeight;",
  );
  await app.screenshot("/tmp/catamorphic-review-discussion-e2e.png");
});

it("virtualizes a large file tree and keeps the current file visible", async () => {
  await run("button('Changes').click();");
  await wait("return !!button('Files · 241');");
  await run("button('Files · 241').click();");
  await wait("return !!$('[aria-label=\"Changed file tree\"]');");
  expect(
    await run<number>(
      "return $('[aria-label=\"Changed file tree\"]').querySelectorAll('button').length;",
    ),
  ).toBeLessThan(241);
  expect(
    await run(
      "return !!$('[aria-label=\"Changed file tree\"] [aria-current]');",
    ),
  ).toBe(true);
  await app.screenshot("/tmp/catamorphic-review-changes-e2e.png");
});

it("keeps review context reachable and avoids horizontal overflow in a narrow window", async () => {
  await run(
    "[...document.querySelectorAll('summary')].find(e=>e.textContent.trim()==='Review details').click();",
  );
  expect(
    await run(
      "return $('[aria-label=\"Review status and people\"]').getBoundingClientRect().height > 0;",
    ),
  ).toBe(true);
  await run(
    "[...document.querySelectorAll('summary')].find(e=>e.textContent.trim()==='Review details').click();",
  );
  await app.eval("window.catamorphicDesktop.devWindow('setSize', 1000, 700)");
  await wait("return window.innerWidth <= 1000;");
  await app.screenshot("/tmp/catamorphic-review-narrow-e2e.png");
  expect(
    await run(
      "const root=$('[aria-label=\"Pull request review\"]');return root.scrollWidth <= root.clientWidth;",
    ),
  ).toBe(true);
  await run("$('[aria-label=\"Changed file tree\"] [aria-current]').click();");
  await wait("return !$('[aria-label=\"Changed file tree\"]');");
  await app.screenshot("/tmp/catamorphic-review-narrow-e2e.png");
});
