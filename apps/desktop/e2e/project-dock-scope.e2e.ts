import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
let ownerId: string;
let otherId: string;
const front = (id: string) =>
  `section[data-chat-local-id="${id}"]:not([inert])`;

beforeAll(async () => {
  app = await launchApp();
  [ownerId, otherId] = await app.eval<[string, string]>(`(async () => {
    const api=window.catamorphicDesktop;
    const agent=await api.agentsCreate({name:'Scope helper',harness:'codex',model:'fake-model-a'});
    await api.agentsSetDefault(agent.id);
    await api.setPrefs({dockMultiProject:false,dockCollapsed:false});
    const first=await api.createProject({name:'Catamorphic QA',rootPath:${JSON.stringify(`${app.userDataDir}/catamorphic-qa`)}});
    const second=await api.createProject({name:'Opencx QA',rootPath:${JSON.stringify(`${app.userDataDir}/opencx-qa`)}});
    await api.workspaceNavigate({projectId:first.id});
    return [first.id,second.id];
  })()`);
  await app.waitFor(
    `!!document.querySelector('[data-project-runtime="${ownerId}"][data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  await focusWindow(app);
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node)return false;
    // Hover-only controls must reach their final position before the
    // native pointer moves. Otherwise it can land where the row used to be.
    for(let parent=node;parent;parent=parent.parentElement)
      if(parent.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;
    const r=node.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    return r.width&&r.height&&node.contains(document.elementFromPoint(x,y))&&{x,y};
  })()`);
  await app.movePointer(point);
  await app.waitFor(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node)return false;
    for(let parent=node;parent;parent=parent.parentElement){
      if(getComputedStyle(parent).opacity==='0')return false;
      if(parent.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;
    }
    const r=node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })()`);
  const settled = await app.eval<{ x: number; y: number }>(`(() => {
    const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await app.clickPointer(settled);
}

it("keeps foreign attention chats and forks in their project, and keeps them open in all-projects mode", async () => {
  await click('[data-dock-rail] button[aria-label="New chat"]');
  const original = await app.waitFor<string>(
    "document.querySelector('section[data-floating-chat]:not([inert])')?.dataset.chatLocalId",
  );
  await click(`${front(original)} [data-composer-input]`);
  await app.insertText("Scope fixture reply");
  await app.press("Enter");
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front(original))})?.textContent.includes('You said: Scope fixture reply') && !document.querySelector(${JSON.stringify(`${front(original)} [data-testid="chat-stop"]`)})`,
  );
  await click(`${front(original)} [data-testid="chat-fork"]`);
  const fork = await app.waitFor<string>(
    `window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.find(c=>c.entry.parentLocalId===${JSON.stringify(original)})?.entry.localId)`,
  );
  await click(`${front(fork)} button[aria-label="Minimize chat to bubble"]`);
  await app.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.some(c=>c.entry.localId===${JSON.stringify(fork)}&&c.entry.mode==='min'))`,
    { label: "fork minimized" },
  );
  await click(
    `${front(original)} button[aria-label="Minimize chat to bubble"]`,
  );
  await app.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.some(c=>c.entry.localId===${JSON.stringify(original)}&&c.entry.mode==='min'))`,
    { label: "parent minimized" },
  );
  const ids = [original, fork];
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(otherId)}})`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-project-runtime="${otherId}"][data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  await app.eval(`(async () => {
    const api=window.catamorphicDesktop, {url}=await api.getServerState();
    const snapshot=await api.dockSnapshot();
    for(const id of ${JSON.stringify(ids)}){
      const entry=snapshot.chats.find(c=>c.entry.localId===id).entry;
      const response=await fetch(url+'/api/projects/'+${JSON.stringify(ownerId)}+'/agent/sessions/'+entry.sessionId+'/attention',{method:'POST'});
      if(!response.ok)throw new Error('Cannot request fixture attention: '+response.status);
    }
  })()`);
  await app.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(s=>${JSON.stringify(ids)}.every(id=>s.chats.some(c=>c.entry.localId===id&&c.attention)))`,
    { label: "both foreign chats need attention" },
  );
  expect(
    await app.eval(
      `${JSON.stringify(ids)}.map(id=>!!document.querySelector('[data-chat-bubble="'+id+'"]'))`,
    ),
  ).toEqual([false, false]);

  await app.eval("window.catamorphicDesktop.setPrefs({dockMultiProject:true})");
  await app.waitFor(
    `${JSON.stringify(ids)}.every(id=>!!document.querySelector('[data-chat-bubble="'+id+'"]'))`,
    { label: "all-projects mode shows both foreign chats" },
  );
  for (const id of ids) {
    await click(`[data-chat-bubble="${id}"] button[aria-label^="Open "]`);
    await app
      .waitFor(
        `!!document.querySelector(${JSON.stringify(front(id))}) && window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.some(c=>c.entry.localId===${JSON.stringify(id)}&&!c.attention))`,
        { label: "opening acknowledges attention without closing the chat" },
      )
      .catch(async (error: unknown) => {
        const detail = await app.eval(`(async () => {
        const api=window.catamorphicDesktop, s=await api.dockSnapshot(), {url}=await api.getServerState();
        const item=s.chats.find(c=>c.entry.localId===${JSON.stringify(id)});
        const response=await fetch(url+'/api/projects/'+item.projectId+'/agent/sessions/'+item.entry.sessionId);
        const session=await response.json();
        return {focused:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,200),dock:s,session};
      })()`);
        throw new Error(`${String(error)}\n${JSON.stringify(detail)}`);
      });
    expect(
      await app.eval(
        `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime`,
      ),
    ).toBe(otherId);
    await click(`${front(id)} button[aria-label="Minimize chat to bubble"]`);
  }
  expect(app.getRendererErrors()).toEqual([]);
}, 120_000);
