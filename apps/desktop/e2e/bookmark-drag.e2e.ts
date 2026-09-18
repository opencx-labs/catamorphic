import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let folderId: string;
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
/**
 * Drives the shared tree drag model the way a pointer would: dragstart on
 * the source, then dragover and drop on the target at a point inside it.
 * `at` picks the drop slot: the middle of a folder row means inside, the
 * top edge of a row means before it.
 */
async function drop(
  source: string,
  target: string,
  at: "center" | "top" = "center",
) {
  await app.eval(
    `(()=>{window.__bookmarkDrag=new DataTransfer();document.querySelector(${JSON.stringify(source)}).dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__bookmarkDrag}))})()`,
  );
  await app.waitFor(`!!document.querySelector(${JSON.stringify(target)})`);
  await app.eval(
    `(()=>{const target=document.querySelector(${JSON.stringify(target)});const r=target.getBoundingClientRect();const init={bubbles:true,cancelable:true,dataTransfer:window.__bookmarkDrag,clientX:r.left+Math.min(24,r.width/2),clientY:${at === "top" ? "r.top+2" : "r.top+r.height/2"}};for(const type of ['dragover','drop'])target.dispatchEvent(new DragEvent(type,init));document.dispatchEvent(new DragEvent('dragend',{bubbles:true}));delete window.__bookmarkDrag})()`,
  );
}
const bookmarks = () =>
  app.eval<{
    project: { bookmarks: { id: string; url: string; folderId?: string }[] };
    pinned: { bookmarks: { id: string; url: string }[] };
  }>("window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope)");

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create or import project')",
  );
  await run("button('Create or import project').click()");
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'),'Pinning workspace')",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await app.waitFor(
    "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
  // The palette can mount before project selection persists its preference.
  // Wait for that selection before creating project-scoped fixtures.
  await app.waitFor(
    "window.catamorphicDesktop.getPrefs().then(prefs=>Boolean(prefs.lastProjectId))",
  );
  folderId = await app.eval(
    "(async()=>{const api=window.catamorphicDesktop;await api.setPrefs({tabPlacement:'sidebar',headerPlacement:'sidebar'});window.__bookmarkScope={profileId:await api.windowProfile(),projectId:(await api.getPrefs()).lastProjectId};return (await api.bookmarksAddFolder({...window.__bookmarkScope,label:'Research'})).id})()",
  );
});
afterAll(async () => {
  await app?.stop();
});

describe("drag tabs and chats into bookmarks", () => {
  it("pins the dragged browser page into a folder", async () => {
    await run(
      "const input=$('textarea[placeholder*=\"Search or ask\"]');input.focus();setReactValue(input,'https://example.test/reference')",
    );
    await app.waitFor(
      "document.activeElement?.matches('textarea[aria-label=\"Search commands, pages, and more\"]') && document.activeElement.closest('[role=dialog]').querySelector('[data-item-id=web]')?.getAttribute('aria-selected')==='true'",
    );
    await app.press("Enter");
    await app.waitFor(
      "!!document.querySelector('aside [data-point-key^=\"browser:\"]')",
    );
    await drop(
      'aside [data-point-key^="browser:"]',
      `[data-tree-id="${folderId}"]`,
    );
    await app.waitFor(
      "window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.project.bookmarks.length===1)",
    );
    expect((await bookmarks()).project.bookmarks[0]).toMatchObject({
      url: "https://example.test/reference",
      folderId,
    });
    expect(
      await run("return !!$('aside [data-point-key^=\"browser:\"]')"),
    ).toBe(true);
  });
  it("pins a saved chat and reopens the same conversation after its tab closes", async () => {
    await run("$('button[aria-label=\"New chat\"]').click()");
    await app.waitFor("!!document.querySelector('[data-composer-input]')");
    await run(
      "setReactValue($('[data-composer-input]'),'remember this pinned conversation');$('[data-composer-input]').focus()",
    );
    await app.press("Enter");
    await app.waitFor("!!document.querySelector('aside [data-session-id]')");
    const sessionId = await run<string>(
      "return $('aside [data-session-id]').dataset.sessionId",
    );
    await drop("aside [data-session-id]", '[data-drop-zone="pinned"]');
    await app.waitFor(
      "window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.pinned.bookmarks.length===1)",
    );
    const pinned = (await bookmarks()).pinned.bookmarks[0];
    if (!pinned) throw new Error("The chat was not pinned");
    expect(new URL(pinned.url).searchParams.get("session")).toBe(sessionId);
    await app.eval(
      `window.catamorphicDesktop.bookmarksRename({...window.__bookmarkScope,id:${JSON.stringify(pinned.id)},label:'Saved conversation'})`,
    );
    await app.waitFor(
      "!!document.querySelector('[data-drop-zone=pinned] button[aria-label=\"Saved conversation\"]') || [...document.querySelectorAll('[data-drop-zone=pinned] button')].some(b=>b.textContent.trim()==='Saved conversation')",
    );
    await run(
      "$('[data-drop-zone=pinned] [data-point-key=\"sidebar:Saved conversation\"] button').click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-point-key^=\"chat:\"]')",
    );
    await run(
      '$(\'aside [data-point-key^="chat:"] button[aria-label^="Close"]\').click()',
    );
    await app.waitFor(
      "!document.querySelector('aside [data-point-key^=\"chat:\"]')",
    );
    await run(
      "$('[data-drop-zone=pinned] [data-point-key=\"sidebar:Saved conversation\"] button').click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-point-key^=\"chat:\"]') && document.body.textContent.includes('remember this pinned conversation')",
    );
    await drop(
      "[data-drop-zone=pinned] li[draggable]",
      `[data-tree-id="${folderId}"]`,
    );
    await app.waitFor(
      "window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.pinned.bookmarks.length===0 && d.project.bookmarks.length===2)",
    );
    expect(
      (await bookmarks()).project.bookmarks.find((b) => b.id === pinned.id),
    ).toMatchObject({ url: pinned.url, folderId });
  });
  it("reorders bookmarks within a section and moves one into a folder by dragging", async () => {
    const ids = await app.eval<string[]>(
      `(async()=>{const api=window.catamorphicDesktop;const out=[];for(const name of ['One','Two','Three'])out.push((await api.bookmarksAdd({...window.__bookmarkScope,label:name,url:'https://order.test/'+name})).id);return out})()`,
    );
    await app.waitFor(`!!document.querySelector('[data-tree-id="${ids[2]}"]')`);
    // Three before One: the top edge of One's row is the "before" slot.
    await drop(
      `[data-tree-id="${ids[2]}"]`,
      `[data-tree-id="${ids[0]}"]`,
      "top",
    );
    await app.waitFor(
      `window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.project.bookmarks.filter(b=>!b.folderId).map(b=>b.label).join()==='Three,One,Two')`,
    );
    // Two into the Research folder: the middle of a folder row is "inside".
    await drop(`[data-tree-id="${ids[1]}"]`, `[data-tree-id="${folderId}"]`);
    await app.waitFor(
      `window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.project.bookmarks.find(b=>b.label==='Two')?.folderId===${JSON.stringify(folderId)})`,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });
});
