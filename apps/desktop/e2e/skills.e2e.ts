import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * Skills as commands (ADR 0052, 0270, 0273): the skill tiers (project
 * files, host skills) and the chat agent's own commands are listed by the
 * composer's "/" menu, which puts a skill in the message as a pill, and by
 * the palette's Skills mode, which sends its invocation. The e2e fake
 * answers both (a skill pill, or `Use the "<name>" skill`) with the REAL
 * read_skill workspace tool, so these tests cover renderer → message →
 * toolkit → core's merged tiers end to end. The connect test drives
 * request_connection the same way: real tool, real connectors modal, user
 * (the test) declining.
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
    $$('section[aria-label]').find((el) => !el.inert && el.querySelector('[data-composer-input]'));
  ${setReactValueJs}
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
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
  const composer = () => visibleDock()?.querySelector('[data-composer-input]');
  const chip = () =>
    paletteInput()?.closest('[role="dialog"]')
      .querySelector('[data-testid="palette-mode-chip"]')?.textContent.trim();
  const rowIds = () => paletteRows().map((row) => row.dataset.itemId);
  // A New Tab shows the palette too; the overlay is put away when inert.
  const overlayClosed = () =>
    !!$('[data-palette="overlay"]')?.closest('[inert]');
  const lastSent = () => {
    const messages = visibleDock()?.querySelectorAll('[data-user-message]') ?? [];
    return messages[messages.length - 1];
  };
  const composerKey = (key, mods = {}) =>
    composer().dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
  // The composer's "/" and "@" menu (ADR 0273), while it is open.
  const composerMenu = () =>
    $$('[data-testid="composer-menu"]').find((el) => !el.inert);
  const menuIds = () =>
    [...(composerMenu()?.querySelectorAll('[role="option"]') ?? [])].map((el) => el.dataset.itemId);
  const menuLoading = () => !!composerMenu()?.querySelector('[role="status"]');
  const composerPills = () =>
    [...(composer()?.querySelectorAll('[data-testid="composer-pill"]') ?? [])];
  const sentPills = () =>
    [...(lastSent()?.querySelectorAll('[data-testid="sent-pill"]') ?? [])].map((el) => el.dataset.pillKind);
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

/** ⌘ on macOS, Ctrl elsewhere: the palette's new-chat commit. */
const PRIMARY = process.platform === "darwin" ? 4 : 2;

/**
 * "/" typed at the end of the front chat's composer: its menu opens above
 * it with the slash typed, rows loaded.
 */
const slashInComposer = async () => {
  await run(
    `const c = composer(); c.focus();
     const range = document.createRange(); range.selectNodeContents(c); range.collapse(false);
     getSelection().removeAllRanges(); getSelection().addRange(range);
     return true;`,
  );
  await runWait(`return document.activeElement === composer();`, {
    label: "composer focused",
  });
  await app.press("Slash");
  await runWait(`return menuIds().length > 0 && !menuLoading();`, {
    timeoutMs: 15_000,
    label: "the composer's / menu",
  });
};

/** The palette's Skills mode: Cmd+P, then "/", rows loaded. */
const slashInPalette = async () => {
  await ensurePalette();
  // The overlay focuses its input a frame after it opens; a key before
  // that would land in the composer and open the composer's own menu.
  await runWait(`return document.activeElement === paletteInput();`, {
    label: "palette input focused",
  });
  await app.press("Slash");
  await runWait(
    `return chip() === 'Skills' && rowIds().length > 0 && !rowIds().includes('skills:loading');`,
    { timeoutMs: 15_000, label: "the palette's Skills mode" },
  );
};

