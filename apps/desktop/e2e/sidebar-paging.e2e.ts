import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";
import { CHATS_SECTION, writeSidebarSections } from "./sidebar-config.js";

/**
 * A Chats section (`work:chats`) reads its first 30 chats, then the next page as the
 * person scrolls toward the end: placeholder rows hold the end while it
 * loads, and the rows arrive in their place.
 */
let app: AppHandle;
const CHATS = 45;
const title = (index: number) => `Paged chat ${String(index).padStart(2, "0")}`;
const chats = `[data-workspace-visible="true"] [data-sidebar-section="chats"]`;
/** The list's scroller; the `role="tree"` inside it holds only the rows. */
const tree = `${chats} [data-tree-viewport]`;
const holding = `${chats} [data-tree-more="placeholder"]:not(.animate-session-row-out)`;
const hasRow = (index: number) =>
  `[...document.querySelectorAll('${chats} [role="treeitem"]')].some(row => row.textContent.includes(${JSON.stringify(title(index))}))`;

beforeAll(async () => {
  app = await launchApp();
  // Pages after the first wait until the test lets them through, so the
  // state between asking and arriving can be seen. The renderer's API
  // client keeps the fetch it started with, hence before the page loads.
  await app.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const original = window.fetch;
      const held = [];
      let holding = true;
      window.__heldSessionPages = () => held.length;
      window.__releaseSessionPages = () => {
        holding = false;
        for (const release of held.splice(0)) release();
      };
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        const page = /\\/agent\\/sessions\\?/.test(url) && /[?&]rootsOnly=true/.test(url);
        if (holding && page && !/[?&]offset=0(&|$)/.test(url))
          return new Promise((resolve, reject) =>
            held.push(() => original(input, init).then(resolve, reject)));
        return original(input, init);
      };
    })()`,
  });
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Paged chats',rootPath:${JSON.stringify(path.join(app.userDataDir, "paged-chats"))}})`,
  );
  const server = await app.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  const base = `${server.url}/api/projects/${project.id}/agent/sessions`;
  for (let index = 0; index < CHATS; index += 1) {
    const response = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title(index), source: "desktop" }),
    });
    expect(response.status).toBe(201);
  }
  await writeSidebarSections(app, [CHATS_SECTION]);
  await app.reload();
  await app.waitFor(hasRow(CHATS - 1), {
    timeoutMs: 60_000,
    label: "the newest chat in the Chats section",
  });
  await app.eval(
    `document.querySelector('${tree}').scrollIntoView({ block: "center" })`,
  );
});

afterAll(async () => {
  await app?.stop();
});

