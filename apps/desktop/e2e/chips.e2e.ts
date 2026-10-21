import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * The chips above a chat's composer (ADR 0239): recorded pull requests as
 * wide chips with their live state, chips an agent attaches on the fly,
 * folding past three lines, the keyboard path, a project's chips module,
 * and Customize chips. The fake agent calls the real workspace tools; pull
 * requests in acme/* on github.com stand where the e2e fixture says.
 */

let app: AppHandle;
let projectRoot: string;
let serial = 0;

const helpers = `${setReactValueJs}
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const dock = () => $$('section[aria-label]').find((el) => !el.closest('[inert]') && el.querySelector('[data-composer-input]'));
const composer = () => dock()?.querySelector('[data-composer-input]');
const rail = () => dock()?.querySelector('[data-testid="chip-rail"]');
const chip = (id) => rail()?.querySelector('[data-chip-root="' + CSS.escape(id) + '"]');
const shown = () => [...(rail()?.querySelectorAll('[data-testid="chip"]:not([data-hidden])') ?? [])];
const logs = () => $$('[role="log"]').map((el) => el.textContent).join('\\n');`;

const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const wait = <T = unknown>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

/** A workspace tool the fake agent calls for real, and what it returned. */
async function tool(name: string, input: Record<string, unknown>) {
  serial++;
  const prefix = `E2E result ${serial}: `;
  const prompt = `E2E workspace tool ${JSON.stringify({ name, input, serial })}`;
  await run(
    `setReactValue(composer(), ${JSON.stringify(prompt)}); composer().closest('form').requestSubmit(); return true;`,
  );
  const result = await wait<string>(
    `const text = logs(); const start = text.lastIndexOf(${JSON.stringify(prefix)});
     return start < 0 ? false : text.slice(start + ${prefix.length}).split('E2E end')[0];`,
    { timeoutMs: 30_000, label: `${name} answered` },
  );
  return JSON.parse(result) as { metadata?: Record<string, unknown> };
}

const primary = async () =>
  (await app.eval<boolean>("/Mac/.test(navigator.platform)")) ? 4 : 2;

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  projectRoot = path.join(app.userDataDir, "chips-project");
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Chips',rootPath:${JSON.stringify(projectRoot)}})`,
  );
  await app.reload();
  await app.waitFor(`document.body?.innerText.includes('Chips')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1200,850)`);
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')", {
    label: "workspace ready for shortcuts",
  });
  // A floating chat, from the dock's + (Cmd+N over the starting New Tab
  // would open it in the tab).
  await wait(
    `const plus = $('[data-dock-rail] button[aria-label="New chat"]'); plus?.click(); return !!plus;`,
    { label: "the dock's +" },
  );
  await wait(`return !!composer();`, { label: "chat open" });
  // The chat's first message gives it a session, which chips belong to.
  await run(
    `setReactValue(composer(), 'hello chips'); composer().closest('form').requestSubmit(); return true;`,
  );
  await wait(`return logs().includes('You said: hello chips');`, {
    timeoutMs: 30_000,
    label: "first reply",
  });
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

