import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyUtilityWorkspace } from "../src/renderer/lib/workspace-state.js";
import { type AppHandle, launchApp } from "./harness.js";
import { pressNativeMacKey } from "./native-pointer.js";

let app: AppHandle;
const api = "window.catamorphicDesktop";
const visible = '[data-workspace-visible="true"]';
const group = `${visible} [data-point-key="chat:group"]`;
const page = `${visible} webview`;
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
  await app.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime===${JSON.stringify(project.id)} && !!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  await app.eval(
    `${api}.workspaceStateSet(${JSON.stringify(project.id)},${JSON.stringify(snapshot)})`,
  );
  await app.reload();
  await app.waitFor(
    `!!document.querySelector('${group} [aria-label$=" grouped tabs"]')`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  if (activePage)
    await app.waitFor(
      `(() => { try { return document.querySelector('${page}')?.getTitle()==='Group page'; } catch { return false; } })()`,
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
    await app.eval(`(() => {
      const view=document.querySelector('${page}'); view.focus();
      for(const type of ['keyDown','keyUp']) view.sendInputEvent({type,keyCode:'Space'});
    })()`);
    await app.waitFor(
      `document.querySelector('${page}').executeJavaScript('navigator.userActivation.hasBeenActive')`,
    );
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
    await app.eval(
      `(() => {const view=document.querySelector('${page}');view.focus();for(const type of ['keyDown','keyUp'])view.sendInputEvent({type,keyCode:'Space'});})()`,
    );
    await app.waitFor(
      `document.querySelector('${page}').executeJavaScript('navigator.userActivation.hasBeenActive')`,
    );
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
        await app.eval(
          `(() => {const view=document.querySelector('${view(suffix)}');view.focus();for(const type of ['keyDown','keyUp'])view.sendInputEvent({type,keyCode:'Space'});})()`,
        );
        await app.waitFor(
          `document.querySelector('${view(suffix)}').executeJavaScript('navigator.userActivation.hasBeenActive')`,
        );
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
        `window.__groupApprovedAt=Date.now();document.querySelector('${group} button[aria-label^="Close "]').click()`,
      );
      const dialog = (key: string) =>
        `document.querySelector('${visible} [data-surface-key="browser:${key}"] [data-testid="page-dialog"]:not([inert])')`;
      if (kind === "guarded") {
        await app.waitFor(`${dialog("page")}?.dataset.kind==='beforeunload'`);
        await app.eval(
          `window.__groupApprovedAt=Date.now();${dialog("page")}.querySelector('[data-testid="page-dialog-accept"]').click()`,
        );
      }
      await app.waitFor(`${dialog("second")}?.dataset.kind==='beforeunload'`);
      await app.eval(
        `${dialog("second")}.querySelector('[data-testid="page-dialog-cancel"]').click()`,
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
      await app.waitFor(`Date.now()>=window.__groupApprovedAt+5100`, {
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
});
