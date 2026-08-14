import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Skills as commands (ADR 0052): the two-tier skill list (project files +
 * host skills) surfaces as palette rows and composer /commands, both of
 * which just send the invocation message to an agent. The e2e fake answers
 * `Use the "<name>" skill` with the REAL read_skill workspace tool, so
 * these tests cover renderer → message → toolkit → core's merged tiers end
 * to end. The connect test drives request_connection the same way: real
 * tool, real connectors modal, user (the test) declining.
 */

let app: AppHandle;
let projectRoot: string;

beforeAll(async () => {
  app = await launchApp();
});

afterAll(async () => {
  await app?.stop();
});

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const visibleDock = () =>
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('textarea'));
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  const paletteInput = () => (
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => document.activeElement === el) ??
    $$('textarea[aria-label="Search commands, pages, and more"]')
      .find((el) => !el.closest('[inert]'))
  );
  const paletteRows = () => {
    const input = paletteInput();
    if (!input) return [];
    return [...input.closest('[role="dialog"]').querySelectorAll('[role="option"]')];
  };
  const composer = () => visibleDock()?.querySelector('form textarea');
  const composerKey = (key, mods = {}) =>
    composer().dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);
const runWaitAsync = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(async () => { ${helpers}\n${body} })()`, opts);

const ensurePalette = async () => {
  await run(
    `if (!paletteInput()) pressKey('p', { metaKey: true }); return true;`,
  );
  await runWait(`return !!paletteInput();`, { label: "palette open" });
};

const paletteType = (text: string) =>
  run(`setReactValue(paletteInput(), ${JSON.stringify(text)}); return true;`);

describe("skills as commands", () => {
  it("boots into a project workspace", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-skills');
      return true;
    `);
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "project submit enabled" },
    );
    await runWait(
      `return !!byText('[role="tab"], button', 'New Tab') &&
              !!$('textarea[placeholder*="Search or ask"]');`,
      { timeoutMs: 60_000, label: "workspace after project creation" },
    );
  });

  it("writes project skills beside the seeded ones", async () => {
    const resolved = await runWaitAsync<{ id: string; root: string } | false>(
      `const server = await window.catamorphicDesktop.getServerState();
       if (!server.url) return false;
       const response = await fetch(server.url + '/api/projects');
       const data = await response.json();
       const project = (data.items ?? []).find((p) => p.name === 'e2e-skills');
       if (!project) return false;
       const root = await window.catamorphicDesktop.projectRoot(project.id);
       if (!root) return false;
       return { id: project.id, root };`,
      { timeoutMs: 30_000, label: "project id + root path" },
    );
    if (!resolved) throw new Error("project root not resolved");
    projectRoot = resolved.root;

    for (const [name, description] of [
      ["team-notes", "How this team writes notes."],
      ["checklist", "The release checklist."],
    ]) {
      const dir = path.join(projectRoot, ".agents", "skills", String(name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nBody of ${name}.\n`,
      );
    }
  });

  it("lists both tiers in the palette's > command view", async () => {
    await ensurePalette();
    await paletteType(">publishing");
    // Rows front the pretty title (frontmatter `title`), not the slug.
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Publish to GitHub'));
       return !!row && row.textContent.includes('App skill') &&
              !row.textContent.includes('publishing-to-github');`,
      { timeoutMs: 15_000, label: "host skill row with pretty title" },
    );
    await paletteType(">team-notes");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Team notes'));
       return !!row && row.textContent.includes('Skill');`,
      { label: "project skill row with humanized title" },
    );
    await run(`pressKey('Escape'); return true;`);
  });

  it("runs a host skill from the palette into a new chat", async () => {
    await ensurePalette();
    await paletteType(">publishing-to-github");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Publish to GitHub'));
       if (!row) return false;
       row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
       return true;`,
      { label: "commit host skill row" },
    );
    // The fake agent answered with the REAL read_skill tool — through
    // core's HOST tier (the file never exists in the project).
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: publishing-to-github') &&
              !!byText('section[aria-label] *', 'source:host');`,
      { timeoutMs: 30_000, label: "host skill loaded reply" },
    );
  });

  it("runs a project skill via the composer slash menu", async () => {
    await runWait(`return !!composer();`, { label: "composer available" });
    await run(`setReactValue(composer(), '/team'); return true;`);
    await runWait(
      `const menu = $('[data-testid="slash-menu"]');
       return !!menu && !!menu.querySelector('[data-skill-name="team-notes"]');`,
      { timeoutMs: 15_000, label: "slash menu lists team-notes" },
    );
    await run(`composerKey('Enter'); return true;`);
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: team-notes') &&
              !!byText('section[aria-label] *', 'source:project');`,
      { timeoutMs: 30_000, label: "project skill loaded reply" },
    );
  });

  it("targets the focused chat from the palette, highlighting it", async () => {
    // The floating chat from the previous tests is focused; a skill row
    // must point at it (border accent) and send into it, not a new chat.
    const before = await run<number>(
      `return $$('section[aria-label]').length;`,
    );
    await ensurePalette();
    await paletteType(">checklist");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Checklist'));
       return !!row && !!$('[data-palette-target]');`,
      { timeoutMs: 15_000, label: "skill row highlights the focused chat" },
    );
    await run(
      `paletteInput().dispatchEvent(new KeyboardEvent('keydown',
         { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
    );
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: checklist');`,
      { timeoutMs: 30_000, label: "checklist reply in the focused chat" },
    );
    const after = await run<number>(`return $$('section[aria-label]').length;`);
    if (after !== before) {
      throw new Error(
        `expected no new chat: ${String(before)} docks -> ${String(after)}`,
      );
    }
  });

  it("request_connection opens the connectors modal seeded with the agent's query", async () => {
    await run(`window.focus(); return true;`);
    await run(`
      const ta = composer();
      setReactValue(ta, 'connect: linear');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `const banner = $('[data-testid="agent-connection-request"]');
       const search = $('[data-testid="connectors-search"]');
       return !!banner && banner.textContent.includes('linear') &&
              !!search && search.value === 'linear';`,
      { timeoutMs: 30_000, label: "connectors modal with agent banner" },
    );
    // Decline: close the modal without installing anything — the tool
    // call settles with an empty install list and the turn completes.
    await run(`pressKey('Escape'); return true;`);
    await runWait(
      `return !!byText('section[aria-label] *', 'connection request settled: installed=[]');`,
      { timeoutMs: 30_000, label: "declined request settles the turn" },
    );
  });
});
