import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyUtilityWorkspace } from "../src/renderer/lib/workspace-state.js";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  pointerOnPage,
  waitForProjectWorkspace,
} from "./harness.js";
import { pressNativeMacKey } from "./native-pointer.js";

let app: AppHandle;
const api = "window.catamorphicDesktop";
const visible = '[data-workspace-visible="true"]';
const group = `${visible} [data-point-key="chat:group"]`;
const page = `${visible} webview`;
async function activatePage(selector: string) {
  const view = `document.querySelector(${JSON.stringify(selector)})`;
  await focusWindow(app);
  await app.waitFor(
    `(() => {const view=${view};return !!view && !view.closest('[inert]') && view.checkVisibility({opacityProperty:true,visibilityProperty:true});})()`,
    { label: "the page is visible and accepts input" },
  );
  await app.eval(
    `${view}.executeJavaScript("window.__groupActivationClicks=0;addEventListener('click',event=>{if(event.isTrusted)window.__groupActivationClicks+=1;},{capture:true,once:true});true")`,
  );
  const point = await app.eval<{ x: number; y: number }>(
    `(() => {const rect=${view}.getBoundingClientRect();return {x:rect.x+32,y:rect.y+32};})()`,
  );
  // A title can load before Chromium routes input to a newly shown guest.
  await pointerOnPage(app, { view, selector: "html", point });
  await app.clickPointer(point);
  // The pointer readiness helper runs scripts with a user gesture. Observe
  // the actual trusted press too, so activation alone cannot pass this setup.
  await app.waitFor(
    `${view}.executeJavaScript('window.__groupActivationClicks===1 && document.hasFocus()')`,
    { label: "the page received its trusted activation press" },
  );
  await app.waitFor(
    `${view}.executeJavaScript('navigator.userActivation.hasBeenActive')`,
    { label: "the page is activated" },
  );
}
async function closePageKey() {
  await app.waitFor(`${api}.devWindow('focus').then(state=>state.focused)`);
  await app.eval(`document.querySelector('${page}').focus()`);
  if (process.platform === "darwin") await pressNativeMacKey("w", ["command"]);
  else
    await app.eval(`(() => {
    const view=document.querySelector('${page}');
    for(const type of ['keyDown','keyUp']) view.sendInputEvent({type,keyCode:'W',modifiers:['control']});
  })()`);
}
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<title>${request.url === "/popup" ? "Group popup" : "Group page"}</title><p>Page subtab</p>`,
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No group fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

async function openGroup({
  name,
  activePage = false,
  editor = false,
  pages = 1,
}: {
  name: string;
  activePage?: boolean;
  editor?: boolean;
  pages?: number;
}) {
  const project = await app.eval<{ id: string }>(
    `${api}.createProject(${JSON.stringify({ name, rootPath: path.join(app.userDataDir, name) })})`,
  );
  const session = await app.eval<{ id: string }>(`(async()=>{
    const {url}=await ${api}.getServerState();
    const {defaultAgentId}=await ${api}.agentsList();
    const response=await fetch(url+'/api/projects/${project.id}/agent/sessions',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({agentId:defaultAgentId,title:'Folded group'})
    });
    if(!response.ok) throw new Error(await response.text());
    return response.json();
  })()`);
  const base = `${origin}/${encodeURIComponent(name)}`;
  const profileId = await app.eval<string>(`${api}.windowProfile()`);
  if (editor)
    fs.writeFileSync(
      path.join(app.userDataDir, name, "draft.txt"),
      "Original file\n",
    );
  const snapshot = {
    ...emptyUtilityWorkspace(),
    tabs: [{ kind: "settings", name: "settings" }],
    chats: [
      {
        localId: "group",
        mode: "tab",
        sessionId: session.id,
        surfacesCollapsed: true,
      },
    ],
    browsers: Array.from({ length: pages }, (_, index) => ({
      localId: index === 0 ? "page" : "second",
      profileId,
      initialUrl: `${base}/${index}`,
      url: `${base}/${index}`,
      title: "Group page",
      faviconUrl: null,
      chatLocalId: "group",
    })),
    editors: editor
      ? [
          {
            localId: "file",
            filePath: "draft.txt",
            dirty: false,
            chatLocalId: "group",
          },
        ]
      : [],
    activeTabKey: activePage
      ? "browser:page"
      : editor
        ? "editor:file"
        : "chat:group",
    activeChatId: "group",
    recentTabKeys: ["settings:settings"],
  };
  await app.eval(
    `${api}.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
  );
  // Reload only after the selected project has reached the saved preferences.
  // Every fixture reuses chat:group, so that key alone cannot identify it.
  await waitForProjectWorkspace({ app, name });
  await app.eval(
    `${api}.workspaceStateSet(${JSON.stringify(project.id)},${JSON.stringify(snapshot)})`,
  );
  await app.reload();
  await app.waitFor(
    `document.querySelector('${visible}')?.dataset.projectRuntime===${JSON.stringify(project.id)} &&
      !!document.querySelector('${visible} [data-workspace-ready]') &&
      !!document.querySelector('${group}:not([aria-hidden]) [aria-label$=" grouped tabs"]')`,
    { label: "the saved project and its folded group are restored" },
  );
  if (activePage)
    await app.waitFor(
      `(() => { try { return document.querySelector('${page}')?.getTitle()==='Group page'; } catch { return false; } })()`,
    );
  else if (!editor)
    await app.waitFor(
      `document.activeElement?.matches('[data-chat-local-id="group"] [data-composer-input]') &&
       !!document.activeElement.closest('[data-workspace-visible="true"]')`,
      { label: "the restored chat finished its composer focus handoff" },
    );
  return project.id;
}

