import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Opened by the person, a sidebar takes keyboard focus to the row of what is
 * in front; the arrows go on from there, past one list into the next, and
 * the keyboard's ring is one box on the focused row's own (indented) box
 * that glides from row to row (the app kit tree's data-tree-focus).
 */
let app: AppHandle;
const left = `[data-workspace-visible="true"] [data-sidebar="left"]`;
const files = `${left} [data-sidebar-section="files"]`;
/** Cmd on macOS, Ctrl elsewhere, as CDP modifiers. */
const command = process.platform === "darwin" ? 4 : 2;

/** The focused row, the ring and how they sit, from the page. */
const focus = `(() => {
  const active = document.activeElement;
  const row = active?.closest('[data-tree-id]');
  const ring = row?.closest('[role="tree"]')?.querySelector('[data-tree-focus]');
  const box = (element) => element && element.getBoundingClientRect().toJSON();
  return {
    id: row?.dataset.treeId ?? null,
    section: row?.closest('[data-sidebar-section]')?.dataset.sidebarSection ?? null,
    row: box(row),
    ring: box(ring),
    glide: ring?.hasAttribute('data-glide') ?? false,
    style: ring ? getComputedStyle(ring).outlineStyle : null,
    offset: ring ? getComputedStyle(ring).outlineOffset : null,
    width: ring ? getComputedStyle(ring).outlineWidth : null,
  };
})()`;
type Box = { left: number; top: number; right: number; bottom: number };
type Focus = {
  id: string | null;
  section: string | null;
  row: Box | null;
  ring: Box | null;
  glide: boolean;
  style: string | null;
  offset: string | null;
  width: string | null;
};
/** A real press on a chrome button, once it has stopped moving. */
const pressButton = async (label: string) => {
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => {
      // The one a press reaches: shown, not inert, nothing over it.
      const button = [...document.querySelectorAll('[data-workspace-visible="true"] button[aria-label="${label}"]')].find((b) => {
        if (b.closest('[inert]') || !b.checkVisibility()) return false;
        const r = b.getBoundingClientRect();
        return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      if (!button) return false;
      const r = button.getBoundingClientRect();
      const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const still = window.__pressAt?.x === at.x && window.__pressAt?.y === at.y;
      window.__pressAt = at;
      return still && at;
    })()`,
    { label },
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await app.cdp("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
};
const closeSidebar = async () => {
  await pressButton("Collapse sidebar");
  await app.waitFor(
    `document.querySelector('${left}')?.dataset.motion === 'closed'`,
    {
      label: "the sidebar closed",
    },
  );
  // The editor in front keeps Cmd+B (bold) for itself.
  await app.eval("document.activeElement?.blur()");
};

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const root = path.join(app.userDataDir, "sidebar-focus");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  for (const name of ["a", "b", "c"])
    fs.writeFileSync(path.join(root, "notes", `${name}.txt`), `${name}\n`);
  fs.writeFileSync(path.join(root, "readme.txt"), "readme\n");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Sidebar focus',rootPath:${JSON.stringify(root)},importExisting:true}).then((project) => window.catamorphicDesktop.workspaceNavigate({ projectId: project.id }))`,
  );
  await app.waitFor(
    `!!document.querySelector('${files} button[aria-expanded]')`,
    {
      timeoutMs: 60_000,
      label: "the Files section",
    },
  );
  await app.eval(`(() => {
    const header = document.querySelector('${files} button[aria-expanded]');
    if (header.getAttribute('aria-expanded') === 'false') header.click();
  })()`);
  await app.waitFor(
    `(() => { const open = document.querySelector('${files} [aria-label="Expand notes"]'); open?.click(); return !!document.querySelector('${files} [data-tree-id="notes/b.txt"]'); })()`,
    { label: "notes listed" },
  );
  // A file opened from the list is what is in front.
  await app.eval(
    `document.querySelector('${files} [data-tree-id="notes/b.txt"] [data-tree-primary]').click()`,
  );
  await app.waitFor(
    `document.querySelector('${files} [data-tree-id="notes/b.txt"]')?.getAttribute('aria-selected') === 'true'`,
    { label: "the open file's row in front" },
  );
  // Selection precedes the lazy editor's read and Monaco mount. Its final
  // initial focus must land before the keyboard handoff is what we measure.
  await app.waitFor(
    `!!document.activeElement?.closest('.monaco-editor') &&
      document.querySelector('[data-workspace-visible="true"] [data-editor-toolbar]')?.textContent.includes('notes/b.txt')`,
    { label: "the selected file's editor mounted and initially focused" },
  );
});
afterAll(async () => {
  await app?.stop();
});

