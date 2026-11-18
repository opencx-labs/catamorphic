import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  launchApp,
  openProjectSwitcher,
  setReactValueJs,
  waitForProjectWorkspace,
} from "./harness.js";

/**
 * A new project's workspace says it is ready (data-workspace-ready) only
 * once it is laid out as it will stay: its sidebars in the pose the
 * person's preferences give them, not sliding there afterwards. The dock is
 * centred on the content, so a sidebar sliding open after "ready" carried
 * the dock's + from under a press made at ready (dock-modes, floating-hover).
 * The preferences are read slowly here, as on a loaded machine.
 */

let app: AppHandle;

beforeAll(async () => {
  app = await launchApp({
    env: { CATAMORPHIC_E2E_PREFS_READ_DELAY_MS: "1500" },
  });
  await openProjectSwitcher(app);
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

it("reports a new project ready only once its sidebar and dock are where they stay", async () => {
  // Every frame from before the project exists: where the dock's + and the
  // visible workspace's left sidebar are, and whether it says it is ready.
  await app.eval(`(() => {
    window.__reveal = [];
    const start = performance.now();
    const sample = () => {
      const plus = document.querySelector('[data-dock-rail] button[aria-label="New chat"]');
      const workspace = document.querySelector('[data-project-runtime][data-workspace-visible="true"]');
      const sidebar = workspace?.querySelector('[data-sidebar="left"]');
      window.__reveal.push({
        t: Math.round(performance.now() - start),
        project: workspace?.dataset.projectRuntime ?? null,
        ready: !!workspace?.querySelector('[data-workspace-ready]'),
        plus: plus ? Math.round(plus.getBoundingClientRect().left) : null,
        sidebar: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
      });
      if (performance.now() - start < 30000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`);
  await app.waitFor(
    `(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent?.includes('New project') && !el.closest('[inert]'));
      if (!button) return false;
      button.click();
      return true;
    })()`,
    { timeoutMs: 60_000, label: "New project" },
  );
  await app.waitFor(
    `(() => { ${setReactValueJs}
      const input = document.querySelector('[data-testid="project-name-input"]');
      if (!input) return false;
      setReactValue(input, 'reveal-e2e');
      return true;
    })()`,
    { label: "project name input" },
  );
  await app.waitFor(
    `(() => {
      const create = document.querySelector('[data-testid="project-submit"]');
      if (!create || create.disabled) return false;
      create.click();
      return true;
    })()`,
    { label: "create project" },
  );
  const projectId = await waitForProjectWorkspace({ app, name: "reveal-e2e" });
  // Watch past the slow read and a sidebar's slide after it.
  await app.waitFor(
    `(() => {
      const samples = window.__reveal.filter(s => s.project === ${JSON.stringify(projectId)} && s.ready);
      return samples.length > 0 && window.__reveal.at(-1).t - samples[0].t > 2500;
    })()`,
    { label: "2.5s watched since the new project said it was ready" },
  );
  const samples = await app.eval<
    {
      t: number;
      project: string | null;
      ready: boolean;
      plus: number | null;
      sidebar: number | null;
    }[]
  >(
    `window.__reveal.filter(s => s.project === ${JSON.stringify(projectId)} && s.ready)`,
  );
  const first = samples[0];
  const moved = samples.filter(
    (sample) =>
      sample.plus !== first?.plus || sample.sidebar !== first?.sidebar,
  );
  expect(
    moved.slice(0, 5),
    `ready at ${first?.t}ms with the + at ${first?.plus} and the sidebar ${first?.sidebar}px wide`,
  ).toEqual([]);
  expect(first?.sidebar).toBeGreaterThan(0);
});
