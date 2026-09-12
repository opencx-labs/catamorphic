import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

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
    await run(
      `const row = $('[data-testid="slash-menu"] [data-skill-name="team-notes"]');
       row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
       return true;`,
    );
    expect(await run(`return composer().textContent;`)).toBe("/team");
    await run(
      `$('[data-testid="slash-menu"] [data-skill-name="team-notes"]').click(); return true;`,
    );
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: team-notes') &&
              !!byText('section[aria-label] *', 'source:project');`,
      { timeoutMs: 30_000, label: "project skill loaded reply" },
    );
  });

  it("uses live input when Enter arrives before the menu rerenders", async () => {
    await run(`setReactValue(composer(), '/team'); return true;`);
    await runWait(
      `return !!$('[data-testid="slash-menu"] [data-skill-name="team-notes"]');`,
    );
    await run(
      `setReactValue(composer(), 'Keep this freshly typed message'); composerKey('Enter'); return true;`,
    );
    await runWait(
      `return !!byText('[role="log"] *', 'You said: Keep this freshly typed message');`,
    );

    await run(`setReactValue(composer(), '/team'); return true;`);
    await runWait(
      `return !!$('[data-testid="slash-menu"] [data-skill-name="team-notes"]');`,
    );
    await run(
      `setReactValue(composer(), '/team-notes keep the freshly typed arguments'); composerKey('Tab'); composer().closest('form').requestSubmit(); return true;`,
    );
    await runWait(
      `return !!byText('[role="log"] *', 'Use the "team-notes" skill: keep the freshly typed arguments');`,
    );
  });

  it("completes a command with Tab, leaves space for arguments, and keeps IME and Escape safe", async () => {
    await run(`setReactValue(composer(), '/team'); return true;`);
    await runWait(
      `return !!$('[data-testid="slash-menu"] [data-skill-name="team-notes"]') && !$('[aria-label="Commands"][aria-busy="true"]');`,
    );
    await run(`composerKey('Enter', { isComposing: true }); return true;`);
    expect(await run(`return composer().textContent;`)).toBe("/team");
    await run(`composerKey('Escape'); return true;`);
    await runWait(`return !$('[data-testid="slash-menu"]');`);
    expect(await run(`return !!composer();`)).toBe(true);
    await run(`setReactValue(composer(), '/team-'); return true;`);
    await runWait(`return !!$('[data-testid="slash-menu"]');`);
    await run(`composerKey('Tab'); return true;`);
    await runWait(`return !$('[data-testid="slash-menu"]');`);
    expect(
      await run(`return composer().textContent.replaceAll('\u00a0', ' ');`),
    ).toBe("/team-notes ");
    await run(
      `setReactValue(composer(), '/team-notes include the decisions'); return true;`,
    );
    await run(`composer().closest('form').requestSubmit(); return true;`);
    await runWait(
      `return !!byText('[role="log"] *', 'Use the "team-notes" skill: include the decisions');`,
    );
  });

  it("shows an empty state and links keyboard navigation to the active option", async () => {
    await run(`setReactValue(composer(), '/zzzznonexistent'); return true;`);
    await runWait(
      `return !!byText('[data-testid="slash-menu"]', 'No matching commands');`,
    );
    await run(`setReactValue(composer(), '/'); return true;`);
    await runWait(
      `return $('[data-testid="slash-menu"] [role="option"]') && !$('[aria-label="Commands"][aria-busy="true"]');`,
    );
    await run(`composerKey('ArrowDown'); return true;`);
    await runWait(
      `const active = document.getElementById(composer().getAttribute('aria-activedescendant')); return active && active.getAnimations().length === 0;`,
    );
    await app.screenshot("/tmp/catamorphic-slash-menu.png");
    expect(
      await run(
        `const active = document.getElementById(composer().getAttribute('aria-activedescendant')); return active?.getAttribute('aria-selected');`,
      ),
    ).toBe("true");
    expect(
      await run(
        `return !!document.getElementById(composer().getAttribute('aria-controls'));`,
      ),
    ).toBe(true);
    await run(
      `composerKey('Escape'); setReactValue(composer(), ''); return true;`,
    );
  });

  it("keeps the selected row visible in the compact light composer", async () => {
    await app.eval(
      `window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
    );
    await app.waitFor(`document.documentElement.dataset.theme === 'light'`);
    await app.eval(`window.catamorphicDesktop.devWindow('setSize',840,650)`);
    await run(`setReactValue(composer(), '/'); return true;`);
    await runWait(
      `return $('[data-testid="slash-menu"] [role="option"]') && !$('[aria-label="Commands"][aria-busy="true"]');`,
    );
    for (let index = 0; index < 20; index++)
      await run(`composerKey('ArrowDown'); return true;`);
    await runWait(
      `const list = document.getElementById(composer().getAttribute('aria-controls')); const active = document.getElementById(composer().getAttribute('aria-activedescendant')); if (!list || !active) return false; const a = active.getBoundingClientRect(), b = list.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && active.getAnimations().length === 0;`,
    );
    await app.screenshot("/tmp/catamorphic-slash-menu-light.png");
    expect(app.getRendererErrors()).toEqual([]);
    await run(
      `composerKey('Escape'); setReactValue(composer(), ''); return true;`,
    );
    await app.eval(
      `window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
    );
    await app.eval(`window.catamorphicDesktop.devWindow('setSize',1200,800)`);
  });

  it("surfaces discovery errors, preserves the draft, and recovers with Retry", async () => {
    await app.blockRequests(["*/api/projects/*/skills"]);
    try {
      await run(`setReactValue(composer(), '/team'); return true;`);
      await runWait(
        `return !!byText('[data-testid="slash-menu"]', 'Could not load skills');`,
      );
      await run(`composer().closest('form').requestSubmit(); return true;`);
      expect(await run(`return composer().textContent;`)).toBe("/team");
    } finally {
      await app.blockRequests([]);
    }
    await run(
      `byText('[data-testid="slash-menu"] button', 'Retry').click(); return true;`,
    );
    await runWait(
      `return !!$('[data-testid="slash-menu"] [data-skill-name="team-notes"]');`,
    );
    await run(`setReactValue(composer(), ''); return true;`);
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
    const dir = path.join(projectRoot, "agents");
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
    await app.eval(
      `${invoke}.then(({api,projectId}) => api.projectAgentApprove(projectId, 'release-claude'))`,
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

  it("clears stale native rows when switching harnesses in the same chat", async () => {
    const nativeDir = path.join(projectRoot, ".codex/skills/native-notes");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "SKILL.md"), "Native notes fixture.");
    for (const [name, command, absent] of [
      ["Catalog claude", "compact", "native-notes"],
      ["Catalog codex", "native-notes", "compact"],
      ["Fake Agent", "team-notes", "native-notes"],
    ]) {
      await ensurePalette();
      await paletteType(">switch agent");
      await runWait(
        `const row = paletteRows().find(el => el.textContent.includes('Switch agent for this chat')); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true})); return true;`,
      );
      await runWait(
        `const row = paletteRows().find(el => el.textContent.includes(${JSON.stringify(name)})); if (!row) return false; row.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true})); return true;`,
      );
      await runWait(
        `return !!byText('[role="log"] div', ${JSON.stringify(`Switched to ${name}`)});`,
      );
      await run(`setReactValue(composer(), '/'); return true;`);
      await runWait(
        `return !!$('[data-testid="slash-menu"] [data-skill-name="${command}"]') && !$('[aria-label="Commands"][aria-busy="true"]');`,
      );
      await runWait(
        `return !$('[data-testid="slash-menu"] [data-skill-name="${absent}"]');`,
        { label: `remove ${absent} after switching to ${name}` },
      );
      // Use Chromium's editing/keyboard path for each harness, including
      // Tab completion, trailing whitespace, arguments, and dispatch.
      await run(
        `setReactValue(composer(), ''); composer().focus(); return true;`,
      );
      await app.insertText(`/${command}`);
      await runWait(
        `return !!$('[data-testid="slash-menu"] [data-skill-name="${command}"]');`,
      );
      await app.press("Tab");
      expect(await run(`return composer().textContent;`)).toBe(`/${command} `);
      await app.insertText("release 42");
      await app.press("Enter");
      const reply =
        name === "Catalog claude"
          ? "You said: /compact release 42"
          : name === "Catalog codex"
            ? "native skill loaded: Native notes fixture. | release 42"
            : "skill loaded: team-notes";
      await runWait(
        `return visibleDock().querySelector('[role="log"]').textContent.includes(${JSON.stringify(reply)});`,
        { label: `${name} command reply`, timeoutMs: 30_000 },
      );
      expect(await run(`return composer().textContent;`)).toBe("");
    }
  });

  it("opens local status without sending or discarding attached context", async () => {
    await run(
      `const data = new DataTransfer(); data.setData('text/plain', 'Meeting context. '.repeat(100)); composer().dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data})); return true;`,
    );
    await runWait(
      `return composer().querySelectorAll('[data-pill-id]').length > 0;`,
    );
    const count = await run<number>(
      `return composer().querySelectorAll('[data-pill-id]').length;`,
    );
    await run(`setReactValue(composer(), '/status'); return true;`);
    await run(`composer().closest('form').requestSubmit(); return true;`);
    expect(
      await run(`return composer().querySelectorAll('[data-pill-id]').length;`),
    ).toBe(count);
    expect(
      await run(`return composer().textContent.includes('/status');`),
    ).toBe(false);
    await run(
      `pressKey('Escape'); composer().replaceChildren(); composer().dispatchEvent(new InputEvent('input', {bubbles:true})); return true;`,
    );
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
    await run(
      `paletteInput().dispatchEvent(new KeyboardEvent('keydown',
         { key: 'Enter', bubbles: true, cancelable: true }));
       return true;`,
    );
    await runWait(
      `return !!byText('section[aria-label] *', 'skill loaded: checklist');`,
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