it("opened by a shortcut, focuses the row of what is in front with the ring on its own box", async () => {
  await closeSidebar();
  await app.press("b", command);
  const landed = await app.waitFor<Focus>(
    `(() => { const state = ${focus}; return state.id === 'notes/b.txt' && state.ring && state; })()`,
    { label: "focus on the open file's row" },
  );
  // The ring arrives at once and shows: the keyboard opened the sidebar.
  expect(landed.style).toBe("solid");
  expect(landed.glide).toBe(false);
  // Measured once the panel has stopped sliding.
  await app.waitFor(
    `document.querySelector('${left}')?.dataset.motion === 'open'`,
    {
      label: "the sidebar open",
    },
  );
  const still = await app.eval<Focus>(focus);
  // Exactly the row's box (indented one level), its line wholly inside.
  for (const side of ["left", "top", "right", "bottom"] as const)
    expect(
      Math.abs((still.ring?.[side] ?? 0) - (still.row?.[side] ?? 0)),
    ).toBeLessThan(0.5);
  expect(still.offset).toBe(`-${still.width}`);
  // A child sits one indent in from its folder.
  const indent = await app.eval<number>(
    `document.querySelector('${files} [data-tree-id="notes/b.txt"]').getBoundingClientRect().left - document.querySelector('${files} [data-tree-id="notes"]').getBoundingClientRect().left`,
  );
  expect(Math.abs(indent - 14)).toBeLessThan(0.5);
  expect(app.getRendererErrors()).toEqual([]);
});

it("glides the ring with the arrows, and goes on past a list's end into the next list", async () => {
  await app.press("ArrowDown");
  const next = await app.waitFor<Focus>(
    `(() => { const state = ${focus}; return state.id === 'notes/c.txt' && state; })()`,
    { label: "the next row" },
  );
  expect(next.glide).toBe(true);
  expect(
    await app.eval<string>(
      `getComputedStyle(document.querySelector('${files} [data-tree-focus]')).transitionDuration`,
    ),
  ).toContain("0.15s");
  // Tabs placed in the sidebar list above Files: up from Files' first row
  // goes into the Tabs list's last row, and back down.
  await app.eval(
    "window.catamorphicDesktop.setPrefs({ tabPlacement: 'sidebar' }).then(() => true)",
  );
  await app.waitFor(
    `!!document.querySelector('${left} [data-sidebar-section="tabs"] [data-tree-id]')`,
    { label: "the Tabs list" },
  );
  await app.eval(
    `document.querySelector('${files} [data-tree-id="notes"]').focus()`,
  );
  await app.press("ArrowUp");
  const above = await app.waitFor<Focus>(
    `(() => { const state = ${focus}; return state.section === 'tabs' && state; })()`,
    { label: "the Tabs list's last row" },
  );
  expect(above.id).toBe(
    await app.eval<string>(
      `[...document.querySelectorAll('${left} [data-sidebar-section="tabs"] [data-tree-id]')].at(-1).dataset.treeId`,
    ),
  );
  await app.press("ArrowDown");
  await app.waitFor(
    `(() => { const state = ${focus}; return state.id === 'notes' && state.section === 'files'; })()`,
    { label: "back to Files' first row" },
  );
  await app.eval(
    "window.catamorphicDesktop.setPrefs({ tabPlacement: 'top' }).then(() => true)",
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("opened by a press, takes focus there and shows the ring at the first arrow", async () => {
  await app.waitFor(
    `!document.querySelector('${left} [data-sidebar-section="tabs"]')?.checkVisibility()`,
    { label: "tabs back on top" },
  );
  await app.eval(
    `document.querySelector('${files} [data-tree-id="notes/b.txt"] [data-tree-primary]').click()`,
  );
  await closeSidebar();
  await pressButton("Expand sidebar");
  const landed = await app.waitFor<Focus>(
    `(() => { const state = ${focus}; return state.id === 'notes/b.txt' && state; })()`,
    { label: "focus on the open file's row" },
  );
  // The pointer leads: no ring until the keyboard moves.
  expect(landed.ring === null || landed.style === "none").toBe(true);
  await app.press("ArrowUp");
  const moved = await app.waitFor<Focus>(
    `(() => { const state = ${focus}; return state.id === 'notes/a.txt' && state.style === 'solid' && state; })()`,
    { label: "the ring at the first arrow" },
  );
  expect(moved.ring).not.toBeNull();
  expect(app.getRendererErrors()).toEqual([]);
});
