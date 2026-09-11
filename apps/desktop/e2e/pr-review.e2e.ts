import { APP_PROTOCOL_VERSION } from "@catamorphic/app";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
const helper = `${setReactValueJs}; const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);`;
const run = <T>(body: string) => app.eval<T>(`(()=>{${helper};${body}})()`);
const wait = (body: string) =>
  app.waitFor(`(()=>{${helper};${body}})()`, { timeoutMs: 60000 });

async function verifyReviewTheme(frame: FrameHandle) {
  const original = await app.eval("window.catamorphicDesktop.getTheme()");
  await frame.eval(`(() => {
    ${setReactValueJs}
    document.documentElement.dataset.themeProbe = "mounted";
    setReactValue(document.querySelector('[aria-label="Find in diff"]'), "input");
  })()`);
  try {
    for (const config of [
      { selection: "light", overrides: {} },
      { selection: "dark", overrides: {} },
      {
        selection: "light",
        overrides: {
          bg: "#f5eee3",
          fg: "#28252b",
          accent: "#9b2463",
          success: "#237a42",
          danger: "#a92b36",
        },
      },
    ]) {
      const expected = await app.eval<{
        appearance: string;
        colors: { bg: string; accent: string };
      }>(`window.catamorphicDesktop.setTheme(${JSON.stringify(config)})`);
      await frame.waitFor(
        `getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() === ${JSON.stringify(expected.colors.bg)}`,
      );
      await frame.waitFor(`(() => {
        const host = document.querySelector('diffs-container');
        const root = host?.shadowRoot;
        const keyword = [...(root?.querySelectorAll('[data-line] span') ?? [])].find(e => e.textContent === 'export');
        if (!keyword || !root.querySelector('pre')) return false;
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-accent)'; document.body.append(probe);
        const accent = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(keyword).color === accent &&
          getComputedStyle(root.querySelector('pre')).backgroundColor === getComputedStyle(document.body).backgroundColor &&
          getComputedStyle(host).colorScheme === ${JSON.stringify(expected.appearance)};
      })()`);
      expect(
        await frame.eval(`(() => {
        const host=document.querySelector('diffs-container'), root=host.shadowRoot;
        const color = value => {
          const probe=document.createElement('span'); probe.style.color=value;
          root.append(probe); const result=getComputedStyle(probe).color; probe.remove(); return result;
        };
        return color('var(--diffs-addition-base)') === color('var(--color-success)') &&
          color('var(--diffs-deletion-base)') === color('var(--color-danger)') &&
          getComputedStyle(root.querySelector('[data-line-type="change-addition"]')).backgroundColor !==
          getComputedStyle(root.querySelector('[data-line-type="change-deletion"]')).backgroundColor;
      })()`),
      ).toBe(true);
      expect(
        await frame.eval(`document.documentElement.dataset.themeProbe`),
      ).toBe("mounted");
      expect(
        await frame.eval(
          `document.querySelector('[aria-label="Find in diff"]').value`,
        ),
      ).toBe("input");
      await app.screenshot(
        `/tmp/catamorphic-review-theme-${Object.keys(config.overrides).length ? "custom" : config.selection}.png`,
      );
    }
    // Another embedder can supply a larger type scale and denser/taller rows.
    await app.eval(`(async () => {
      const theme = await window.catamorphicDesktop.getTheme();
      document.querySelector('iframe[src*="/apps/session-"]').contentWindow.postMessage({
        catamorphicApp: ${APP_PROTOCOL_VERSION}, kind: "theme",
        theme: { appearance: theme.appearance, colors: theme.colors, fonts: theme.fonts, baseFontSize: "17px", rowHeight: "36px" },
      }, '*');
    })()`);
    await frame.waitFor(
      `getComputedStyle(document.querySelector('.cat-review')).fontSize === '17px'`,
    );
    expect(
      await frame.eval(
        `getComputedStyle(document.querySelector('[aria-label="Diff layout"]')).minHeight`,
      ),
    ).toBe("36px");
    expect(
      await frame.eval(
        `getComputedStyle(document.querySelector('diffs-container')).fontSize`,
      ),
    ).toBe("17px");
    await app.screenshot("/tmp/catamorphic-review-theme-large.png");

    // A reload starts from the original URL, then receives the current host theme.
    await frame.eval("location.reload()");
    await frame.waitFor(
      `document.querySelector('.cat-review-finding') && getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() === '#f5eee3'`,
    );
    expect(frame.getRendererErrors()).toEqual([]);
  } finally {
    await app.eval(
      `window.catamorphicDesktop.setTheme(${JSON.stringify(original)})`,
    );
  }
}
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
  const errors = app?.getRendererErrors() ?? [];
  await app?.stop();
  expect(errors).toEqual([]);
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

