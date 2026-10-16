import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";
import { addSidebarSections } from "./sidebar-config.js";

/**
 * The project's changes as a source (`work:git`, ADR 0234): its checkouts
 * and the files changed in each, read through the observed overview
 * (ADR 0149). The default layout has no Changes section; the suite adds one,
 * as a person would.
 */
let app: AppHandle;
let temp: string;
let root: string;
let linked: string;
const visible = '[data-workspace-visible="true"]';
const changes = `${visible} [data-sidebar-widget="changes"]`;
const helper = `const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)]; const byText = (s,t) => $$(s).find(e => e.textContent.trim().includes(t)); const diffText = () => { const read = root => root.textContent + [...root.querySelectorAll("*")].filter(e => e.shadowRoot).map(e => read(e.shadowRoot)).join("\\n"); return $$("[data-testid=code-diff]").map(read).join("\\n").replaceAll("\\u00a0", " "); }; ${setReactValueJs}`;
const run = <T>(body: string) => app.eval<T>(`(()=>{${helper};${body}})()`);
const wait = (body: string, label?: string) =>
  app.waitFor(`(()=>{${helper};${body}})()`, {
    timeoutMs: 60_000,
    ...(label ? { label } : {}),
  });
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
/** A checkout's row, expanded so its changed files load. */
const expand = async (checkout: string) => {
  await wait(
    `return !!$('${changes} [data-sidebar-item-id=${JSON.stringify(checkout)}]');`,
    `the ${path.basename(checkout)} checkout listed`,
  );
  await run(
    `const row = $('${changes} [data-sidebar-item-id=${JSON.stringify(checkout)}]'); const toggle = row.querySelector('button[aria-expanded="false"]'); toggle?.click(); return true;`,
  );
};
const fileRow = (checkout: string, mode: string, file: string) =>
  `$('${changes} [data-sidebar-item-id=${JSON.stringify(`${checkout}:${mode}:${file}`)}]')`;

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
  app = await launchApp({ env: { CATAMORPHIC_E2E_PICK_FOLDER: root } });
  await wait(`return !!byText('button','Create or import project');`);
  await run(`byText('button','Create or import project').click();return true;`);
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
  await wait(`return !!$('${visible} [data-sidebar="left"]');`);
  await addSidebarSections(app, [
    { id: "changes", source: "work:git", title: "Changes", hideEmpty: true },
  ]);
});
afterAll(async () => {
  await app?.stop();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

it("lists each checkout and opens committed versus local diffs without crossing checkouts", async () => {
  await expand(linked);
  await wait(
    `return !!${fileRow(linked, "branch", "notes.txt")} && !!${fileRow(linked, "unstaged", "notes.txt")};`,
    "the feature checkout's committed and local changes",
  );
  await run(
    `${fileRow(linked, "branch", "notes.txt")}.querySelector('[data-tree-primary]').click();return true;`,
  );
  await wait(
    `return diffText().includes('Committed branch document');`,
    "the committed diff",
  );
  expect(await run(`return diffText();`)).not.toContain(
    "Private working document",
  );
  await expand(root);
  await wait(
    `return !!${fileRow(root, "unstaged", "notes.txt")};`,
    "the project folder's local change",
  );
  await run(
    `${fileRow(root, "unstaged", "notes.txt")}.querySelector('[data-tree-primary]').click();return true;`,
  );
  await wait(
    `return diffText().includes('Working primary document');`,
    "the working diff",
  );
  expect((await nativeGit(root, ["log", "--format=%s"])).trim()).toBe(
    "Initial",
  );
});

it("finds changed files in the palette, naming their checkout", async () => {
  // Find changed files (Cmd+Alt+F): Alt is 1, Ctrl 2, Meta 4.
  await app.press("f", process.platform === "darwin" ? 5 : 3);
  await wait(`return !!$('textarea[placeholder="Search changes…"]');`);
  await run(
    `setReactValue($('textarea[placeholder="Search changes…"]'), 'notes.txt');`,
  );
  const options = `[...$('textarea[placeholder="Search changes…"]').closest('[role="dialog"]').querySelectorAll('[role="option"]')]`;
  await wait(
    `return ${options}.some(row => row.textContent.includes('feature/review') && row.textContent.includes('branch'));`,
    "the feature checkout's committed change found",
  );
  await run(
    `${options}.find(row => row.textContent.includes('feature/review') && row.textContent.includes('branch')).dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));`,
  );
  await wait(`return diffText().includes('Committed branch document');`);
});

it("follows writes, staging and removal promptly, without taking focus", async () => {
  const file = path.join(linked, "live-refresh.txt");
  await expand(linked);
  // Focus something the person could be using: the list's own reads must
  // not take it.
  await run(
    `${fileRow(linked, "branch", "notes.txt")}.querySelector('[data-tree-primary]').focus(); return true;`,
  );
  const focused = () =>
    app.eval<string | null>(
      `document.activeElement?.closest('[data-sidebar-item-id]')?.getAttribute('data-sidebar-item-id') ?? null`,
    );
  const before = await focused();
  await fs.writeFile(file, "External editor change\n");
  await wait(
    `return !!${fileRow(linked, "untracked", "live-refresh.txt")};`,
    "the new file listed",
  );
  expect(await focused()).toBe(before);
  await nativeGit(linked, ["add", "live-refresh.txt"]);
  await wait(
    `return !!${fileRow(linked, "staged", "live-refresh.txt")};`,
    "the staged file listed",
  );
  await nativeGit(linked, ["reset", "HEAD", "--", "live-refresh.txt"]);
  await fs.rm(file);
  await wait(
    `return !$('${changes}').textContent.includes('live-refresh.txt');`,
    "the removed file gone",
  );
});

it("follows another project's checkout, then this one again", async () => {
  const plain = path.join(temp, "Plain");
  await fs.mkdir(plain);
  await nativeGit(plain, ["init", "-b", "main"]);
  await fs.writeFile(path.join(plain, "README.md"), "Plain\n");
  await nativeGit(plain, ["add", "."]);
  await nativeGit(plain, [...author, "commit", "-m", "Initial"]);
  const original = await app.eval<string>(
    "window.catamorphicDesktop.getPrefs().then((prefs) => prefs.lastProjectId)",
  );
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Plain',rootPath:${JSON.stringify(plain)},importExisting:true})`,
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(project.id)}})`,
  );
  await expand(plain);
  await fs.writeFile(path.join(plain, "after-commit.txt"), "Back again\n");
  await wait(
    `return $('${changes}')?.textContent.includes('after-commit.txt');`,
    "an external write listed",
  );
  await fs.rm(path.join(plain, "after-commit.txt"));
  await wait(
    `return !$('${changes}')?.textContent.includes('after-commit.txt');`,
    "the removed file gone",
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId: ${JSON.stringify(original)}})`,
  );
  await wait(
    `return !!$('${changes} [data-sidebar-item-id=${JSON.stringify(linked)}]');`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