it("draws a recorded pull request as a wide chip that says where it stands", async () => {
  await tool("set_session_metadata", {
    key: "pull_requests",
    value: [
      {
        url: "https://github.com/acme/widgets/pull/4",
        number: 4,
        title: "Chips that say where work stands",
        state: "open",
      },
      {
        url: "https://git.invalid/acme/web/pull/12",
        number: 12,
        title: "Recorded only",
        state: "open",
      },
    ],
  });
  // Live: open, its size, comments and pending checks from the host.
  const live = await wait<{
    wide: boolean;
    tone: string;
    label: string;
    badges: string[];
    checkTone: string;
  }>(
    `const el = chip('https://github.com/acme/widgets/pull/4');
     const badges = [...(el?.querySelectorAll('[data-chip-badge]') ?? [])];
     if (!el || badges.length < 4) return false;
     return { wide: el.hasAttribute('data-wide'), tone: el.dataset.tone,
       label: el.querySelector('[data-chip-main]').textContent,
       badges: badges.map((badge) => badge.textContent),
       checkTone: badges.at(-1).dataset.tone };`,
    { timeoutMs: 30_000, label: "live pull request chip" },
  );
  expect(live).toMatchObject({ wide: true, tone: "success" });
  expect(live.label).toContain("#4");
  expect(live.badges).toEqual(["+1,556", "−212", "4", "Checks"]);
  expect(live.checkTone).toBe("warning");
  // Wide chips stack against the composer, the composer's width (layout
  // widths: a chip still rising in is drawn a little smaller).
  const geometry = await run<{ chip: number; rail: number }>(
    `return { chip: chip('https://github.com/acme/widgets/pull/4').offsetWidth,
       rail: rail().querySelector('[role="toolbar"]').offsetWidth };`,
  );
  expect(geometry.rail - geometry.chip).toBeLessThan(4);

  // One the host cannot read shows what the chat recorded, and turns when
  // the chat records it merged: a new icon in the merged tone.
  await wait(
    `return chip('https://git.invalid/acme/web/pull/12')?.dataset.tone === 'success';`,
  );
  await tool("set_session_metadata", {
    key: "pull_requests",
    value: [
      { url: "https://github.com/acme/widgets/pull/4", number: 4 },
      {
        url: "https://git.invalid/acme/web/pull/12",
        number: 12,
        title: "Recorded only",
        state: "merged",
      },
    ],
  });
  await wait(
    `const el = chip('https://git.invalid/acme/web/pull/12');
     return el?.dataset.tone === 'info' &&
       !!el.querySelector('[data-chip-main] svg.lucide-git-merge');`,
    { label: "merged chip" },
  );
  // However long its title, a wide chip stays within the composer: the
  // title gives way, the badges and buttons stay.
  const long = "A pull request whose title runs on and on ".repeat(6).trim();
  await tool("set_session_metadata", {
    key: "pull_requests",
    value: [
      { url: "https://github.com/acme/widgets/pull/4", number: 4 },
      {
        url: "https://git.invalid/acme/web/pull/12",
        number: 12,
        title: long,
        state: "merged",
      },
    ],
  });
  const edges = await wait<{
    left: number;
    right: number;
    formLeft: number;
    formRight: number;
  }>(
    `const el = chip('https://git.invalid/acme/web/pull/12');
     const form = composer()?.closest('form');
     if (!el || !form || !el.textContent.includes('runs on and on')) return false;
     const c = el.getBoundingClientRect();
     const f = form.getBoundingClientRect();
     return { left: c.left, right: c.right, formLeft: f.left, formRight: f.right };`,
    { label: "long-titled chip" },
  );
  expect(edges.left).toBeGreaterThanOrEqual(edges.formLeft - 1);
  expect(edges.right).toBeLessThanOrEqual(edges.formRight + 1);
  await tool("set_session_metadata", {
    key: "pull_requests",
    value: [
      { url: "https://github.com/acme/widgets/pull/4", number: 4 },
      {
        url: "https://git.invalid/acme/web/pull/12",
        number: 12,
        title: "Recorded only",
        state: "merged",
      },
    ],
  });
});