describe("closing folded tab groups", () => {
  it.each(["button", "shortcut"])(
    "closes its hidden subtabs with the $0",
    async (method) => {
      const projectId = await openGroup({
        name: `Group ${method}`,
        activePage: method === "shortcut",
      });
      expect(
        await app.eval(
          `!!document.querySelector('${visible} [data-point-key="browser:page"]')`,
        ),
      ).toBe(false);
      if (method === "button")
        await app.eval(
          `document.querySelector('${group} button[aria-label^="Close "]').click()`,
        );
      else {
        // A restored folded group may show its child while only its
        // header appears in the strip. Do not select that header first.
        await closePageKey();
      }
      await app.waitFor(
        `!document.querySelector('${group}') && !document.querySelector('${page}')`,
        { label: "group and page subtab disposed" },
      );
      await app.waitFor(
        `${api}.workspaceStateGet(${JSON.stringify(projectId)}).then(state=>state.chats.length===0 && state.browsers.length===0)`,
        { label: "closed subtabs absent from restored workspace" },
      );
      expect(
        await app.eval(
          `!!document.querySelector('${visible} [data-point-key="settings:settings"]')`,
        ),
      ).toBe(true);
      expect(app.getRendererErrors()).toEqual([]);
    },
  );

  it("keeps the whole group when a subtab refuses to leave, then closes it on approval", async () => {
    const projectId = await openGroup({
      name: "Group leave guard",
      activePage: true,
    });
    await app.eval(
      `document.querySelector('${page}').executeJavaScript("addEventListener('beforeunload', event=>{event.preventDefault();event.returnValue='';}); true")`,
    );
    await activatePage(page);
    const selectChat = () =>
      app.eval(`document.querySelector('${group} button').click()`);
    const chat = `section[data-chat-project="${projectId}"][data-chat-local-id="group"]`;
    const close = `document.querySelector('${chat} button[aria-label="Close chat"]').click()`;
    const dialog = `document.querySelector('[data-testid="page-dialog"]:not([inert])')`;
    await selectChat();
    await app.waitFor(
      `!!document.querySelector('${chat}[data-chat-tab]:not([inert])')`,
    );
    await app.eval(close);
    await app.waitFor(`${dialog}?.dataset.kind==='beforeunload'`, {
      label: "subtab leave guard before group close",
    });
    await app.eval(
      `${dialog}.querySelector('[data-testid="page-dialog-cancel"]').click()`,
    );
    await app.waitFor(`!${dialog}`);
    expect(
      await app.eval(
        `!!document.querySelector('${group}') && !!document.querySelector('${page}')`,
      ),
    ).toBe(true);
    // Stay revealed the child without unfolding the group. An immediate
    // Cmd+W must target the same group and ask again, not hide one child.
    await closePageKey();
    await app.waitFor(`${dialog}?.dataset.kind==='beforeunload'`);
    await app.eval(
      `${dialog}.querySelector('[data-testid="page-dialog-cancel"]').click()`,
    );
    await app.waitFor(`!${dialog}`);
    await selectChat();
    await app.waitFor(
      `!!document.querySelector('${chat}[data-chat-tab]:not([inert])') && getComputedStyle(document.querySelector('${chat}')).opacity==='1'`,
      { label: "cancelled chat close remains visible and usable" },
    );
    await app.eval(close);
    await app.waitFor(`${dialog}?.dataset.kind==='beforeunload'`);
    await app.eval(
      `${dialog}.querySelector('[data-testid="page-dialog-accept"]').click()`,
    );
    await app.waitFor(
      `!document.querySelector('${group}') && !document.querySelector('${page}')`,
      { label: "group disposed after accepting leave" },
    );
    await app.waitFor(
      `${api}.workspaceStateGet(${JSON.stringify(projectId)}).then(state=>state.chats.length===0 && state.browsers.length===0)`,
    );
    expect(app.getRendererErrors()).toEqual([]);
  });

  it("keeps a dirty file until the group discard is explicitly confirmed", async () => {
    const name = "Group dirty editor";
    await openGroup({ name, editor: true, activePage: true });
    await app.eval(
      `document.querySelector('${page}').executeJavaScript("onbeforeunload=event=>{event.preventDefault();event.returnValue='';};true")`,
    );
    await activatePage(page);
    await app.eval(
      `document.querySelector('${group} [aria-label$=" grouped tabs"]').click()`,
    );
    await app.eval(
      `document.querySelector('${visible} [data-point-key="editor:file"] button').click()`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] .monaco-editor textarea')`,
      { label: "file editor ready" },
    );
    const point = await app.eval<{ x: number; y: number }>(`(() => {
      const box=document.querySelector('${visible} .monaco-editor .view-lines').getBoundingClientRect();
      return {x:box.x+80,y:box.y+10};
    })()`);
    await app.clickPointer(point);
    await app.waitFor(
      `document.querySelector('${visible} .monaco-editor')?.contains(document.activeElement)`,
    );
    await app.insertText("Unsaved edit ");
    await app.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] [data-testid="editor-save"]')`,
      { label: "editor holds an unsaved draft" },
    );
    await app.eval(
      `document.querySelector('${visible} [aria-label="Collapse grouped tabs"]').click()`,
    );
    await app.waitFor(
      `!!document.querySelector('${group} [aria-label^="Expand "]')`,
    );
    const close = `document.querySelector('${group} button[aria-label^="Close "]').click()`;
    await app.eval(close);
    await app.waitFor(
      `document.body.innerText.includes('Discard unsaved edits?')`,
    );
    await app.waitFor(
      `(() => {const panel=document.querySelector('[aria-labelledby="workflow-close-title"]');return panel && panel.parentElement.getAnimations({subtree:true}).every(animation=>animation.playState!=='running');})()`,
      { label: "discard confirmation entrance settled" },
    );
    await app.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
        "group-dirty-confirmation.png",
      ),
    );
    expect(
      await app.eval(
        `!!document.querySelector('[data-testid="page-dialog"]:not([inert])')`,
      ),
    ).toBe(false);
    await app.eval(
      `Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent==='Keep editing').click()`,
    );
    await app.waitFor(
      `!document.body.innerText.includes('Discard unsaved edits?')`,
    );
    expect(
      await app.eval(
        `!!document.querySelector('[data-workspace-visible="true"] [data-testid="editor-save"]')`,
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(app.userDataDir, name, "draft.txt"), "utf8"),
    ).toBe("Original file\n");
    await app.eval(close);
    await app.waitFor(
      `document.body.innerText.includes('Discard unsaved edits?')`,
    );
    await app.eval(
      `Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent==='Discard and close').click()`,
    );
    await app.waitFor(
      `document.querySelector('[data-testid="page-dialog"]:not([inert])')?.dataset.kind==='beforeunload'`,
    );
    await app.eval(
      `document.querySelector('[data-testid="page-dialog"]:not([inert]) [data-testid="page-dialog-accept"]').click()`,
    );
    await app.waitFor(
      `!document.querySelector('${group}') && !document.querySelector('[data-workspace-visible="true"] .monaco-editor')`,
      { label: "group closes after explicit discard" },
    );
    expect(
      fs.readFileSync(path.join(app.userDataDir, name, "draft.txt"), "utf8"),
    ).toBe("Original file\n");
    expect(app.getRendererErrors()).toEqual([]);
  });

  it.each(["plain", "guarded"])(
    "keeps an earlier %s page alive when a later subtab cancels, then retries",
    async (kind) => {
      await openGroup({
        name: `Group partial approval ${kind}`,
        activePage: true,
        pages: 2,
      });
      const view = (suffix: string) => `${visible} webview[src$="/${suffix}"]`;
      const prepare = async (suffix: string) => {
        if (suffix !== "0" || kind === "guarded")
          await app.eval(
            `document.querySelector('${view(suffix)}').executeJavaScript("onbeforeunload=event=>{event.preventDefault();event.returnValue='';};true")`,
          );
        await activatePage(view(suffix));
      };
      await prepare("0");
      const firstId = await app.eval<number>(
        `document.querySelector('${view("0")}').getWebContentsId()`,
      );
      await app.eval(
        `document.querySelector('${view("0")}').executeJavaScript("window.preservedMarker='still here';document.body.style.minHeight='3000px';window.scrollTo(0,600);true")`,
      );
      const firstScroll = await app.eval<number>(
        `document.querySelector('${view("0")}').executeJavaScript('scrollY')`,
      );
      await app.eval(
        `document.querySelector('${group} [aria-label$=" grouped tabs"]').click()`,
      );
      await app.eval(
        `document.querySelector('${visible} [data-point-key="browser:second"] button').click()`,
      );
      await app.waitFor(
        `(() => {try{return document.querySelector('${view("1")}')?.getTitle()==='Group page';}catch{return false;}})()`,
      );
      await prepare("1");
      await app.eval(
        `document.querySelector('${visible} [aria-label="Collapse grouped tabs"]').click()`,
      );
      await app.eval(
        `document.querySelector('${group} button[aria-label^="Close "]').click()`,
      );
      const dialog = (key: string) =>
        `document.querySelector('${visible} [data-surface-key="browser:${key}"] [data-testid="page-dialog"]:not([inert])')`;
      if (kind === "guarded") {
        await app.waitFor(`${dialog("page")}?.dataset.kind==='beforeunload'`);
        await app.eval(
          `${dialog("page")}.querySelector('[data-testid="page-dialog-accept"]').click()`,
        );
      }
      await app.waitFor(`${dialog("second")}?.dataset.kind==='beforeunload'`);
      await app.eval(
        `${dialog("second")}.querySelector('[data-testid="page-dialog-cancel"]').click();window.__groupCancelledAt=Date.now()`,
      );
      await app.waitFor(
        `!document.querySelector('[data-testid="page-dialog"]:not([inert])')`,
      );
      expect(await app.eval(`!!document.querySelector('${group}')`)).toBe(true);
      expect(
        await app.eval(
          `document.querySelector('${view("0")}').getWebContentsId()`,
        ),
      ).toBe(firstId);
      expect(
        await app.eval(
          `document.querySelector('${view("0")}').executeJavaScript('window.preservedMarker')`,
        ),
      ).toBe("still here");
      expect(
        await app.eval(
          `document.querySelector('${view("0")}').executeJavaScript('scrollY')`,
        ),
      ).toBe(firstScroll);
      // The synthetic activation from close must expire, while the cancelled
      // approval must not keep the retained first page restricted forever.
      // The later page's question guarantees that the first native check ran;
      // the Close click precedes its asynchronous preparation and cannot time it.
      await app.waitFor(`Date.now()>=window.__groupCancelledAt+5100`, {
        label: "native close activation expires",
      });
      await app.eval(
        `document.querySelector('${view("0")}').executeJavaScript(${JSON.stringify(`window.open('${origin}/popup','_blank');true`)},true)`,
      );
      await app.waitFor(
        `Array.from(document.querySelectorAll('${visible} webview')).some(view=>{try{return view.getTitle()==='Group popup';}catch{return false;}})`,
        { label: "retained approved page can open a popup after cancellation" },
      );
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
          "group-close-cancel-popup.png",
        ),
      );
      for (const suffix of ["0", "1"])
        await app.eval(
          `document.querySelector('${view(suffix)}').executeJavaScript('onbeforeunload=null;true')`,
        );
      await app.eval(
        `document.querySelector('${group} button[aria-label^="Close "]').click()`,
      );
      await app.waitFor(`!document.querySelector('${group}')`, {
        label: "retry closes all approved tabs together",
      });
      expect(app.getRendererErrors()).toEqual([]);
    },
  );

  describe("from a tab's menu", () => {
    const menu = '[role="menu"][aria-label="Open"]:not(.animate-pop-out)';
    const menuItems = `[...document.querySelectorAll('${menu} [role="menuitem"]')]`;
    const openMenu = async (key: string) => {
      await focusWindow(app);
      await app.waitFor(
        `!document.querySelector('[role="menu"], [data-menu-shield]')`,
      );
      const targetPoint = () =>
        app.waitFor<{ x: number; y: number }>(
          `(() => {
        const tab=document.querySelector('${visible} [data-point-key="${key}"]:not([aria-hidden])');
        const label=tab?.querySelector('.workspace-tab-label');
        if(!label||label.closest('[inert]')) return false;
        const r=label.getBoundingClientRect(),point={x:r.left+Math.min(8,r.width/2),y:r.top+r.height/2};
        return label.contains(document.elementFromPoint(point.x,point.y)) &&
          (tab.closest('[data-tab-orientation]')??tab).getAnimations({subtree:true}).every(a=>(a.playState!=='running'&&!a.pending)||a.effect?.getTiming().iterations===Infinity) ? point:false;
      })()`,
          { label: "the restored tab accepts a context press" },
        );
      await app.movePointer(await targetPoint());
      const point = await targetPoint();
      await app.eval(`(()=>{
        window.__tabMenuPress=null;
        window.addEventListener('pointerdown',event=>{
          window.__tabMenuPress={key:event.target.closest?.('[data-point-key]')?.dataset.pointKey,button:event.button,x:event.clientX,y:event.clientY};
        },{once:true,capture:true});return true;
      })()`);
      for (const type of ["mousePressed", "mouseReleased"])
        await app.cdp("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "right",
          clickCount: 1,
        });
      await app
        .waitFor(
          `(() => {
        const panel=document.querySelector('${menu}');
        return !!document.querySelector('[data-menu-shield]') && panel?.contains(document.activeElement) &&
          ${menuItems}.length>0 && panel.getAnimations({subtree:true}).every(a=>a.playState!=='running');
      })()`,
          { label: "the active tab menu is focused and settled" },
        )
        .catch(async (cause: unknown) => {
          const diagnostic = await app.eval(`({
          press:window.__tabMenuPress,focused:document.hasFocus(),active:document.activeElement.outerHTML.slice(0,300),
          menus:[...document.querySelectorAll('[role="menu"]')].map(menu=>({label:menu.getAttribute('aria-label'),text:menu.textContent.slice(0,300)}))
        })`);
          throw new Error(
            `${String(cause)}; tab menu: ${JSON.stringify(diagnostic)}`,
          );
        });
    };
    const closeEntries = () =>
      app.eval<string[]>(
        `${menuItems}.map(item=>item.textContent.trim()).filter(label=>label.startsWith('Close'))`,
      );
    const pick = async (label: string) => {
      const point = await app.waitFor<{ x: number; y: number }>(
        `(() => {
        const item=${menuItems}.find(item=>item.textContent.trim()===${JSON.stringify(label)});
        if(!item||item.disabled) return false;
        const r=item.getBoundingClientRect(),point={x:r.left+r.width/2,y:r.top+r.height/2};
        return item.contains(document.elementFromPoint(point.x,point.y)) ? point:false;
      })()`,
        { label: `${label} accepts a press` },
      );
      await app.clickPointer(point);
    };
    const state = (projectId: string) =>
      `${api}.workspaceStateGet(${JSON.stringify(projectId)})`;

    it("offers the group's closes and sends its tabs back to the chat", async () => {
      const projectId = await openGroup({ name: "Menu chat tabs" });
      await openMenu("chat:group");
      expect(await closeEntries()).toEqual([
        "Close tabs under chat",
        "Close chat and its tabs",
        "Close all tabs",
      ]);
      await app.waitFor(
        `${menuItems}[0].closest('[role="menu"]').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')`,
        { label: "tab menu entrance settled" },
      );
      await app.screenshot(
        path.join(
          process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? app.userDataDir,
          "group-close-menu.png",
        ),
      );
      await pick("Close tabs under chat");
      await app.waitFor(
        `${state(projectId)}.then(ws=>ws.chats.length===1 && ws.browsers.length===1 && ws.browsers[0].background===true)`,
        { label: "tab hidden back to its chat" },
      );
      expect(await app.eval(`!!document.querySelector('${group}')`)).toBe(true);
      expect(app.getRendererErrors()).toEqual([]);
    });

    it("offers group folding first on the parent and every attached tab", async () => {
      const projectId = await openGroup({ name: "Group menu folding" });
      await openMenu("chat:group");
      expect(await app.eval(`${menuItems}[0].textContent.trim()`)).toBe(
        "Expand group",
      );
      await pick("Expand group");
      await app.waitFor(
        `document.querySelector('${visible} [data-point-key="browser:page"]')?.checkVisibility()`,
      );
      await openMenu("browser:page");
      expect(await app.eval(`${menuItems}[0].textContent.trim()`)).toBe(
        "Collapse group",
      );
      await pick("Collapse group");
      await app.waitFor(
        `${state(projectId)}.then(ws=>ws.chats[0]?.surfacesCollapsed===true)`,
      );
      await app.waitFor(
        `!document.querySelector('${visible} [data-point-key="browser:page"]:not([aria-hidden])')`,
      );
      expect(app.getRendererErrors()).toEqual([]);
    });

    it("does nothing for repeated Cmd+M when all chats are tabs", async () => {
      const projectId = await openGroup({ name: "Only tab chats" });
      for (let count = 0; count < 3; count++) {
        await app.eval(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,cancelable:true,...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true})}));true`,
        );
      }
      await app.waitFor(
        `${state(projectId)}.then(ws=>ws.chats.length===1&&ws.chats[0].mode==='tab'&&ws.activeTabKey==='chat:group')`,
      );
      expect(
        await app.eval(
          `!!document.querySelector('section[data-floating-chat]')`,
        ),
      ).toBe(false);
      expect(app.getRendererErrors()).toEqual([]);
    });

    it("closes a chat and its tabs together", async () => {
      const projectId = await openGroup({ name: "Menu chat and tabs" });
      await openMenu("chat:group");
      await pick("Close chat and its tabs");
      await app.waitFor(
        `${state(projectId)}.then(ws=>ws.chats.length===0 && ws.browsers.length===0)`,
        { label: "chat and its tab closed" },
      );
      expect(
        await app.eval(
          `!!document.querySelector('${visible} [data-point-key="settings:settings"]')`,
        ),
      ).toBe(true);
      expect(app.getRendererErrors()).toEqual([]);
    });

    it("closes every tab from any tab", async () => {
      const projectId = await openGroup({ name: "Menu all tabs", pages: 2 });
      await openMenu("settings:settings");
      expect(await closeEntries()).toEqual(["Close tab", "Close all tabs"]);
      await pick("Close all tabs");
      await app.waitFor(
        `${state(projectId)}.then(ws=>ws.chats.length===0 && ws.browsers.length===0 && ws.tabs.length===0)`,
        { label: "every tab closed" },
      );
      await app.waitFor(
        `!document.querySelector('${visible} [data-point-key]:not([aria-hidden])')`,
        { label: "the strip is empty" },
      );
      expect(app.getRendererErrors()).toEqual([]);
    });
  });
});
