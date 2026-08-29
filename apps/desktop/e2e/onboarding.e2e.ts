import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

/**
 * User-onboarding flows, asserted on the REAL filesystem and git repo the
 * app leaves behind — not just the UI. Two app instances: one for the
 * blank-project + checkpoint-commit loop, one (with the pick-folder seam)
 * for importing an existing folder in place.
 */

let app: AppHandle;

/** DOM helpers injected into every eval — keep selectors in one place. */
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
      { key, bubbles: true, cancelable: true, ...mods }));
  const timelineMessages = () =>
    $$('[role="log"] article').map((el) => el.textContent.trim());
`;

const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

/** System git against the project folder on disk — the source of truth. */
const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

/** Poll a filesystem/git condition (UI settles before disk does). */
const until = async (
  fn: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${label}`);
};

/** Drive the New-project modal to submission and wait for the workspace. */
const createProjectViaUi = async (name: string): Promise<void> => {
  await runWait(`return !!byText('button', 'New project');`, {
    timeoutMs: 60_000,
    label: "empty-state New project button",
  });
  await run(`byText('button', 'New project').click(); return true;`);
  await runWait(`return !!$('[data-testid="project-name-input"]');`);
  await run(`
    setReactValue($('[data-testid="project-name-input"]'), '${name}');
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
    { timeoutMs: 60_000, label: "palette New Tab after project creation" },
  );
};

describe("agent-first onboarding", () => {
  beforeAll(async () => {
    app = await launchApp();
    await run(`
      return window.catamorphicDesktop.agentsList().then((data) =>
        Promise.all(data.agents.map((agent) =>
          window.catamorphicDesktop.agentsRemove(agent.id))));
    `);
  });

  afterAll(async () => {
    await app?.stop();
  });

  it("creates a collision-safe Default Project and opens the agent wizard", async () => {
    const projectsDir = path.join(app.userDataDir, "Catamorphic");
    const occupiedDir = path.join(projectsDir, "default-project");
    fs.mkdirSync(occupiedDir, { recursive: true });
    fs.writeFileSync(path.join(occupiedDir, "KEEP.txt"), "leave me alone\n");

    await runWait(`return !!$('[data-testid="empty-start-agent"]');`, {
      timeoutMs: 60_000,
      label: "empty project state",
    });
    expect(await run(`return !!$('[data-testid="empty-start-agent"]');`)).toBe(
      true,
    );
    await run(`$('[data-testid="empty-start-agent"]').click(); return true;`);
    await runWait(
      `const wizard = $$('[data-testid="agent-wizard"]')
         .find((el) => !el.closest('[inert]'));
       return !!wizard &&
              !!byText('button', 'Default Project') &&
              !byText('[role="tab"], button', 'Set up agent');`,
      { timeoutMs: 60_000, label: "agent wizard over the default workspace" },
    );

    const createdDir = path.join(projectsDir, "default-project-2");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(createdDir, ".catamorphic/project.json"),
        "utf-8",
      ),
    ) as { name: string };
    expect(manifest.name).toBe("Default Project");
    expect(fs.readFileSync(path.join(occupiedDir, "KEEP.txt"), "utf-8")).toBe(
      "leave me alone\n",
    );

    await run(`
      $$('[data-testid="agent-wizard-free"]')
        .find((el) => !el.closest('[inert]'))
        .click();
      return true;
    `);
    await runWait(
      `return !$$('[data-testid="agent-wizard"]')
         .some((el) => !el.closest('[inert]')) &&
              !!byText('button', 'Default Project') &&
              !visibleDock();`,
      {
        timeoutMs: 15_000,
        label: "wizard closes into Default Project without opening chat",
      },
    );
  });

  it("allocates distinct folders for concurrent default projects", async () => {
    const roots = await run<(string | null)[]>(`
      return Promise.all([
        window.catamorphicDesktop.createDefaultProject(),
        window.catamorphicDesktop.createDefaultProject(),
      ]).then((projects) => Promise.all(projects.map((project) =>
        window.catamorphicDesktop.projectRoot(project.id))));
    `);

    expect(roots).toHaveLength(2);
    expect(roots[0]).not.toBeNull();
    expect(roots[1]).not.toBeNull();
    expect(roots[0]).not.toBe(roots[1]);
  });
});

describe("blank project onboarding", () => {
  let projectDir: string;

  beforeAll(async () => {
    app = await launchApp();
  });

  afterAll(async () => {
    await app?.stop();
  });

  it("creates a blank project with only manifest + seed skills, committed", async () => {
    await createProjectViaUi("onboard-blank");
    // E2E projects land under <userDataDir>/Catamorphic/<slug>.
    projectDir = path.join(app.userDataDir, "Catamorphic", "onboard-blank");
    expect(fs.existsSync(projectDir)).toBe(true);

    // The manifest names the project (ADR 0043).
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, ".catamorphic/project.json"),
        "utf-8",
      ),
    ) as { name: string };
    expect(manifest.name).toBe("onboard-blank");

    // Seed skills: reference material plus the scaffold's support files.
    for (const file of [
      ".agents/skills/catamorphic-projects/SKILL.md",
      ".agents/skills/catamorphic-projects/files/package.json",
    ]) {
      expect(fs.existsSync(path.join(projectDir, file)), file).toBe(true);
    }

    // NO eager workspace scaffold (ADR 0043): the workspace arrives on
    // demand, never at creation time.
    for (const file of ["package.json", "workflows", "contracts"]) {
      expect(fs.existsSync(path.join(projectDir, file)), file).toBe(false);
    }

    // One commit, and everything (dot-dirs included) is IN it — a dirty
    // status here would mean the .catamorphic/.agents allowlist regressed.
    await until(
      () => git(projectDir, "status", "--porcelain") === "",
      10_000,
      "clean status after project creation",
    );
    expect(git(projectDir, "log", "--format=%s")).toBe("Initial commit");
  });

  it("checkpoint-commits the agent's file edit into the project repo", async () => {
    // Open a chat in the project workspace and have the fake agent make a
    // real sandbox edit that syncs back as a changed file.
    await run(`pressKey('n', { metaKey: true }); return true;`);
    await runWait(`return !!visibleDock();`, { label: "floating chat open" });
    await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'edit a file');
      ta.closest('form').requestSubmit();
      return true;
    `);
    await runWait(
      `return timelineMessages().some((m) => m.includes('I created HELLO.md for you.'));`,
      { timeoutMs: 30_000, label: "fake agent reply in timeline" },
    );

    // Turn end triggers the checkpoint commit (ADR 0044): the dev repo —
    // the project folder itself — gets an agent-authored commit.
    await until(
      () =>
        git(projectDir, "log", "--format=%an|%s")
          .split("\n")
          .some((line) =>
            line.startsWith("Catamorphic Agent|Agent: edit a file"),
          ),
      15_000,
      "checkpoint commit by Catamorphic Agent",
    );
    await until(
      () => git(projectDir, "status", "--porcelain") === "",
      10_000,
      "clean status after the checkpoint",
    );
    // The synced file really landed in the working tree.
    expect(
      fs.readFileSync(path.join(projectDir, "HELLO.md"), "utf-8"),
    ).toContain("hello from the fake agent");
    // The turn must not have scaffolded a workflow workspace on the side
    // (guards the syncTypes gate for workspace-less projects).
    expect(fs.existsSync(path.join(projectDir, "workflows"))).toBe(false);
  });
});