it("loads the next page of chats as the person scrolls to the end", async () => {
  // The first page: 30 rows and the three placeholders after them.
  expect(
    await app.eval(
      `document.querySelector('${tree}').firstElementChild.style.height`,
    ),
  ).toBe(`${(30 + 3) * 28}px`);
  expect(await app.eval(hasRow(0))).toBe(false);
  expect(await app.eval(`window.__heldSessionPages()`)).toBe(0);
  for (let tick = 0; tick < 20; tick += 1) {
    // Sections above can still settle their height: aim at the list itself.
    const point = await app.eval<{ x: number; y: number }>(`(() => {
      const element = document.querySelector('${tree}');
      element.scrollIntoView({ block: "nearest" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: 280,
    });
    await app.eval("new Promise((resolve) => setTimeout(resolve, 100))");
    if (
      await app.eval<boolean>(
        `document.querySelectorAll('${holding}').length === 3`,
      )
    )
      break;
  }
  // Asked for before the end, held there by still placeholders.
  await app.waitFor(`window.__heldSessionPages() === 1`, {
    label: "the next page requested while scrolling",
  });
  await app.waitFor(`document.querySelectorAll('${holding}').length === 3`, {
    label: "placeholders at the end of the list",
  });
  expect(
    await app.eval(
      `document.querySelector('${chats} [role="status"][aria-live="polite"]').textContent`,
    ),
  ).toBe("Loading more in Chats");
  // The header keeps still: the end of the list carries this load.
  expect(
    await app.eval(`!!document.querySelector('${chats} [data-loading-for]')`),
  ).toBe(false);
  await app.screenshot("/tmp/catamorphic-sidebar-paging-placeholders.png");

  await app.eval("window.__releaseSessionPages()");
  // The last page lands: the placeholders leave and the oldest chats arrive.
  await app.waitFor(`document.querySelectorAll('${holding}').length === 0`, {
    label: "placeholders gone once the last page lands",
  });
  const rows =
    Number.parseInt(
      await app.eval<string>(
        `document.querySelector('${tree}').firstElementChild.style.height`,
      ),
      10,
    ) / 28;
  expect(rows).toBeGreaterThanOrEqual(CHATS);
  await app.waitFor(
    `document.querySelector('${chats} [role="status"][aria-live="polite"]').textContent === ${JSON.stringify(`${rows - 30} more in Chats`)}`,
    { label: "the arrival announced" },
  );
  await app.eval(`(() => {
    const element = document.querySelector('${tree}');
    element.scrollTop = element.scrollHeight;
  })()`);
  await app.waitFor(hasRow(0), { label: "the oldest chat in the list" });
  await app.waitFor(
    `document.querySelectorAll('${chats} [data-tree-more]').length === 0`,
    { label: "the faded placeholders removed" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("fades a list's edges where it continues; a thumb only where a section asks", async () => {
  const side = `[data-workspace-visible="true"] [data-sidebar="left"]`;
  const thumb = `${side} .overlay-scrollbar`;
  // No list in the sidebar keeps a scrollbar, or a column for one.
  expect(
    await app.eval<
      string[]
    >(`[...document.querySelectorAll('${side} .sidebar-tab-panel, ${side} .sidebar-tab-panel *')]
      .filter((element) => getComputedStyle(element).scrollbarWidth !== 'none')
      .map((element) => element.className)`),
  ).toEqual([]);
  expect(
    await app.eval<boolean>(`(() => {
      const panel = document.querySelector('${side} .sidebar-tab-panel:not([hidden])');
      return panel.offsetWidth === panel.clientWidth;
    })()`),
  ).toBe(true);
  // Work's lists ask for no thumb: there is none to show.
  expect(await app.eval<boolean>(`!!document.querySelector('${thumb}')`)).toBe(
    false,
  );
  /** How far each edge of the list fades, in pixels. */
  const fades = `(() => {
    const style = getComputedStyle(document.querySelector('${tree}'));
    return [style.getPropertyValue('--cat-edge-fade-top'), style.getPropertyValue('--cat-edge-fade-bottom')];
  })()`;
  /** What the list says about its edges, for a failure to show. */
  const state = () =>
    app.eval(`(() => {
      const list = document.querySelector('${tree}');
      return list && { top: list.scrollTop, room: list.scrollHeight - list.clientHeight, fades: ${fades}, children: [...list.children].map((child) => child.getAttribute('role') ?? Object.keys(child.dataset).join(',')) };
    })()`);
  const fadesAre = (expected: string, label: string) =>
    app
      .waitFor(`(${fades}).join() === '${expected}'`, { label })
      .catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}; list: ${JSON.stringify(await state())}`,
        );
      });
  // At the end of the list: its top fades, its last row does not.
  await app.eval(`(() => {
    const list = document.querySelector('${tree}');
    list.scrollTop = list.scrollHeight;
  })()`);
  await fadesAre("24px,0px", "the top edge fades at the end of the list");
  // A real wheel over the list, aimed where the list is now.
  const wheel = async (deltaY: number) => {
    const point = await app.eval<{ x: number; y: number }>(`(() => {
      const element = document.querySelector('${tree}');
      element.scrollIntoView({ block: "nearest" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY,
    });
  };
  // Partway: both edges have more beyond them.
  await wheel(-200);
  await fadesAre("24px,24px", "both edges fade partway through the list");
  // At its top: only the bottom.
  await app.eval(`document.querySelector('${tree}').scrollTop = 0`);
  await fadesAre(
    "0px,24px",
    "only the bottom edge fades at the top of the list",
  );

  // A section that asks for a thumb shows it on the outer edge, beside the
  // list that moved and no taller than it, only while it moves.
  await writeSidebarSections(app, [{ ...CHATS_SECTION, scrollbar: true }]);
  await app.waitFor(
    `!!document.querySelector('${chats}[data-sidebar-scrollbar]') && !!document.querySelector('${thumb}')`,
    { label: "the thumb for a section that asks for one" },
  );
  await app.waitFor(
    `document.querySelector('${thumb}')?.dataset.shown === 'false' && getComputedStyle(document.querySelector('${thumb}')).opacity === '0'`,
    {
      label: "nothing shows at rest",
    },
  );
  // The layout's change reads the section again: wheel once its rows are
  // back and still, as often as it takes to move the list.
  await app.waitFor(
    `(() => {
      const list = document.querySelector('${tree}');
      return !!list && list.scrollHeight - list.clientHeight > 200 &&
        !list.closest('[aria-busy="true"]') &&
        list.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
    })()`,
    { label: "the list back, at rest" },
  );
  for (let tick = 0; tick < 5; tick += 1) {
    await wheel(200);
    if (
      await app.eval<boolean>(`document.querySelector('${tree}').scrollTop > 0`)
    )
      break;
    await app.eval("new Promise((resolve) => setTimeout(resolve, 300))");
  }
  const shown = await app
    .waitFor<{
      left: number;
      edge: number;
      top: number;
      bottom: number;
      listTop: number;
      listBottom: number;
    }>(
      `document.querySelector('${thumb}').dataset.shown === 'true' && (() => {
      const bar = document.querySelector('${thumb}').getBoundingClientRect();
      const list = document.querySelector('${tree}').getBoundingClientRect();
      const side = document.querySelector('${side} .sidebar-inner').getBoundingClientRect();
      return { left: bar.left, edge: side.left, top: bar.top, bottom: bar.bottom, listTop: list.top, listBottom: list.bottom };
    })()`,
      { label: "the thumb beside the scrolled list" },
    )
    .catch(async (error: unknown) => {
      const thumbState = await app.eval(`(() => {
      const bar = document.querySelector('${thumb}');
      const list = document.querySelector('${tree}');
      const area = bar?.parentElement;
      const rect = (element) => element && [Math.round(element.getBoundingClientRect().top), Math.round(element.getBoundingClientRect().bottom)];
      return { shown: bar?.dataset.shown, style: bar?.getAttribute('style'), list: rect(list), area: rect(area), top: list?.scrollTop, room: list && list.scrollHeight - list.clientHeight, opted: !!list?.closest('[data-sidebar-scrollbar]'), overflow: list && getComputedStyle(list).overflowY };
    })()`);
      throw new Error(`${String(error)}; thumb: ${JSON.stringify(thumbState)}`);
    });
  expect(shown.left - shown.edge).toBeLessThanOrEqual(2);
  expect(shown.top).toBeGreaterThanOrEqual(shown.listTop);
  expect(shown.bottom).toBeLessThanOrEqual(shown.listBottom);
  // A moment after the list is still, it fades away.
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 900,
    y: 400,
  });
  await app.waitFor(
    `document.querySelector('${thumb}').dataset.shown === 'false' && getComputedStyle(document.querySelector('${thumb}')).opacity === '0'`,
    { label: "the thumb faded once the list was still" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
