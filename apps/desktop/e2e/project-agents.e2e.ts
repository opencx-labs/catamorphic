import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Project agents (ADR 0050): committed `agents/<slug>.json` definitions
 * surface in the palette's agent pickers under a "Project agents" group,
 * run through the registry (`project:<projectId>:<slug>` ids), and gate
 * personal credentials behind the consent dialog.
 *
 * The definitions use the `e2e-fake` kind — accepted only under
 * CATAMORPHIC_E2E_FAKE_AGENT=1 (the same seam family as the pick-folder
 * stub) and auto-consented, since the fake touches no credentials — plus
 * a `claude-code` one to exercise the consent dialog (in e2e mode every
 * harness build resolves to the scripted fake, so approving is safe).
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

const resetPalette = async () => {
  await run(`
    setReactValue(paletteInput(), '');
    paletteInput().dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Backspace', bubbles: true, cancelable: true }));
    return true;
  `);
};

const pickOption = (text: string) => `
  const opt = paletteRows().find((el) => el.textContent.includes('${text}'));
  if (!opt) return false;
  opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
`;

const openPicker = async (command: string, chip: string) => {
  await ensurePalette();
  await resetPalette();
  await run(`setReactValue(paletteInput(), '${command}'); return true;`);
  await runWait(pickOption(command), { label: `${command} row` });
  await runWait(
    `const c = $('[data-testid="palette-mode-chip"]');
     return !!c && c.textContent.includes('${chip}');`,
    { label: `${chip} chip active` },
  );
};

const paletteEscape = `
  window.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Escape', bubbles: true, cancelable: true }));
  return true;
`;

describe("project agents", () => {
  it("boots into a project workspace", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty state",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!$('[data-testid="project-name-input"]');`);
    await run(`
      setReactValue($('[data-testid="project-name-input"]'), 'e2e-proj-agents');
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

  it("finds the project's folder and writes committed agent definitions", async () => {
    const resolved = await runWaitAsync<{ id: string; root: string } | false>(
      `const server = await window.catamorphicDesktop.getServerState();
       if (!server.url) return false;
       const response = await fetch(server.url + '/api/projects');
       const data = await response.json();
       const project = (data.items ?? []).find((p) => p.name === 'e2e-proj-agents');
       if (!project) return false;
       const root = await window.catamorphicDesktop.projectRoot(project.id);
       if (!root) return false;
       return { id: project.id, root };`,
      { timeoutMs: 30_000, label: "project id + root path" },
    );
    if (!resolved) throw new Error("project root not resolved");
    projectRoot = resolved.root;

    // The work-product shape: a definition, its persona, a second
    // definition that needs consent, and one broken file.
    const agentsDir = path.join(projectRoot, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "helper.json"),
      `${JSON.stringify({ version: 1, name: "Helper", kind: "e2e-fake", description: "Project helper" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(agentsDir, "helper.md"),
      "# Helper persona\nAlways be helping.\n",
    );
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.json"),
      `${JSON.stringify({ version: 1, name: "Reviewer", kind: "claude-code", credentials: { source: "profile" } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(agentsDir, "broken.json"), "{ not json\n");
  });

  it("lists project agents in the picker under their scope label, broken ones disabled", async () => {
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `const dlg = paletteInput().closest('[role="dialog"]');
       const label = [...dlg.querySelectorAll('div')]
         .some((el) => el.textContent.trim() === 'Project agents');
       const helper = paletteRows().find((el) => el.textContent.includes('Helper'));
       return label && !!helper && helper.textContent.includes('Fake harness');`,
      { timeoutMs: 15_000, label: "Project agents group with Helper row" },
    );
    // The broken definition is visible but disabled, its error where the
    // description goes — diagnosable straight from the picker.
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('broken'));
       return !!row && row.getAttribute('aria-disabled') === 'true' &&
              row.textContent.includes('JSON');`,
      { label: "broken definition disabled with its error" },
    );
    await run(paletteEscape);
  });

  it("switches a chat to the fake project agent without consent and gets a reply", async () => {
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "chat open" });
    // A first turn anchors the session on the profile default — the
    // switch below must then leave a marker naming the PROJECT agent.
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'warm up');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: warm up'));`,
      { timeoutMs: 30_000, label: "session anchored on the default agent" },
    );
    await openPicker("Switch agent for this chat", "Chat agent");
    await runWait(pickOption("Helper"), { label: "pick Helper" });
    // No consent dialog for the fake kind (auto-consent under the e2e
    // flag): the switch lands directly, marked with the DEFINITION's name.
    await runWait(
      `return $$('[role="log"] div')
        .some((el) => el.textContent.trim() === 'Switched to Helper');`,
      {
        timeoutMs: 15_000,
        label: "switch marker shows the project agent's name",
      },
    );
    await run(`
      const ta = visibleDock().querySelector('form textarea');
      setReactValue(ta, 'hello project agent');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return $$('[role="log"] article')
        .some((el) => el.textContent.includes('You said: hello project agent'));`,
      { timeoutMs: 30_000, label: "reply from the project agent" },
    );
  });

  it("gates a profile-credentialed project agent behind the consent dialog", async () => {
    await runWait(`return !!visibleDock();`, { label: "chat still open" });
    await openPicker("Switch agent for this chat", "Chat agent");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Reviewer'));
       return !!row && row.textContent.includes('needs approval');`,
      { label: "Reviewer row marked as needing approval" },
    );
    await runWait(pickOption("Reviewer"), { label: "pick Reviewer" });
    // The pick does NOT switch yet — the consent dialog takes over.
    await runWait(
      `return !!$('[data-testid="project-agent-consent"]') &&
              !!byText('[data-testid="project-agent-consent"] *', 'Claude Code');`,
      {
        timeoutMs: 15_000,
        label: "consent dialog with the definition summary",
      },
    );
    await run(
      `$('[data-testid="project-agent-approve"]').click(); return true;`,
    );
    await runWait(
      `return $$('[role="log"] div')
        .some((el) => el.textContent.trim() === 'Switched to Reviewer');`,
      { timeoutMs: 15_000, label: "approved agent switched in" },
    );
    // Re-opening the picker shows it approved — consent is recorded.
    await openPicker("Switch agent for this chat", "Chat agent");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Reviewer'));
       return !!row && row.textContent.includes('approved');`,
      { label: "Reviewer row now approved" },
    );
    await run(paletteEscape);
  });

  it("re-requires consent after the persona file changes", async () => {
    // A persona edit changes the definition hash → stored consent stale.
    fs.appendFileSync(
      path.join(projectRoot, "agents", "reviewer.md"),
      "Now with different instructions.\n",
    );
    // The default-agent picker (always available) shows the same consent
    // state — no dependency on which surface holds focus by now.
    await openPicker("Change default agent", "Default agent");
    await runWait(
      `const row = paletteRows().find((el) => el.textContent.includes('Reviewer'));
       return !!row && row.textContent.includes('changed');`,
      { timeoutMs: 15_000, label: "Reviewer consent went stale" },
    );
    await run(paletteEscape);
  });
});