describe("skills as commands", () => {
  it("boots into a project workspace", async () => {
    await runWait(`return !!byText('button', 'Create or import project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(
      `byText('button', 'Create or import project').click(); return true;`,
    );
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
      const dir = path.join(projectRoot, ".work", "skills", String(name));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n${name === "team-notes" ? "argument-hint: [meeting]\n" : ""}---\n\n# ${name}\nBody of ${name}.\n`,
      );
    }
    await runWaitAsync(
      `const server = await window.catamorphicDesktop.getServerState();
       const response = await fetch(server.url + '/api/projects/' + ${JSON.stringify(resolved.id)} + '/skills');
       const skills = await response.json();
       return skills.some((skill) => skill.name === 'team-notes');`,
      { label: "written project skill available through the API" },
    );
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

  it("lists one Skills row in the empty palette, enters the mode on /, and Tab takes a skill's instructions", async () => {
    await ensurePalette();
    await paletteType("");
    await runWait(`return rowIds().includes('skills-mode');`, {
      label: "one Skills row in the empty palette",
    });
    expect(
      await run<string[]>(
        `return rowIds().filter((id) => id.startsWith('skill:'));`,
      ),
    ).toEqual([]);
    await app.press("Slash");
    await runWait(
      `return chip() === 'Skills' && paletteInput().value === '';`,
      {
        label: "/ enters the Skills mode",
      },
    );
    // Not opened by a composer: Backspace leaves the mode, as any mode.
    await app.press("Backspace");
    await runWait(`return !chip();`, { label: "left the mode" });
    await paletteType(">team");
    await runWait(`return rowIds()[0] === 'skill:team-notes';`);
    await app.press("Tab");
    await runWait(
      `return chip() === 'Team notes' && paletteInput().placeholder === '[meeting]';`,
      { label: "Tab takes its instructions, with its hint" },
    );
    // Leave the palette as found (it may be the New Tab's, which Escape
    // does not close): back to the list, out of the mode, empty.
    await app.press("Backspace");
    await runWait(`return chip() === 'Skills';`, { label: "back to the list" });
    await app.press("Backspace");
    await runWait(`return !chip();`, { label: "out of the mode" });
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

  it("opens the / menu from the composer, and a picked skill goes in the message", async () => {
    await runWait(`return !!composer();`, { label: "composer available" });
    // The empty composer says what its menus hold.
    await runWait(
      `return !!visibleDock().querySelector('[data-testid="composer-menu-hint"]');`,
    );
    await slashInComposer();
    // The slash is typed; the chat's commands and the skills are listed.
    expect(await run(`return composer().textContent;`)).toBe("/");
    expect(await run<string[]>(`return menuIds();`)).toEqual(
      expect.arrayContaining(["action:session-status", "skill:team-notes"]),
    );
    await app.insertText("team");
    await runWait(`return menuIds()[0] === 'skill:team-notes';`, {
      label: "team-notes ranked first",
    });
    // Enter puts the skill in the message, where the word was.
    await app.press("Enter");
    await runWait(
      `return !composerMenu() && composerPills().map((el) => el.dataset.pillKind).join() === 'skill' &&
         !composer().textContent.includes('/team');`,
      { label: "the skill as a pill" },
    );
    await app.press("Enter");
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: team-notes') &&
              !!byText('section[aria-label] *', 'source:project');`,
      { timeoutMs: 30_000, label: "project skill loaded reply" },
    );
    // The message reads as the skill, and the keyboard stays in the chat.
    expect(await run(`return sentPills();`)).toEqual(["skill"]);
    await runWait(`return document.activeElement === composer();`, {
      label: "composer focused again",
    });
  });

  it("puts a skill anywhere in a message: Space after its whole name, Tab on a row", async () => {
    // Mid-message: "summarize the call and /team-notes include the decisions ↵",
    // typed without looking.
    await run(`setReactValue(composer(), ''); return true;`);
    await slashInComposer();
    await app.press("Backspace");
    await app.insertText("summarize the call and ");
    await app.press("Slash");
    await app.insertText("team-notes");
    await runWait(`return menuIds()[0] === 'skill:team-notes';`);
    await app.press("Space");
    await runWait(
      `return !composerMenu() && composerPills().length === 1 &&
         composerPills()[0].dataset.pillKind === 'skill';`,
      { label: "Space after a full name puts the skill in" },
    );
    await app.insertText("include the decisions");
    await app.press("Enter");
    await runWait(
      `return /skill loaded: team-notes \\(source:project, \\d+ chars\\) \\| summarize the call and include the decisions/
         .test(visibleDock().querySelector('[role="log"]').textContent);`,
      { timeoutMs: 30_000, label: "the message's words reached the agent" },
    );
    // Tab on the highlighted row does the same; Backspace takes the pill out.
    await slashInComposer();
    await app.insertText("check");
    await runWait(`return menuIds()[0] === 'skill:checklist';`);
    await app.press("Tab");
    await runWait(
      `return !composerMenu() && composerPills()[0]?.textContent.includes('Checklist');`,
      { label: "Tab puts it in" },
    );
    await app.press("Backspace");
    await app.press("Backspace");
    await runWait(
      `return composerPills().length === 0 && composer().textContent.trim() === '';`,
      { label: "Backspace removes it" },
    );
  });

  it("closes on Escape keeping what was typed, and slash text goes as written", async () => {
    await run(`setReactValue(composer(), ''); return true;`);
    await slashInComposer();
    await app.insertText("check");
    await runWait(`return menuIds()[0] === 'skill:checklist';`);
    await app.press("Escape");
    await runWait(
      `return !composerMenu() && document.activeElement === composer() &&
         composer().textContent === '/check' && !!visibleDock();`,
      { label: "menu closed, typing kept, chat in place" },
    );
    // The same word stays closed; the next one opens it again.
    await app.insertText("list");
    expect(await run(`return !!composerMenu();`)).toBe(false);
    await app.insertText(" and ");
    await app.press("Slash");
    await runWait(`return menuIds().length > 0;`, {
      label: "the next word opens it",
    });
    // A path is not a command: its second slash closes the menu.
    await run(`setReactValue(composer(), ''); return true;`);
    await slashInComposer();
    await app.insertText("usr");
    await app.press("Slash");
    await app.insertText("bin is missing");
    await runWait(
      `return !composerMenu() && composer().textContent === '/usr/bin is missing';`,
      { label: "a path typed" },
    );
    await app.press("Enter");
    await runWait(
      `return !!byText('[role="log"] *', 'You said: /usr/bin is missing');`,
      { timeoutMs: 30_000, label: "slash message sent as written" },
    );
    // A pasted slash command is a message too: nothing resolves it.
    await run(
      `setReactValue(composer(), '/team-notes keep it literal'); composerKey('Enter'); return true;`,
    );
    await runWait(
      `return !!byText('[role="log"] *', 'You said: /team-notes keep it literal');`,
      { timeoutMs: 30_000, label: "pasted slash text sent as written" },
    );
  });

  it("takes instructions in the palette's Skills mode after Space or Tab", async () => {
    // Typed without looking: Cmd+P, "/team-notes include the decisions ↵".
    await slashInPalette();
    await app.insertText("team-notes");
    await app.press("Space");
    await runWait(
      `return chip() === 'Team notes' && paletteInput().value === '';`,
      { label: "Space after a full name chips the skill" },
    );
    expect(await run(`return paletteInput().placeholder;`)).toBe("[meeting]");
    await app.insertText("include the decisions");
    await app.press("Enter");
    await runWait(
      `return /skill loaded: team-notes \\(source:project, \\d+ chars\\) \\| include the decisions/
         .test(visibleDock().querySelector('[role="log"]').textContent);`,
      { timeoutMs: 30_000, label: "instructions reached the agent" },
    );
    // Tab on the highlighted row does the same; Backspace walks back.
    await slashInPalette();
    await app.insertText("check");
    await runWait(`return rowIds()[0] === 'skills:checklist';`);
    await app.press("Tab");
    await runWait(`return chip() === 'Checklist';`, { label: "Tab chips it" });
    await app.press("Backspace");
    await runWait(`return chip() === 'Skills';`, {
      label: "Backspace back to the list",
    });
    // Put away with its exit played, so the next palette opens fresh.
    await app.press("Escape");
    await runWait(
      `return overlayClosed() && !document.getAnimations().some((animation) =>
         animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);`,
      { label: "palette put away, its exit played" },
    );
  });

  it("starts a new chat with the skill on ⌘↵", async () => {
    const before = await run<string[]>(
      `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId);`,
    );
    await slashInPalette();
    await app.insertText("checklist");
    await runWait(`return rowIds()[0] === 'skills:checklist';`);
    await app.press("Enter", PRIMARY);
    await runWait(
      `const ids = $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId);
       return ids.some((id) => !${JSON.stringify(before)}.includes(id));`,
      { timeoutMs: 15_000, label: "a new chat" },
    );
    await runWait(
      `const fresh = $$('[data-chat-local-id]').find(el => !${JSON.stringify(before)}.includes(el.dataset.chatLocalId));
       return !!fresh && fresh.hasAttribute('data-chat-tab') &&
         fresh.textContent.includes('skill loaded: checklist');`,
      { timeoutMs: 30_000, label: "the new chat, a tab, ran the skill" },
    );
  });

  it("starts a floating chat on ⌥↵, and a New Tab's palette starts the chat in the tab", async () => {
    let before = await run<string[]>(
      `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId);`,
    );
    await slashInPalette();
    await app.insertText("checklist");
    await runWait(`return rowIds()[0] === 'skills:checklist';`);
    await app.press("Enter", 1);
    await runWait(
      `const fresh = $$('[data-chat-local-id]').find(el => !${JSON.stringify(before)}.includes(el.dataset.chatLocalId));
       return !!fresh && fresh.hasAttribute('data-floating-chat') &&
         fresh.textContent.includes('skill loaded: checklist');`,
      { timeoutMs: 30_000, label: "a floating chat ran the skill" },
    );
    before = await run<string[]>(
      `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId);`,
    );
    await run(`pressKey('t', { metaKey: true }); return true;`);
    await runWait(
      `const input = document.activeElement;
       return input?.getAttribute('aria-label') === 'Search commands, pages, and more' &&
         input.closest('[data-palette="tab"]') !== null;`,
      { label: "a New Tab's palette" },
    );
    await app.press("Slash");
    await runWait(
      `return chip() === 'Skills' && !rowIds().includes('skills:loading');`,
      {
        label: "the New Tab's Skills mode",
      },
    );
    // No chat is the target here: no Status row.
    expect(await run<string[]>(`return rowIds();`)).not.toContain(
      "skills:status",
    );
    await app.insertText("checklist");
    await runWait(`return rowIds()[0] === 'skills:checklist';`);
    await app.press("Enter");
    await runWait(
      `const fresh = $$('[data-chat-local-id]').find(el => !${JSON.stringify(before)}.includes(el.dataset.chatLocalId));
       return !!fresh && fresh.hasAttribute('data-chat-tab') &&
         fresh.textContent.includes('skill loaded: checklist');`,
      { timeoutMs: 30_000, label: "the chat took the tab" },
    );
  });

  it("surfaces discovery errors and recovers with Retry", async () => {
    // The composer's menu leads with the failure, where Enter retries it.
    await app.blockRequests(["*/api/projects/*/skills"]);
    try {
      await slashInComposer();
      await runWait(`return menuIds()[0] === 'skills:error';`, {
        label: "the failure leads the composer's menu",
      });
    } finally {
      await app.blockRequests([]);
    }
    await app.press("Enter");
    await runWait(`return menuIds().includes('skill:team-notes');`, {
      label: "skills after Enter retried",
    });
    await app.press("Escape");
    await run(`setReactValue(composer(), ''); return true;`);
    // The palette's Skills mode does the same.
    await app.blockRequests(["*/api/projects/*/skills"]);
    try {
      await slashInPalette();
      await runWait(
        `return paletteRows().some((row) => row.textContent.includes('Could not load skills'));`,
      );
    } finally {
      await app.blockRequests([]);
    }
    // The error row retries in place.
    await run(
      `paletteRows().find((row) => row.textContent.includes('Could not load skills')).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); return true;`,
    );
    await runWait(`return rowIds().includes('skills:team-notes');`, {
      label: "skills after Retry",
    });
    await app.press("Escape");
    await runWait(`return overlayClosed();`);
  });

  it("returns only the selected harness's native commands through the real desktop bridge", async () => {
    const result = await app.eval<{
      builtin: string[];
      claude: string[];
      codex: string[];
    }>(`(async () => {
      const api = window.catamorphicDesktop;
      const state = await api.getServerState();
      const projects = await (await fetch(state.url + '/api/projects')).json();
      const projectId = projects.items.find(p => p.name === 'e2e-skills').id;
      const result = {};
      for (const [key, harness] of [['builtin', 'ai-sdk'], ['claude', 'claude-code'], ['codex', 'codex']]) {
        const agent = await api.agentsCreate({ name: 'Catalog ' + key, harness, auth: 'local' });
        const catalog = await api.agentCommands({ projectId, agentId: agent.id });
        if (catalog.error) throw new Error(catalog.error);
        result[key] = catalog.commands.map(command => command.name);
      }
      return result;
    })()`);
    expect(result.builtin).toEqual([]);
    expect(result.claude).toContain("compact");
    expect(result.codex).toEqual(["native-notes"]);
  });

  it("requires project-agent consent and refreshes a changed definition before discovery", async () => {
    const dir = path.join(projectRoot, ".work", "agents");
    fs.mkdirSync(dir, { recursive: true });
    const definition = {
      version: 1,
      name: "Release Claude",
      kind: "claude-code",
      credentials: { source: "profile" },
    };
    const file = path.join(dir, "release-claude.json");
    fs.writeFileSync(file, JSON.stringify(definition));
    const invoke = `(async () => {
      const api = window.catamorphicDesktop;
      const state = await api.getServerState();
      const projects = await (await fetch(state.url + '/api/projects')).json();
      const projectId = projects.items.find(p => p.name === 'e2e-skills').id;
      return { api, projectId };
    })()`;
    const before = await app.eval<{ error?: string; commands: unknown[] }>(
      `${invoke}.then(({api,projectId}) => api.agentCommands({projectId,agentId:'project:'+projectId+':release-claude'}))`,
    );
    expect(before.error).toBeTruthy();
    expect(before.commands).toEqual([]);
    // Approves the definition as listed, as the consent dialog does.
    await app.eval(
      `${invoke}.then(async ({api,projectId}) => {
        const { agents } = await api.projectAgentsList(projectId);
        const agent = agents.find((each) => each.slug === 'release-claude');
        return api.projectAgentApprove(projectId, 'release-claude', agent.definitionHash);
      })`,
    );
    const approved = await app.eval<{
      error?: string;
      commands: { name: string }[];
    }>(
      `${invoke}.then(({api,projectId}) => api.agentCommands({projectId,agentId:'project:'+projectId+':release-claude'}))`,
    );
    expect(approved.error).toBeUndefined();
    expect(
      approved.commands.some((command) => command.name === "compact"),
    ).toBe(true);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...definition, model: "changed-model" }),
    );
    const stale = await app.eval<{ error?: string; commands: unknown[] }>(
      `${invoke}.then(({api,projectId}) => api.agentCommands({projectId,agentId:'project:'+projectId+':release-claude'}))`,
    );
    expect(stale.error).toBeTruthy();
    expect(stale.commands).toEqual([]);
  });

  it("lists each harness's own native rows, another harness in a new chat", async () => {
    const nativeDir = path.join(projectRoot, ".codex/skills/native-notes");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "SKILL.md"), "Native notes fixture.");
    // Each harness's row in the composer's menu, and the row it must not
    // list: a harness's own command, or a skill (its own file or shared).
    const harnesses: Array<
      [name: string, command: string, present: string, absent: string]
    > = [
      ["Catalog claude", "compact", "command:compact", "skill:native-notes"],
      [
        "Catalog codex",
        "native-notes",
        "skill:native-notes",
        "command:compact",
      ],
      ["Fake Agent", "team-notes", "skill:team-notes", "skill:native-notes"],
    ];
    for (const [name, command, present, absent] of harnesses) {
      const chat = await run<string>(
        `return visibleDock()?.dataset.chatLocalId ?? '';`,
      );
      await ensurePalette();
      await paletteType(">switch agent");
      await runWait(
        `const row = paletteRows().find(el => el.textContent.includes('Switch agent for this chat')); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true})); return true;`,
      );
      await runWait(
        `const row = paletteRows().find(el => el.textContent.includes(${JSON.stringify(name)})); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true})); return true;`,
      );
      // A chat that ran on another harness keeps it: the agent starts a
      // new chat (ADR 0214). One on its harness switches in place.
      await runWait(
        `const dock = visibleDock();
         return !!dock && (dock.dataset.chatLocalId !== ${JSON.stringify(chat)} ||
           !!byText('[role="log"] div', ${JSON.stringify(`Switched to ${name}`)}));`,
        { label: `${name} picked` },
      );
      await runWait(`return overlayClosed();`, { label: "palette put away" });
      await slashInComposer();
      await runWait(
        `return menuIds().includes('${present}') && !menuIds().includes('${absent}');`,
        { label: `${name} lists ${present}, not ${absent}` },
      );
      // Chromium's keyboard path for each harness: the name, Space, the
      // instructions, Enter. A skill goes in as a pill; a harness's own
      // command stays typed and is sent as written.
      await app.insertText(command);
      await app.press("Space");
      await runWait(
        present.startsWith("skill:")
          ? `return !composerMenu() && composerPills().length === 1;`
          : `return !composerMenu() && composer().textContent === '/${command} ';`,
        { label: `${command} taken` },
      );
      await app.insertText("release 42");
      await app.press("Enter");
      const reply =
        name === "Catalog claude"
          ? "You said: /compact release 42"
          : name === "Catalog codex"
            ? "native skill loaded: Native notes fixture\\. \\| release 42"
            : "skill loaded: team-notes \\(source:project, \\d+ chars\\) \\| release 42";
      await runWait(
        `return new RegExp(${JSON.stringify(reply)}).test(visibleDock().querySelector('[role="log"]').textContent);`,
        { label: `${name} command reply`, timeoutMs: 30_000 },
      );
      expect(await run(`return composer().textContent;`)).toBe("");
      if (name !== "Catalog claude") continue;
      // In a new chat, an agent's own command runs on that agent.
      const chats = await run<string[]>(
        `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId);`,
      );
      await slashInPalette();
      await app.insertText("compact");
      await runWait(`return rowIds()[0] === 'skills:compact';`);
      await app.press("Enter", PRIMARY);
      await runWait(
        `const fresh = $$('[data-chat-local-id]').find(el => !${JSON.stringify(chats)}.includes(el.dataset.chatLocalId));
         return !!fresh && fresh.textContent.includes('You said: /compact') &&
           !!fresh.querySelector('[data-testid="session-inspector-trigger"]')?.getAttribute('aria-label')?.includes('Catalog claude');`,
        { label: "the new chat runs on Catalog claude", timeoutMs: 30_000 },
      );
    }
  });

  it("opens with the most used skills under Recent", async () => {
    // The composer's menu leads with them too, from the same use signals.
    await slashInComposer();
    const composerList = await runWait<string>(
      `const text = composerMenu()?.querySelector('[role="listbox"]')?.textContent ?? '';
       return text.startsWith('Recent') ? text : false;`,
      { label: "a Recent group first in the composer's menu" },
    );
    expect(composerList).toContain("All");
    await app.press("Escape");
    await run(`setReactValue(composer(), ''); return true;`);
    await slashInPalette();
    const listed = await runWait<string>(
      `const list = paletteInput().closest('[role="dialog"]').querySelector('[role="listbox"]');
       return list.textContent.startsWith('Recent') ? list.textContent : false;`,
      { label: "a Recent group first" },
    );
    expect(listed).toContain("All");
    // team-notes and checklist were run above; Status, never.
    const recent = await run<string[]>(
      `const rows = []; let group = '';
       const list = paletteInput().closest('[role="dialog"]').querySelector('[role="listbox"] > div');
       for (const el of list.children) {
         if (!el.dataset.itemId) group = el.textContent.trim();
         else if (group === 'Recent') rows.push(el.dataset.itemId);
       }
       return rows;`,
    );
    expect(recent).toEqual(
      expect.arrayContaining(["skills:team-notes", "skills:checklist"]),
    );
    expect(recent).not.toContain("skills:status");
    await app.press("Escape");
    await runWait(`return overlayClosed();`);
    await run(`setReactValue(composer(), ''); return true;`);
  });

  it("opens Status without sending, and a skill takes the composer's pills along", async () => {
    await run(
      `const data = new DataTransfer(); data.setData('text/plain', 'Meeting context. '.repeat(100)); composer().dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data})); return true;`,
    );
    await runWait(
      `return composer().querySelectorAll('[data-pill-id]').length > 0;`,
    );
    const count = await run<number>(
      `return composer().querySelectorAll('[data-pill-id]').length;`,
    );
    const sent = await run<number>(
      `return visibleDock().querySelectorAll('[data-user-message]').length;`,
    );
    // Status is the chat's own command: it opens the chat's details, sends
    // nothing, takes its word away and leaves the pills where they are.
    await slashInComposer();
    await app.insertText("status");
    await runWait(`return menuIds()[0] === 'action:session-status';`);
    await app.press("Enter");
    await runWait(`return !!$('[data-testid="session-inspector-content"]');`, {
      label: "status opened",
    });
    expect(
      await run(`return composer().querySelectorAll('[data-pill-id]').length;`),
    ).toBe(count);
    expect(
      await run(`return composer().textContent.includes('/status');`),
    ).toBe(false);
    expect(
      await run(
        `return visibleDock().querySelectorAll('[data-user-message]').length;`,
      ),
    ).toBe(sent);
    await app.press("Escape");
    await runWait(`return !$('[data-testid="session-inspector-content"]');`);
    // A skill the palette applies to a composer holding only pills is what
    // they are for (ADR 0270).
    await slashInPalette();
    await app.insertText("team-notes");
    await runWait(`return rowIds()[0] === 'skills:team-notes';`);
    await app.press("Enter");
    await runWait(
      `const message = lastSent();
       return !!message?.querySelector('[data-testid="sent-skill"]') &&
         !!message.querySelector('[data-testid="sent-pill"]');`,
      { timeoutMs: 30_000, label: "skill sent with the pills" },
    );
    // The agent got the invocation with the pill attached (the fake's
    // attachment echo), and its turn ends before the next test sends here.
    await runWait(
      `const log = visibleDock().querySelector('[role="log"]').textContent;
       return log.includes('[prose] Use the "team-notes" skill.') &&
         log.includes('[attachment 1:') && log.includes('Received 1 attachment');`,
      { timeoutMs: 30_000, label: "the skill's reply, with its attachment" },
    );
    expect(
      await run(`return composer().querySelectorAll('[data-pill-id]').length;`),
    ).toBe(0);
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("targets the focused chat from the palette, highlighting it", async () => {
    // The floating chat from the previous tests is focused; a skill row
    // must point at it (border accent) and send into it, not a new chat.
    const before = await run<string[]>(
      `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId).sort();`,
    );
    await ensurePalette();
    await paletteType(">checklist");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Checklist'));
       return !!row && !!$('[data-palette-target]');`,
      { timeoutMs: 15_000, label: "skill row highlights the focused chat" },
    );
    // Other skills can match "checklist" in their body. Select the intended
    // result explicitly; this scenario verifies its target, not search ranking.
    const point = await run<{ x: number; y: number }>(
      `const rect = paletteRows().find((el) => el.textContent.includes('Checklist')).getBoundingClientRect();
       return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };`,
    );
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
    // Another chat ran the checklist earlier: read this one's reply.
    await runWait(
      `return visibleDock().querySelector('[role="log"]').textContent.includes('skill loaded: checklist');`,
      { timeoutMs: 30_000, label: "checklist reply in the focused chat" },
    );
    const after = await run<string[]>(
      `return $$('[data-chat-local-id]').map(el => el.dataset.chatLocalId).sort();`,
    );
    expect(after).toEqual(before);
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