it("generates an ordinary review app, follows evidence and retains the result", {
  timeout: 660_000,
  retry: 0,
}, async () => {
  await run("button('Guide').click();");
  await wait(
    "return !!button('Generate guide') && !button('Generate guide').disabled;",
  );
  await run("button('Generate guide').click();");
  try {
    // A fresh merge-gate cache performs the real dependency install. Match
    // the service's bounded install + compile budget; UI errors fail early.
    await app.waitFor(
      `(()=>{${helper};return !!button('Open review') || !!document.querySelector('[aria-label="Code review guide"] [role="alert"]');})()`,
      { timeoutMs: 630_000, label: "review app build" },
    );
    expect(
      await run(
        "return $('[aria-label=\"Code review guide\"] [role=alert]')?.textContent ?? null;",
      ),
    ).toBeNull();
  } catch (error) {
    console.error(
      "Review readiness",
      await run("return $('[aria-label=\"Code review guide\"]')?.innerText;"),
      app.getOutput().slice(-6000),
    );
    throw error;
  }
  await run("button('Open review').click();");
  await wait(
    `return !!document.querySelector('iframe[src*="/apps/session-"]');`,
  );
  const presentation = await app.eval<{
    title: string;
    icon: string;
  }>(`(async () => {
    const guest = new URL(document.querySelector('iframe[src*="/apps/session-"]').src);
    const response = await fetch(guest.origin + guest.pathname.replace(/\\/guest$/, "/presentation"), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Input guard review", icon: "review" }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  })()`);
  expect(presentation).toMatchObject({
    title: "Input guard review",
    icon: "review",
  });
  await wait(
    `return !!document.querySelector('[data-app-icon="review"]') && document.body.textContent.includes("Input guard review");`,
  );
  const frame = await app.connectToFrame("/apps/session-", {
    timeoutMs: 60000,
  });
  try {
    await frame.waitFor(
      'document.querySelector(".cat-review-finding")?.textContent.includes("Check the boundary")',
    );
    expect(
      await frame.eval(
        `document.querySelectorAll('nav[aria-label="Review view"] button').length`,
      ),
    ).toBe(4);
    await app.screenshot("/tmp/catamorphic-review-guide-e2e.png");
    await frame.eval('document.querySelector(".cat-review-evidence").click()');
    await frame.waitFor('!!document.querySelector("[data-testid=code-diff]")');
    await app.screenshot("/tmp/catamorphic-review-app-diff-e2e.png");
    expect(
      await frame.eval(
        `document.querySelector('[aria-label="Diff layout"]').value`,
      ),
    ).toBe("unified");
    await verifyReviewTheme(frame);
  } catch (error) {
    console.error(
      "Review guest errors",
      frame.getRendererErrors(),
      await frame.eval('document.getElementById("root")?.innerHTML'),
    );
    await app.screenshot("/tmp/catamorphic-review-guest-failure.png");
    throw error;
  } finally {
    frame.close();
  }
  await run(
    `document.querySelector('[data-point-key^="diff:"] button').click();`,
  );
  await wait("return !!button('Guide');");
  await run("button('Guide').click();");
  await wait("return !!button('Update review');");
  await run("button('Changes').click();");
  await wait("return !!$('[data-testid=code-diff]');");
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
