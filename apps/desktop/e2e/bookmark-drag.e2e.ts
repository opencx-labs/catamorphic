import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let folderId: string;
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $ = s => document.querySelector(s); const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); ${body} })()`,
  );
async function drop(source: string, target: string) {
  await app.eval(
    `(()=>{window.__bookmarkDrag=new DataTransfer();document.querySelector(${JSON.stringify(source)}).dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.__bookmarkDrag}))})()`,
  );
  await app.waitFor(`!!document.querySelector(${JSON.stringify(target)})`);
  await app.eval(
    `(()=>{const target=document.querySelector(${JSON.stringify(target)});for(const type of ['dragover','drop'])target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.__bookmarkDrag}));document.dispatchEvent(new DragEvent('dragend',{bubbles:true}));delete window.__bookmarkDrag})()`,
  );
}
const bookmarks = () =>
  app.eval<{
    project: { bookmarks: { id: string; url: string; folderId?: string }[] };
    pinned: { id: string; url: string }[];
  }>("window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope)");

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New project')",
  );
  await run("button('New project').click()");
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
      "setReactValue($('textarea[placeholder*=\"Search or ask\"]'),'https://example.test/reference')",
    );
    await app.press("Enter");
    await app.waitFor(
      "!!document.querySelector('aside [data-point-key^=\"browser:\"]')",
    );
    await drop(
      'aside [data-point-key^="browser:"]',
      `[data-bookmark-drop="folder:${folderId}"]`,
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
    await app.waitFor("!!document.querySelector('aside [data-chat-session]')");
    const sessionId = await run<string>(
      "return $('aside [data-chat-session]').dataset.chatSession",
    );
    await drop("aside [data-chat-session]", '[data-bookmark-drop="pinned"]');
    await app.waitFor(
      "window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.pinned.length===1)",
    );
    const pinned = (await bookmarks()).pinned[0];
    if (!pinned) throw new Error("The chat was not pinned");
    expect(new URL(pinned.url).searchParams.get("session")).toBe(sessionId);
    await app.eval(
      `window.catamorphicDesktop.bookmarksRename({...window.__bookmarkScope,id:${JSON.stringify(pinned.id)},label:'Saved conversation'})`,
    );
    await app.waitFor(
      "!!document.querySelector('[data-bookmark-drop=pinned] button[aria-label=\"Saved conversation\"]') || [...document.querySelectorAll('[data-bookmark-drop=pinned] button')].some(b=>b.textContent.trim()==='Saved conversation')",
    );
    await run(
      "$('[data-bookmark-drop=pinned] [data-point-key=\"sidebar:Saved conversation\"] button').click()",
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
      "$('[data-bookmark-drop=pinned] [data-point-key=\"sidebar:Saved conversation\"] button').click()",
    );
    await app.waitFor(
      "!!document.querySelector('aside [data-point-key^=\"chat:\"]') && document.body.textContent.includes('remember this pinned conversation')",
    );
    await drop(
      "[data-bookmark-drop=pinned] li[draggable]",
      `[data-bookmark-drop="folder:${folderId}"]`,
    );
    await app.waitFor(
      "window.catamorphicDesktop.bookmarksGet(window.__bookmarkScope).then(d=>d.pinned.length===0 && d.project.bookmarks.length===2)",
    );
    expect(
      (await bookmarks()).project.bookmarks.find((b) => b.id === pinned.id),
    ).toMatchObject({ url: pinned.url, folderId });
  });
});