it("takes the theme's surfaces, never a fixed black", async () => {
  // The chip's color once its transition settles on the theme's raised one.
  const settled = (theme: string) =>
    wait<string>(
      `if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) return false;
       const el = chip('https://github.com/acme/widgets/pull/4');
       const probe = document.createElement('div');
       probe.style.background = 'var(--color-bg-raised)';
       document.body.append(probe);
       const raised = getComputedStyle(probe).backgroundColor;
       probe.remove();
       const color = getComputedStyle(el).backgroundColor;
       return color === raised ? color : false;`,
      { label: `chips on the ${theme} theme's raised surface` },
    );
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
  );
  const dark = await settled("dark");
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
  );
  const light = await settled("light");
  expect(light).not.toBe(dark);
  await app.eval(
    `window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
  );
  await settled("dark");
});

it("shows chips an agent attaches, and takes one off the chat with its X", async () => {
  await tool("set_session_metadata", {
    key: "chips",
    value: [
      {
        id: "preview",
        label: "Preview deploy",
        description: "staging",
        url: "https://preview.invalid/",
        icon: "Rocket",
        tone: "success",
        wide: true,
        badges: [{ label: "Live", tone: "success" }],
      },
      {
        id: "notes",
        label: "Notes",
        icon: "NotebookPen",
        trend: { values: [0.2, 0.6, 0.4], label: "40%" },
      },
    ],
  });
  const attached = await wait<{ buttons: string[]; kind: string }>(
    `const el = chip('preview');
     if (!el) return false;
     return { buttons: [...el.querySelectorAll('[data-chip-button]')].map((b) => b.dataset.chipButton),
       kind: el.dataset.kind };`,
    { label: "attached chip" },
  );
  expect(attached).toEqual({
    buttons: ["open-side", "remove"],
    kind: "attached",
  });
  // A chip draws a trend as a row does: its line, its reading beside it.
  const trend = await wait<{ line: boolean; label: string }>(
    `const el = chip('notes')?.querySelector('[data-trend]');
     if (!el) return false;
     return { line: (el.querySelector('path:last-of-type')?.getAttribute('d') ?? '').startsWith('M'),
       label: el.textContent };`,
    { label: "a chip's trend" },
  );
  expect(trend).toEqual({ line: true, label: "40%" });
  // Compact chips come first, packed in lines; wide ones stack under them
  // (this one under the two pull requests, folded behind "1 more").
  const order = await run<string[]>(
    `return [...rail().querySelectorAll('[data-testid="chip"]')].map((el) => el.dataset.chipId);`,
  );
  expect(order.indexOf("notes")).toBeLessThan(order.indexOf("preview"));

  await run(
    `chip('notes').querySelector('[data-chip-button="remove"]').click(); return true;`,
  );
  await wait(`return !chip('notes');`, { label: "chip taken off" });
  const read = await tool("set_session_metadata", { key: "chips" });
  expect(read.metadata?.chips).toEqual([
    expect.objectContaining({ id: "preview" }),
  ]);
});

it("wraps without scrolling sideways and folds past three lines", async () => {
  await tool("set_session_metadata", {
    key: "chips",
    value: Array.from({ length: 16 }, (_, index) => ({
      id: `chip-${index + 1}`,
      label: `Chip number ${index + 1}`,
      icon: "Circle",
    })),
  });
  const folded = await wait<{ more: string; lines: number; sideways: boolean }>(
    `const fold = rail()?.querySelector('[data-testid="chip-fold"]');
     if (!fold || !chip('chip-16')) return false;
     const tops = new Set([...shown(), fold].map((el) => el.offsetTop));
     const flow = rail().querySelector('[role="toolbar"]');
     return { more: fold.textContent, lines: tops.size,
       sideways: flow.scrollWidth > flow.clientWidth + 1 };`,
    { label: "folded rail" },
  );
  expect(folded.more).toMatch(/^\d+ more$/);
  expect(folded.lines).toBeLessThanOrEqual(3);
  expect(folded.sideways).toBe(false);
  await run(
    `rail().querySelector('[data-testid="chip-fold"]').click(); return true;`,
  );
  await wait(
    `return !rail().querySelector('[data-testid="chip"][data-hidden]') &&
       rail().querySelector('[data-testid="chip-fold"]')?.textContent === 'Show less';`,
    { label: "unfolded" },
  );
  await run(
    `rail().querySelector('[data-testid="chip-fold"]').click(); return true;`,
  );
  await wait(
    `return /more$/.test(rail().querySelector('[data-testid="chip-fold"]')?.textContent ?? '');`,
    {
      label: "folded again",
    },
  );
});

it("focuses the first chip with Cmd+J; arrows move, Tab reaches its buttons, Escape returns", async () => {
  await run(`composer().focus(); return true;`);
  await app.press("j", await primary());
  await wait(
    `return rail()?.dataset.unfolded === 'keyboard' &&
       document.activeElement?.matches('[data-chip-main]') &&
       document.activeElement.closest('[data-chip-root]') === shown()[0];`,
    { label: "first chip focused, rail unfolded" },
  );
  await app.press("ArrowRight");
  await wait(
    `return document.activeElement?.closest('[data-chip-root]') === shown()[1];`,
    { label: "next chip" },
  );
  await app.press("Tab");
  await wait(
    `return document.activeElement?.dataset.chipButton === 'remove' &&
       document.activeElement.closest('[data-chip-root]') === shown()[1];`,
    { label: "Tab reaches the chip's button" },
  );
  // A preview opened by keyboard focus closes first, then the composer.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await run<boolean>(`return document.activeElement === composer();`))
      break;
    await app.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await wait(
    `return document.activeElement === composer() && !rail().dataset.unfolded;`,
    { label: "back in the composer, folded" },
  );
  // A chat minimized to its bubble comes back for the shortcut, its first
  // chip focused rather than its composer.
  await app.press("m", await primary());
  await wait(`return !dock();`, { label: "chat minimized" });
  await app.press("j", await primary());
  await wait(
    `return rail()?.dataset.unfolded === 'keyboard' &&
       document.activeElement?.closest('[data-chip-root]') === shown()[0];`,
    { label: "chat back, first chip focused" },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await run<boolean>(`return document.activeElement === composer();`))
      break;
    await app.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await wait(`return document.activeElement === composer();`, {
    label: "back in the composer",
  });
});

it("runs the project's chips module: its order, its chip and its button", async () => {
  fs.mkdirSync(path.join(projectRoot, ".work"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, ".work/chips.ts"),
    `export default {
      async load({ work, parentId, session }) {
        const page = await work.read({ source: 'chips', parentId });
        if (parentId) return page;
        const prs = page.items.filter((c) => c.data?.kind === 'pull-request');
        return { items: [
          { id: 'standup', label: 'Standup for ' + (session?.title ?? 'chat'), icon: 'NotebookPen', tone: 'accent',
            actions: [{ action: 'ping', label: 'Ping the team', icon: 'Bell' }], data: { kind: 'standup' } },
          ...prs,
        ] };
      },
      async action({ work, itemId, action, values }) {
        if (action === 'ping') return { message: 'Pinged the team.' };
        await work.execute({ source: 'chips', itemId, action, values });
      },
    };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/workspace.js"),
    `module.exports = { sidebars: { left: [{ id: 'project', title: 'Project', icon: 'House', sections: [{ id: 'files', source: 'work:files' }] }], right: [] },
      chips: { source: '.work/chips.ts', collections: ['chips'] } };`,
  );
  await wait(
    `return shown().map((el) => el.dataset.chipId).join(',') ===
       'standup,https://github.com/acme/widgets/pull/4,https://git.invalid/acme/web/pull/12';`,
    { timeoutMs: 30_000, label: "module chips" },
  );
  expect(await run(`return chip('standup').dataset.tone;`)).toBe("accent");
  await run(
    `chip('standup').querySelector('[data-chip-button="ping"]').click(); return true;`,
  );
  await wait(
    `return rail().querySelector('[role="status"]')?.textContent === 'Pinged the team.';`,
    { label: "module action reported" },
  );
  // Work's own actions pass through the module: the X still forgets a PR.
  await run(
    `chip('https://git.invalid/acme/web/pull/12').querySelector('[data-chip-button="remove"]').click(); return true;`,
  );
  await wait(`return !chip('https://git.invalid/acme/web/pull/12');`, {
    timeoutMs: 15_000,
    label: "PR removed through the module",
  });
  fs.rmSync(path.join(projectRoot, ".work/workspace.js"));
  await wait(`return !chip('standup');`, { label: "Work's chips again" });
});

