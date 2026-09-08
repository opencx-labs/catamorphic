import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let temp: string;
let root: string;
let linked: string;
const helper = `const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)]; const byText = (s,t) => $$(s).find(e => e.textContent.trim().includes(t)); ${setReactValueJs}`;
const run = <T>(body: string) => app.eval<T>(`(()=>{${helper};${body}})()`);
const wait = (body: string) =>
  app.waitFor(`(()=>{${helper};${body}})()`, { timeoutMs: 60_000 });
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
beforeAll(async () => {
  temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "git-sidebar-e2e-")),
  );
  root = path.join(temp, "Project");
  linked = path.join(temp, "Feature");
  await fs.mkdir(root);
  await nativeGit(root, ["init", "-b", "trunk"]);
  await fs.writeFile(path.join(root, "notes.txt"), "Original document\n");
  await nativeGit(root, ["add", "."]);
  await nativeGit(root, [...author, "commit", "-m", "Initial"]);
  await nativeGit(root, ["worktree", "add", "-b", "feature/review", linked]);
  await fs.writeFile(
    path.join(linked, "notes.txt"),
    "Committed branch document\n",
  );
  await nativeGit(linked, ["add", "."]);
  await nativeGit(linked, [...author, "commit", "-m", "Branch change"]);
  await fs.writeFile(
    path.join(linked, "notes.txt"),
    "Private working document\n",
  );
  await fs.writeFile(path.join(root, "notes.txt"), "Staged primary document\n");
  await nativeGit(root, ["add", "."]);
  await fs.writeFile(
    path.join(root, "notes.txt"),
    "Working primary document\n",
  );
  app = await launchApp({
    env: {
      CATAMORPHIC_E2E_PICK_FOLDER: root,
      ...(process.env.CATAMORPHIC_GIT_SCREENSHOT
        ? { CATAMORPHIC_E2E_WINDOW_MODE: "visible" }
        : {}),
    },
  });
  await wait(`return !!byText('button','New project');`);
  await run(`byText('button','New project').click();return true;`);
  await wait(`return !!byText('button','Import folder');`);
  await run(`byText('button','Import folder').click();return true;`);
  await wait(`return !!$('[data-testid="import-folder-picker"]');`);
  await run(`$('[data-testid="import-folder-picker"]').click();return true;`);
  await wait(
    `return $('[data-testid="project-name-input"]')?.value.length > 0;`,
  );
  await run(
    `setReactValue($('[data-testid="project-name-input"]'), 'Git review');return true;`,
  );
  await wait(
    `const b=$('[data-testid="project-submit"]');if(b&&!b.disabled){b.click();return true;}return false;`,
  );
  await wait(`return $$('[data-worktree-path]').length === 2;`);
});
afterAll(async () => {
  await app?.stop();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});
it("groups worktrees and opens committed versus local diffs without crossing checkouts", async () => {
  expect(
    await run(
      `return $('[data-testid="git-changes"]').textContent.replaceAll("\u00a0", " ");`,
    ),
  ).toContain("Committed vs trunk");
  await run(
    `const tree=$$('[data-worktree-path]').find(e=>e.dataset.worktreePath===${JSON.stringify(linked)});tree.querySelector('[data-change-group="branch"] button').click();return true;`,
  );
  await wait(
    `return $('.monaco-diff-editor')?.textContent.replaceAll("\u00a0", " ").includes('Committed branch document');`,
  );
  expect(
    await run(
      `return $('.monaco-diff-editor').textContent.replaceAll("\u00a0", " ");`,
    ),
  ).not.toContain("Private working document");
  await run(
    `const tree=$$('[data-worktree-path]').find(e=>e.dataset.worktreePath===${JSON.stringify(root)});tree.querySelector('[data-change-group="unstaged"] button').click();return true;`,
  );
  await wait(
    `return $$('.monaco-diff-editor').some(e=>e.textContent.replaceAll("\u00a0", " ").includes('Working primary document'));`,
  );
  await fs.writeFile(path.join(root, "notes.txt"), "Edited outside the app\n");
  await run(`window.dispatchEvent(new Event('focus'));return true;`);
  await wait(
    `return $$('.monaco-diff-editor').some(e=>e.textContent.replaceAll("\u00a0", " ").includes('Edited outside the app'));`,
  );
  const header = `$$('[data-worktree-path]').find(e=>e.dataset.worktreePath===${JSON.stringify(linked)}).querySelector('h4 button')`;
  await run(`${header}.click();return true;`);
  expect(await run(`return ${header}.getAttribute('aria-expanded');`)).toBe(
    "false",
  );
  expect(
    await run(
      `return document.getElementById(${header}.getAttribute('aria-controls')).querySelector('[data-collapsible]').getAttribute('aria-hidden');`,
    ),
  ).toBe("true");
  await run(`${header}.click();return true;`);
  if (process.env.CATAMORPHIC_GIT_SCREENSHOT) {
    await app.eval(`window.catamorphicDesktop.devWindow('maximize')`);
    await app.screenshot(process.env.CATAMORPHIC_GIT_SCREENSHOT);
  }
  expect((await nativeGit(root, ["log", "--format=%s"])).trim()).toBe(
    "Initial",
  );
  expect((await nativeGit(linked, ["log", "--format=%s", "-1"])).trim()).toBe(
    "Branch change",
  );
});
