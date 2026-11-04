import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

/**
 * History (ADR 0154) belongs to the profile: files of two projects and a
 * file outside any project all show on one page, the scope menu narrows
 * the page to one project, and a loose file reopens as a browser tab.
 * The palette's History mode also finds the project's chats by the words
 * written in them.
 */
let app: AppHandle;
let first: { id: string };
let second: { id: string };
let loosePath: string;

const isMac = `(/Mac/.test(navigator.platform))`;
const paletteInput = `[...document.querySelectorAll('textarea[aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0)`;
const rows = `[...document.querySelectorAll('[data-testid="history-row"]')]`;
const visibleRows = `${rows}.map((row) => row.textContent)`;

beforeAll(async () => {
  app = await launchApp();
  const create = (name: string) =>
    app.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject(${JSON.stringify({
        name,
        rootPath: path.join(app.userDataDir, name),
      })})`,
    );
  first = await create("Field research");
  fs.writeFileSync(
    path.join(app.userDataDir, "Field research", "notes.md"),
    "# Notes\nKept in the profile's history.\n",
  );
  second = await create("Kitchen");
  fs.writeFileSync(
    path.join(app.userDataDir, "Kitchen", "recipe.md"),
    "# Recipe\nAlso kept.\n",
  );
  loosePath = path.join(app.userDataDir, "loose-letter.txt");
  fs.writeFileSync(loosePath, "A file outside every project.\n");
});
afterAll(async () => {
  await app?.stop();
});

const openIn = async (
  projectId: string,
  surface: { url: string; title: string; open?: "browser" | "page" },
) => {
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
      projectId,
      surface: { ...surface, mode: "tab", nonce: crypto.randomUUID() },
    })})`,
  );
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(projectId)}`,
    { label: `workspace of ${projectId}` },
  );
};

describe("profile history", () => {
  it("records files of each project and a file outside any project", async () => {
    await openIn(first.id, { url: "file:notes.md", title: "Notes" });
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({}).then((page) => page.entries.some((entry) => entry.target.kind === 'file' && entry.target.projectId === ${JSON.stringify(first.id)} && entry.project?.name === 'Field research'))`,
      { label: "first project's file recorded" },
    );
    await openIn(second.id, { url: "file:recipe.md", title: "Recipe" });
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({}).then((page) => page.entries.some((entry) => entry.target.kind === 'file' && entry.target.projectId === ${JSON.stringify(second.id)}))`,
      { label: "second project's file recorded" },
    );
    // A file outside the project, opened as a browser tab from Kitchen.
    await openIn(second.id, {
      url: `file://${loosePath}`,
      title: "loose-letter.txt",
      open: "browser",
    });
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({}).then((page) => page.entries.some((entry) => entry.target.kind === 'local' && entry.target.path === ${JSON.stringify(loosePath)} && entry.project?.id === ${JSON.stringify(second.id)}))`,
      { label: "loose file recorded" },
    );
    const page = await app.eval<{ projects: { name: string }[] }>(
      "window.catamorphicDesktop.historyQuery({})",
    );
    expect(page.projects.map((project) => project.name)).toEqual([
      "Kitchen",
      "Field research",
    ]);
  });

  it("the History page shows everything and the scope menu narrows it to one project", async () => {
    // The palette route to the page is covered by the browser-import suite.
    await openIn(second.id, { url: "history", title: "History", open: "page" });
    await app.waitFor(
      `!!document.querySelector('[data-testid="history-page"]')`,
      {
        label: "history page",
      },
    );
    await app.waitFor(`${rows}.length >= 3`, { label: "every row" });
    expect(await app.eval<string[]>(visibleRows)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("notes.md"),
        expect.stringContaining("recipe.md"),
        expect.stringContaining("loose-letter.txt"),
      ]),
    );
    await app.eval(
      `document.querySelector('[data-testid="history-scope"]').click(); true`,
    );
    await app.waitFor(
      `[...document.querySelectorAll('[role="menu"] button')].some((el) => el.textContent.includes('Field research'))`,
      { label: "scope menu" },
    );
    await app.eval(
      `[...document.querySelectorAll('[role="menu"] button')].find((el) => el.textContent.includes('Field research')).click(); true`,
    );
    await app.waitFor(
      `${rows}.length === 1 && ${rows}[0].textContent.includes('notes.md') && document.querySelector('[data-testid="history-scope"]').textContent.includes('Field research')`,
      { label: "scoped to Field research" },
    );
    await app.eval(
      `document.querySelector('[data-testid="history-scope"]').click(); true`,
    );
    await app.waitFor(
      `[...document.querySelectorAll('[role="menu"] button')].some((el) => el.textContent.includes('Kitchen'))`,
      { label: "scope menu again" },
    );
    await app.eval(
      `[...document.querySelectorAll('[role="menu"] button')].find((el) => el.textContent.includes('Kitchen')).click(); true`,
    );
    await app.waitFor(
      `${rows}.length === 2 && ${visibleRows}.join('\\n').includes('recipe.md') && ${visibleRows}.join('\\n').includes('loose-letter.txt')`,
      { label: "scoped to Kitchen" },
    );
  });

  it("a file outside any project reopens as a browser tab", async () => {
    const before = await app.eval<number>(
      `document.querySelectorAll('webview').length`,
    );
    await app.eval(`(() => {
      const row = ${rows}.find((row) => row.dataset.kind === 'local');
      row.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...(${isMac} ? { metaKey: true } : { ctrlKey: true }) }));
      return true;
    })()`);
    await app.waitFor(
      `document.querySelectorAll('webview').length === ${before + 1} && [...document.querySelectorAll('webview')].filter((view) => (view.getAttribute('src') || '').endsWith('loose-letter.txt')).length === 2`,
      { label: "loose file opened again as a browser tab" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("History mode finds a chat by words written in it and opens it", async () => {
    const sessionId = await app.eval<string>(`(async()=>{
      const api=window.catamorphicDesktop;
      const agent=await api.agentsCreate({name:'History helper',harness:'ai-sdk'});
      await api.agentsSetDefault(agent.id);
      const {url}=await api.getServerState();
      const base=url+'/api/projects/'+${JSON.stringify(second.id)}+'/agent/sessions';
      const created=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:agent.id,title:'Release planning',source:'desktop'})});
      if(!created.ok)throw new Error(await created.text());
      const {id}=await created.json();
      const sent=await fetch(base+'/'+id+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',commandId:crypto.randomUUID(),text:'Before shipping, walk through the zanzibar checklist with the team.'})});
      if(!sent.ok)throw new Error(await sent.text());
      return id;
    })()`);
    await focusWindow(app);
    await app.waitFor(`!${paletteInput}`);
    await app.press("p", process.platform === "darwin" ? 4 : 2);
    await app.waitFor(`document.activeElement === ${paletteInput}`);
    await app.insertText("history");
    await app.press("Space");
    await app.waitFor(`${paletteInput}?.placeholder === 'Search history…'`);
    // Neither the title nor anything opened says it; the message does.
    await app.insertText("Zanzibar");
    // The overlay's rows; the chat may be renamed by its agent by now.
    const row = `[...${paletteInput}.closest('[role="dialog"]').querySelectorAll('[role="option"]')].find(el=>el.textContent.includes('the zanzibar checklist'))`;
    await app.waitFor(`!!${row}?.textContent.includes('Kitchen')`, {
      label: "chat found by its message",
    });
    await app.waitFor(
      `${paletteInput}.closest('[role="dialog"]').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')`,
    );
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? os.tmpdir(),
        "history-chat-match.png",
      ),
    );
    await app.press("Enter");
    await app.waitFor(
      `[...document.querySelectorAll('section[data-chat-local-id]:not([inert], [inert] *)')].some(el=>el.textContent.includes('zanzibar checklist'))`,
      { label: "chat opened", timeoutMs: 30_000 },
    );
    await app.waitFor(
      `window.catamorphicDesktop.historyQuery({}).then((page) => page.entries.some((entry) => entry.target.kind === 'chat' && entry.target.resource === ${JSON.stringify(sessionId)}))`,
      { label: "opened chat recorded in history" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