it("keeps Work's chips beside a Retry when the chips module fails", async () => {
  fs.writeFileSync(
    path.join(projectRoot, ".work/broken-chips.ts"),
    `export default { async load() { throw new Error('no chips today'); } };`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work/workspace.js"),
    `module.exports = { sidebars: { left: [{ id: 'project', title: 'Project', icon: 'House', sections: [{ id: 'files', source: 'work:files' }] }], right: [] },
      chips: { source: '.work/broken-chips.ts', collections: ['chips'] } };`,
  );
  await wait(
    `return rail()?.querySelector('[data-testid="chip-rail-failure"]')?.textContent.includes('no chips today');`,
    { timeoutMs: 30_000, label: "failure shown" },
  );
  // Work's chips stay, acted on by Work.
  expect(
    await run<boolean>(
      `return !!chip('https://github.com/acme/widgets/pull/4') && !chip('standup');`,
    ),
  ).toBe(true);
  await run(
    `rail().querySelector('[aria-label="Retry chips"]').click(); return true;`,
  );
  await wait(
    `return !!rail()?.querySelector('[data-testid="chip-rail-failure"]');`,
    { label: "read again, failing again" },
  );
  fs.rmSync(path.join(projectRoot, ".work/workspace.js"));
  await wait(
    `return !rail()?.querySelector('[data-testid="chip-rail-failure"]');`,
    { label: "Work's chips, no failure" },
  );
});

it("opens Customize chips from a chip's menu, the request waiting in a new chat", async () => {
  await run(
    `const main = shown()[0].querySelector('[data-chip-main]');
     const rect = main.getBoundingClientRect();
     main.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
       clientX: rect.left + 8, clientY: rect.top + 8 }));
     return true;`,
  );
  const entries = await wait<string[]>(
    `const items = $$('[role="menu"] [role="menuitem"]').map((el) => el.textContent.trim());
     return items.includes('Customize chips') ? items : false;`,
    { label: "chip menu" },
  );
  expect(entries.at(-1)).toBe("Customize chips");
  await run(
    `$$('[role="menu"] [role="menuitem"]').find((el) => el.textContent.trim() === 'Customize chips').click(); return true;`,
  );
  const draft = await wait<{ text: string; pills: number; sent: number }>(
    `const input = composer();
     if (!input || !input.textContent.includes('Help me customize my chat chips.')) return false;
     return { text: input.textContent, pills: input.querySelectorAll('[data-pill-id]').length,
       sent: dock().querySelectorAll('[role="log"] article').length };`,
    { label: "customize chat with its request waiting" },
  );
  expect(draft.pills).toBe(2);
  expect(draft.sent).toBe(0);
  expect(app.getRendererErrors()).toEqual([]);
});