describe("import an existing folder", () => {
  const NOTES = "# Notes\n\nhand-written before Catamorphic existed\n";
  const DATA = "nested,data\n1,2\n";
  let importDir: string;

  beforeAll(async () => {
    // A pre-existing folder the user "picks" — the seam stands in for the
    // native dialog CDP cannot drive.
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-e2e-import-"),
    );
    importDir = path.join(parent, "imported-notes");
    fs.mkdirSync(path.join(importDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(importDir, "notes.md"), NOTES);
    fs.writeFileSync(path.join(importDir, "nested", "data.txt"), DATA);
    app = await launchApp({
      env: { CATAMORPHIC_E2E_PICK_FOLDER: importDir },
    });
  });

  afterAll(async () => {
    await app?.stop();
    fs.rmSync(path.dirname(importDir), { recursive: true, force: true });
  });

  it("links the folder in place, inits git, and keeps the files intact", async () => {
    await runWait(`return !!byText('button', 'New project');`, {
      timeoutMs: 60_000,
      label: "empty-state New project button",
    });
    await run(`byText('button', 'New project').click(); return true;`);
    await runWait(`return !!byText('button', 'Import folder');`, {
      label: "project modal with Import mode",
    });
    await run(`byText('button', 'Import folder').click(); return true;`);
    await runWait(`return !!$('[data-testid="import-folder-picker"]');`, {
      label: "import folder picker",
    });
    // The seeded pick fills the folder and auto-names the project. The
    // click retries inside the poll: under full-suite load a single click
    // can land before React attaches the handler and silently do nothing.
    await runWait(
      `const done = byText('[data-testid="target-path"]', 'imported-notes') &&
              $('[data-testid="project-name-input"]')?.value === 'imported-notes';
       if (done) return true;
       $('[data-testid="import-folder-picker"]')?.click();
       return false;`,
      { label: "picked folder reflected in the modal", timeoutMs: 30_000 },
    );
    await runWait(
      `const btn = $('[data-testid="project-submit"]');
       if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "import submit enabled" },
    );
    await runWait(
      `return !!byText('[role="tab"], button', 'New Tab') &&
              !!$('textarea[placeholder*="Search or ask"]');`,
      { timeoutMs: 60_000, label: "workspace after import" },
    );

    // Original files intact, byte for byte.
    expect(fs.readFileSync(path.join(importDir, "notes.md"), "utf-8")).toBe(
      NOTES,
    );
    expect(
      fs.readFileSync(path.join(importDir, "nested", "data.txt"), "utf-8"),
    ).toBe(DATA);

    // The manifest was added in place, named after the folder.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(importDir, ".catamorphic/project.json"),
        "utf-8",
      ),
    ) as { name: string };
    expect(manifest.name).toBe("imported-notes");

    // Git initialized in place: one "Import project" commit, clean tree.
    await until(
      () => git(importDir, "status", "--porcelain") === "",
      10_000,
      "clean status after import",
    );
    expect(git(importDir, "log", "--format=%s")).toBe("Import project");

    // Import never scaffolds the workflow workspace either.
    for (const file of ["package.json", "workflows", "contracts"]) {
      expect(fs.existsSync(path.join(importDir, file)), file).toBe(false);
    }
  });
});
