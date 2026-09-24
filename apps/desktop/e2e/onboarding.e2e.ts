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
      { key, bubbles: true, cancelable: true, ...(mods.metaKey && !/Mac/.test(navigator.platform) ? { ...mods, metaKey: false, ctrlKey: true } : mods) }));
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
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (fn()) return;
      lastError = undefined;
    } catch (error) {
      // The app may be replacing the git index while this test observes it.
      // Treat read failures like any other unsettled condition, but preserve
      // the last error so a persistent failure remains actionable.
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const detail =
    lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${label}${detail}`);
};

/** Drive the New-project modal to submission and wait for the workspace. */
const createProjectViaUi = async (name: string): Promise<void> => {
  await runWait(`return !!byText('button', 'Create or import project');`, {
    timeoutMs: 60_000,
    label: "empty-state Create or import project button",
  });
  await run(
    `byText('button', 'Create or import project').click(); return true;`,
  );
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
    const projectsDir = path.join(app.userDataDir, "Work");
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

    // Both detected-login branches must fit inside a narrow dialog. In
    // the old shared row, the long labels wrapped outside 32px buttons.
    for (const provider of ["codex", "claude-code"]) {
      await run(`
        const wizard = $$('[data-testid="agent-wizard"]').find(el => !el.closest('[inert]'));
        wizard.querySelector('[data-testid="agent-wizard-${provider}"]').click();
      `);
      await runWait(
        `return $$('[data-testid="agent-wizard-back"]').some(el => !el.closest('[inert]'));`,
      );
      for (const width of [440, 280]) {
        const fits = await run<boolean>(`
          const wizard = $$('[data-testid="agent-wizard"]').find(el => !el.closest('[inert]'));
          wizard.style.width = '${width}px';
          const actions = [...wizard.querySelectorAll('button')].filter(el => !el.hasAttribute('data-testid'));
          return actions.length === 2 && actions.every(button => {
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button.firstElementChild.firstElementChild);
            const label = range.getBoundingClientRect();
            return label.left >= rect.left && label.right <= rect.right &&
              label.top >= rect.top && label.bottom <= rect.bottom;
          }) && wizard.scrollWidth <= wizard.clientWidth;
        `);
        expect(fits, `${provider} actions at ${width}px`).toBe(true);
      }
      await run(`
        const wizard = $$('[data-testid="agent-wizard"]').find(el => !el.closest('[inert]'));
        wizard.style.maxHeight = '180px';
        wizard.querySelector('button:last-child').scrollIntoView({block:'end'});
      `);
      expect(
        await run(`
        const wizard = $$('[data-testid="agent-wizard"]').find(el => !el.closest('[inert]'));
        return wizard.scrollTop > 0 && wizard.clientHeight <= 180;
      `),
      ).toBe(true);
      await run(`
        const wizard = $$('[data-testid="agent-wizard"]').find(el => !el.closest('[inert]'));
        wizard.style.width = ''; wizard.style.maxHeight = '';
        wizard.querySelector('[data-testid="agent-wizard-back"]').click();
      `);
    }

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
    // E2E projects land under <userDataDir>/Work/<slug>.
    projectDir = path.join(app.userDataDir, "Work", "onboard-blank");
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
      ".catamorphic/skills/catamorphic-projects/SKILL.md",
      ".catamorphic/skills/catamorphic-projects/files/package.json",
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

describe.each([false, true])(
  "import an existing folder (Git: %s)",
  (versioned) => {
    const NOTES = "# Notes\n\nhand-written before Work existed\n";
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
      if (versioned) {
        git(importDir, "init", "-b", "feature");
        git(importDir, "add", ".");
        git(
          importDir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Existing history",
        );
      }
      fs.writeFileSync(path.join(importDir, "draft.txt"), "Private draft");
      app = await launchApp({
        env: { CATAMORPHIC_E2E_PICK_FOLDER: importDir },
      });
    });

    afterAll(async () => {
      await app?.stop();
      fs.rmSync(path.dirname(importDir), { recursive: true, force: true });
    });

    it("opens the folder in place without adding files or changing history", async () => {
      await runWait(`return !!byText('button', 'Create or import project');`, {
        timeoutMs: 60_000,
        label: "empty-state Create or import project button",
      });
      await run(
        `byText('button', 'Create or import project').click(); return true;`,
      );
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

      expect(
        fs.existsSync(path.join(importDir, ".catamorphic/project.json")),
      ).toBe(false);
      if (versioned) {
        expect(git(importDir, "log", "--format=%s")).toBe("Existing history");
        expect(git(importDir, "branch", "--show-current")).toBe("feature");
        expect(git(importDir, "status", "--porcelain")).toBe("?? draft.txt");
      } else {
        expect(fs.existsSync(path.join(importDir, ".git"))).toBe(false);
      }

      // Import never scaffolds the workflow workspace either.
      for (const file of ["package.json", "workflows", "contracts"]) {
        expect(fs.existsSync(path.join(importDir, file)), file).toBe(false);
      }
    });
    it("lets the agent edit without initializing or committing the imported folder", async () => {
      await run(`pressKey('n', { metaKey: true }); return true;`);
      await runWait(`return !!visibleDock();`);
      await run(`
      const ta = visibleDock().querySelector('[data-composer-input]');
      setReactValue(ta, 'edit a file');
      ta.closest('form').requestSubmit();
      return true;
    `);
      await runWait(
        `return timelineMessages().some((m) => m.includes('I created HELLO.md for you.'));`,
        { timeoutMs: 30_000 },
      );
      await until(
        () => fs.existsSync(path.join(importDir, "HELLO.md")),
        15_000,
        "agent edit saved to imported folder",
      );
      expect(
        fs.readFileSync(path.join(importDir, "HELLO.md"), "utf8"),
      ).toContain("hello from the fake agent");
      expect(fs.existsSync(path.join(importDir, ".agents"))).toBe(false);
      expect(
        fs.existsSync(path.join(importDir, ".catamorphic/project.json")),
      ).toBe(false);
      if (versioned)
        expect(git(importDir, "log", "--format=%s")).toBe("Existing history");
      else expect(fs.existsSync(path.join(importDir, ".git"))).toBe(false);
    });
    it("adds capabilities inside .catamorphic while keeping the imported root and Git unchanged", async () => {
      const before = fs.readdirSync(importDir).sort();
      const existingPackage =
        '{"name":"existing","packageManager":"pnpm@10.0.0"}\n';
      fs.writeFileSync(path.join(importDir, "package.json"), existingPackage);
      await run(`
        const ta = visibleDock().querySelector('[data-composer-input]');
        setReactValue(ta, 'Create a contained workspace');
        ta.closest('form').requestSubmit();
        return true;
      `);
      await runWait(
        `return timelineMessages().some((m) => m.includes('Created the workflow, app, and local data inside'));`,
        { timeoutMs: 30_000 },
      );
      await until(
        () =>
          fs.existsSync(
            path.join(importDir, ".catamorphic/app-data/catalog/items.json"),
          ),
        15_000,
        "contained app data",
      );
      expect(
        fs.readFileSync(path.join(importDir, "package.json"), "utf8"),
      ).toBe(existingPackage);
      expect(
        fs
          .readdirSync(importDir)
          .filter((name) => name !== ".catamorphic" && name !== "package.json")
          .sort(),
      ).toEqual(before);
      expect(
        fs.existsSync(
          path.join(importDir, ".catamorphic/workflows/src/catalog.ts"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(importDir, ".catamorphic/apps/catalog/package.json"),
        ),
      ).toBe(true);
      await runWait(
        `const button = document.querySelector('[role="tree"][aria-label="Apps"] button'); if (!button) return false; button.click(); return true;`,
        { label: "new app in sidebar" },
      );
      await runWait(
        `return document.body.textContent.includes('This app has no successful build yet. Ask the assistant to build it.');`,
        { label: "unbuilt app guidance" },
      );
      if (versioned) {
        expect(git(importDir, "log", "--format=%s")).toBe("Existing history");
        expect(
          git(
            importDir,
            "check-ignore",
            ".catamorphic/app-data/catalog/items.json",
          ),
        ).toBe(".catamorphic/app-data/catalog/items.json");
      } else expect(fs.existsSync(path.join(importDir, ".git"))).toBe(false);
    });
    it("builds contained apps and persists workflow data across runs", async () => {
      await run(`
        const ta = visibleDock().querySelector('[data-composer-input]');
        setReactValue(ta, 'build contained app');
        ta.closest('form').requestSubmit();
        return true;
      `);
      await runWait(
        `return timelineMessages().some(message => message.includes('preview_ready'));`,
        { timeoutMs: 90_000, label: "contained app compiled" },
      );
      await run(
        `visibleDock().querySelector('[aria-label="Minimize chat to bubble"]').click(); return true;`,
      );
      await runWait(
        `const row = document.querySelector('[role="tree"][aria-label="Workflows"] button'); if (!row) return false; row.click(); return true;`,
        { label: "open contained workflow" },
      );
      const clickWorkflowButton = async (name: string) => {
        await runWait(
          `const button = $$('.workflow-workbench button').find(el => !el.closest('[inert]') && el.innerText.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) return false; button.click(); return true;`,
          { timeoutMs: 30_000, label: name },
        );
      };
      // A root store/ belongs to the imported project, not Work's data API.
      fs.mkdirSync(path.join(importDir, "store"), { recursive: true });
      fs.writeFileSync(
        path.join(importDir, "store/inventory.txt"),
        "user-owned inventory",
      );
      await clickWorkflowButton("Run");
      await runWait(
        `return $('[data-testid="workflow-runs"]')?.textContent.includes('store/inventory.txt');`,
        { label: "ordinary root store file is recordable" },
      );
      // One action records the saved changes and publishes them.
      await clickWorkflowButton("Publish");
      await runWait(
        `return !$('[data-testid="workflow-publish"]') && $('[data-testid="workflow-runs"]')?.textContent.includes('published version');`,
        { timeoutMs: 60_000, label: "workflow published" },
      );
      expect(fs.existsSync(path.join(importDir, ".git"))).toBe(true);
      for (const count of [1, 2]) {
        await clickWorkflowButton("Start run");
        await until(
          () =>
            fs.readFileSync(
              path.join(importDir, ".catamorphic/app-data/catalog/runs.txt"),
              "utf8",
            ) === String(count),
          60_000,
          "persistent workflow data",
        );
        await runWait(
          `return $$('.workflow-run-row').filter(row => row.textContent.includes('completed')).length === ${count};`,
          { timeoutMs: 30_000, label: "workflow completed" },
        );
      }
      expect(git(importDir, "status", "--porcelain")).toBe("");
      expect(git(importDir, "ls-files")).toContain("store/inventory.txt");
      expect(git(importDir, "ls-files")).not.toContain("app-data");
      expect(app.getRendererErrors()).toEqual([]);
    }, 180_000);
  },
);
