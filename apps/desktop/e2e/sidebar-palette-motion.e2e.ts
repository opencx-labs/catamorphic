import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";
import { CHATS_SECTION, writeSidebarSections } from "./sidebar-config.js";

let app: AppHandle;
let projectId: string;
const section =
  '[data-workspace-visible="true"] [data-sidebar-section="chats"]';
const box = `${section} > [data-collapsible]`;
const input =
  '[data-workspace-visible="true"] [data-palette="overlay"] [aria-label="Search commands, pages, and more"]';
const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
const shot = async (name: string) => {
  if (artifacts) await app.screenshot(path.join(artifacts, `${name}.png`));
};
const settled = () =>
  app.waitFor(
    `document.querySelector('${section}').getAnimations({subtree:true}).every(a=>a.playState!=='running' || a.effect?.getTiming().iterations===Infinity)`,
  );
const toggle = () =>
  app.eval(
    `document.querySelector('${section} button[aria-expanded]').click()`,
  );

beforeAll(async () => {
  app = await launchApp();
  await app.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const original=window.fetch;
      let hold=true;
      const held=[];
      window.__holdChats=()=>{hold=true};
      window.__releaseChats=()=>{hold=false;for(const release of held.splice(0)) release()};
      window.__heldChats=()=>held.length;
      window.fetch=(input,init)=>{
        const url=typeof input==='string'?input:input.url??String(input);
        if((hold || /[?&]offset=[1-9]/.test(url)) && /\\/agent\\/sessions\\?/.test(url) && /rootsOnly=true/.test(url))
          return new Promise((resolve,reject)=>held.push(()=>original(input,init).then(resolve,reject)));
        return original(input,init);
      };
    })()`,
  });
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await createProjectWorkspace({
    app,
    name: "Sidebar and palette motion",
    rootPath: path.join(app.userDataDir, "motion-project"),
  });
  projectId = project.id;
  const server = await app.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  for (let index = 0; index < 36; index += 1) {
    const response = await fetch(
      `${server.url}/api/projects/${project.id}/agent/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Motion chat ${index}`,
          source: "desktop",
        }),
      },
    );
    expect(response.status).toBe(201);
  }
  await writeSidebarSections(app, [
    {
      ...CHATS_SECTION,
      collapsed: true,
      headerActions: [
        { action: "refresh", label: "Refresh chats", icon: "RefreshCw" },
      ],
    },
  ]);
  await app.reload();
  await app.waitFor(`!!document.querySelector('${box}[data-state="closed"]')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1100,850)`);
});
afterAll(async () => {
  try {
    expect(app?.getRendererErrors() ?? []).toEqual([]);
  } finally {
    await app?.stop();
  }
});

it("fades loading out and animates paginated Chats closed and back open", async () => {
  await toggle();
  await app.waitFor(`window.__heldChats()>0`);
  await settled();
  await shot("sidebar-loading");
  // Pause the actual CSS transitions on their first frame to inspect the
  // skeleton leaving rather than racing a wall-clock screenshot.
  await app.eval(`window.__loadingExit=new Promise(resolve=>{
    const root=document.querySelector('${box}');
    root.addEventListener('transitionrun',function onRun(event){
      if(event.propertyName!=='opacity' || !event.target.querySelector('.sidebar-skeleton')) return;
      root.removeEventListener('transitionrun',onRun);
      const animation=event.target.getAnimations().find(a=>a.transitionProperty==='opacity');
      animation.pause();animation.currentTime=80;resolve(true);
    });
  });window.__releaseChats()`);
  await app.waitFor(`!!document.querySelector('${section} [role="treeitem"]')`);
  const exit = await app.eval<boolean>(
    `Promise.race([window.__loadingExit,new Promise(r=>setTimeout(()=>r(false),500))])`,
  );
  await shot("sidebar-loading-exit");
  await app.eval(
    `document.querySelector('${section}').getAnimations({subtree:true}).forEach(a=>{if(a.playState==='paused')a.play()})`,
  );
  await settled();
  // The first page still has a paging tail. Hiding it starts a descendant
  // height transition, which must not cancel the section's own close.
  const start = await app.eval<number>(
    `document.querySelector('${box}').getBoundingClientRect().height`,
  );
  const observeToggle = () =>
    app.eval(`(()=>{window.__sectionTween=false;
    const box=document.querySelector('${box}');
    box.addEventListener('transitionrun',function run(event){
      if(event.target!==box||event.propertyName!=='height')return;
      box.removeEventListener('transitionrun',run);
      for(const animation of box.getAnimations()){animation.pause();animation.currentTime=60;}
      window.__sectionTween=true;
    });})()`);
  await observeToggle();
  await toggle();
  await app.waitFor("window.__sectionTween");
  const closing = await app.eval<number>(
    `document.querySelector('${box}').getBoundingClientRect().height`,
  );
  expect(closing).toBeGreaterThan(0);
  expect(closing).toBeLessThan(start);
  const closeDuration = await app.eval<string>(
    `getComputedStyle(document.querySelector('${box}')).transitionDuration`,
  );
  await shot("sidebar-close");
  await app.eval(
    `document.querySelector('${box}').getAnimations().forEach(a=>a.play())`,
  );
  await settled();
  expect(
    await app.eval(
      `document.querySelector('${box}').getBoundingClientRect().height`,
    ),
  ).toBe(0);
  await observeToggle();
  await toggle();
  await app.waitFor("window.__sectionTween");
  const opening = await app.eval<number>(
    `document.querySelector('${box}').getBoundingClientRect().height`,
  );
  expect(opening).toBeGreaterThan(0);
  expect(opening).toBeLessThan(start);
  await shot("sidebar-open");
  await app.eval(
    `document.querySelector('${box}').getAnimations().forEach(a=>a.play())`,
  );
  await settled();
  expect(
    await app.eval<number>(
      `document.querySelector('${box}').getBoundingClientRect().height`,
    ),
  ).toBeGreaterThan(0);
  expect(start).toBeGreaterThan(0);
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "sidebar-motion.json"),
      JSON.stringify({ exit, closeDuration, start, closing, opening }, null, 2),
    );
  expect(exit, "the loading skeleton has a paired opacity exit").toBe(true);
  expect(
    closeDuration.split(",")[0]?.trim(),
    "closing keeps the structural tween while the tree changes",
  ).not.toBe("0s");
});

it("keeps long palette edits focused and free of an inner border in both inputs", async () => {
  const reports = [];
  const prose = Array.from(
    { length: 18 },
    (_, i) =>
      `Paragraph ${i}: ${"A longer line wraps naturally in the palette. ".repeat(3)}`,
  ).join("\n\n");
  for (const agent of [false, true]) {
    await app.press("p", process.platform === "darwin" ? 4 : 2);
    await app.waitFor(
      `document.activeElement===document.querySelector('${input}')`,
    );
    if (agent) {
      await app.insertText("agent");
      await app.press("Space");
      await app.waitFor(
        `!!document.querySelector('${input}[contenteditable]')`,
      );
    }
    await app.insertText(prose);
    await app.press("ArrowUp");
    // Scroll to the start while the caret remains at the end, then delete
    // natively. Chromium must reveal the edited line and keep focus.
    await app.eval(`document.querySelector('${input}').scrollTop=0`);
    await shot(agent ? "palette-agent-scrolled" : "palette-textarea-scrolled");
    await app.press("Backspace");
    const beforeDelete = await app.eval<number>(
      `(()=>{const el=document.querySelector('${input}');return(el.isContentEditable?el.textContent:el.value).length})()`,
    );
    for (const type of ["keyDown", "keyUp"])
      await app.cdp("Input.dispatchKeyEvent", {
        type,
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        modifiers: process.platform === "darwin" ? 4 : 2,
        ...(type === "keyDown"
          ? {
              commands: [
                process.platform === "darwin"
                  ? "deleteToBeginningOfLine"
                  : "deleteWordBackward",
              ],
            }
          : {}),
      });
    expect(
      await app.eval<number>(
        `(()=>{const el=document.querySelector('${input}');return(el.isContentEditable?el.textContent:el.value).length})()`,
      ),
    ).toBeLessThan(beforeDelete);
    await app.press("Backspace");
    await app.waitFor(`document.querySelector('${input}').scrollTop>0`);
    reports.push(
      await app.eval(
        `(()=>{const el=document.querySelector('${input}');const style=getComputedStyle(el);return{agent:${agent},focused:document.activeElement===el,outline:style.outlineStyle,height:el.getBoundingClientRect().height,scroll:el.scrollTop}})()`,
      ),
    );
    await shot(agent ? "palette-agent-deleted" : "palette-textarea-deleted");
    await app.press("Escape");
    await app.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] [data-palette="overlay"]')?.closest('[inert]')`,
    );
  }
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "palette-editing.json"),
      JSON.stringify(reports, null, 2),
    );
  for (const report of reports) {
    expect(report).toMatchObject({ focused: true, outline: "none" });
  }
  expect(app.getRendererErrors()).toEqual([]);
});

it("fades the shared refresh indicator both ways and settles under reduced motion", async () => {
  await settled();
  // Page reads share fresh results for one second. Request a refresh through
  // the existing project intent so this motion fixture holds actual IO.
  await app.eval(
    `window.__holdChats();window.dispatchEvent(new CustomEvent('catamorphic:sidebar-refresh',{detail:${JSON.stringify(projectId)}}))`,
  );
  await app.waitFor("window.__heldChats()>0");
  try {
    await app.waitFor(
      `!!document.querySelector('${section} [data-loading-for="chats"]')`,
    );
  } catch (error) {
    const state = await app.eval(
      `(()=>{const root=document.querySelector('${section}');return{held:window.__heldChats(),text:root.textContent,rows:root.querySelectorAll('[role="treeitem"]').length,refreshDisabled:root.querySelector('[aria-label="Refresh chats"]').disabled,state:root.querySelector('[data-collapsible]').dataset.state}})()`,
    );
    throw new Error(JSON.stringify(state), { cause: error });
  }
  await app.waitFor(
    `getComputedStyle(document.querySelector('${section} .sidebar-refresh')).width==='28px'`,
  );
  await shot("sidebar-refresh");
  await app.eval(`window.__refreshExit=new Promise(resolve=>{
    const slot=document.querySelector('${section} .sidebar-refresh');
    slot.addEventListener('transitionrun',function onRun(event){
      if(event.propertyName!=='opacity')return;
      slot.removeEventListener('transitionrun',onRun);
      const animation=slot.getAnimations().find(a=>a.transitionProperty==='opacity');
      animation.pause();animation.currentTime=60;resolve(true);
    });
  });window.__releaseChats()`);
  expect(
    await app.eval(
      `Promise.race([window.__refreshExit,new Promise(r=>setTimeout(()=>r(false),1000))])`,
    ),
  ).toBe(true);
  await shot("sidebar-refresh-exit");
  await app.eval(
    `document.querySelector('${section} .sidebar-refresh').getAnimations().forEach(a=>{if(a.playState==='paused')a.play()})`,
  );
  await settled();
  expect(
    await app.eval(
      `getComputedStyle(document.querySelector('${section} .sidebar-refresh')).display`,
    ),
  ).toBe("none");
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await toggle();
    await settled();
    expect(
      await app.eval(
        `document.querySelector('${box}').getBoundingClientRect().height`,
      ),
    ).toBe(0);
    await toggle();
    await settled();
    expect(
      await app.eval(
        `document.querySelector('${box}').getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).every(a=>Number(a.effect?.getTiming().duration)<=1)`,
      ),
    ).toBe(true);
    await shot("sidebar-reduced-motion");
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});

it("keeps the caret visible after scroll-away deletion in a narrow New Tab", async () => {
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',760,700)`);
  await app.waitFor(
    `document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity)`,
  );
  const target =
    '[data-workspace-visible="true"] [data-palette="tab"] [aria-label="Search commands, pages, and more"]';
  const prose = Array.from(
    { length: 14 },
    (_, i) =>
      `Paragraph ${i}: ${"A wrapped paragraph remains editable. ".repeat(4)}`,
  ).join("\n\n");
  for (const agent of [false, true]) {
    await app.eval(`document.querySelector('${target}').focus()`);
    if (agent) {
      await app.insertText("agent");
      await app.press("Space");
      await app.waitFor(
        `!!document.querySelector('${target}[contenteditable]')`,
      );
    }
    await app.insertText(prose);
    await app.eval(`document.querySelector('${target}').scrollTop=0`);
    await app.press("Backspace");
    await app.waitFor(`document.querySelector('${target}').scrollTop>0`);
    await app.waitFor(
      `document.querySelector('[data-workspace-visible="true"] [data-palette="tab"]').getAnimations({subtree:true}).every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity)`,
    );
    // Native smooth scrolling is not part of Element.getAnimations().
    await app.waitFor(
      `(()=>{const el=document.querySelector('${target}');if(!el.isContentEditable)return true;const caret=getSelection().getRangeAt(0).getBoundingClientRect(),viewport=el.getBoundingClientRect();return caret.height>0&&caret.top>=viewport.top-1&&caret.bottom<=viewport.bottom+1})()`,
      { label: "the smooth caret reveal completed" },
    );
    const geometry = await app.eval<{
      visible: boolean;
      framesStill: boolean;
      outline: string;
    }>(`(()=>{
      const el=document.querySelector('${target}'),style=getComputedStyle(el),viewport=el.getBoundingClientRect();
      let caret;
      if(el.isContentEditable)caret=getSelection().getRangeAt(0).getBoundingClientRect();
      else{
        const mirror=document.createElement('div');
        Object.assign(mirror.style,{position:'fixed',visibility:'hidden',top:(viewport.top-el.scrollTop)+'px',left:viewport.left+'px',width:el.clientWidth+'px',boxSizing:'border-box',font:style.font,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing,padding:style.padding,whiteSpace:'pre-wrap',overflowWrap:'break-word'});
        mirror.textContent=el.value.slice(0,el.selectionEnd);
        const marker=document.createElement('span');marker.textContent='\u200b';mirror.append(marker,document.createTextNode(el.value.slice(el.selectionEnd)||'.'));
        document.body.append(mirror);caret=marker.getBoundingClientRect();mirror.remove();
      }
      const frames=[];for(let node=el.parentElement;node&&!node.hasAttribute('data-palette');node=node.parentElement)if(getComputedStyle(node).overflowY==='clip')frames.push(node);
      return{visible:caret.height>0&&caret.top>=viewport.top-1&&caret.bottom<=viewport.bottom+1,framesStill:frames.every(frame=>frame.scrollTop===0),outline:style.outlineStyle,agent:${agent},caret:{top:caret.top,bottom:caret.bottom,height:caret.height},viewport:{top:viewport.top,bottom:viewport.bottom},scroll:el.scrollTop};
    })()`);
    await shot(
      agent ? "palette-tab-agent-caret" : "palette-tab-textarea-caret",
    );
    expect(geometry, JSON.stringify(geometry)).toMatchObject({
      visible: true,
      framesStill: true,
      outline: "none",
    });
    // CDP does not resolve macOS's native editing key bindings.
    for (const type of ["keyDown", "keyUp"])
      await app.cdp("Input.dispatchKeyEvent", {
        type,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: process.platform === "darwin" ? 4 : 2,
        ...(type === "keyDown" ? { commands: ["selectAll"] } : {}),
      });
    await app.press("Backspace");
    await app.waitFor(
      `(()=>{const el=document.querySelector('${target}');return(el.isContentEditable?el.textContent:el.value)===''})()`,
      { label: "the previous palette input cleared" },
    );
  }
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1100,850)`);
});

it("keeps a tall section's opening tween while its paging tail grows back", async () => {
  await app.eval("window.__holdChats()");
  await writeSidebarSections(app, [
    {
      ...CHATS_SECTION,
      height: 1200,
      collapsed: true,
      headerActions: [
        { action: "refresh", label: "Refresh chats", icon: "RefreshCw" },
      ],
    },
  ]);
  await app.reload();
  await app.waitFor(`!!document.querySelector('${box}[data-state="closed"]')`);
  await toggle();
  await app.waitFor("window.__heldChats()>0");
  await app.eval("window.__releaseChats()");
  await app.waitFor(
    `document.querySelector('${section} [data-tree-viewport]').getBoundingClientRect().height>800`,
  );
  await settled();
  await toggle();
  await settled();
  const frames = await app.eval<
    Array<{ time: number; height: number; target: number; duration: number }>
  >(`new Promise(resolve=>{
    const box=document.querySelector('${box}'),frames=[],start=performance.now();
    const sample=()=>{
      const time=performance.now()-start;
      frames.push({time,height:box.getBoundingClientRect().height,target:parseFloat(box.style.height),duration:parseFloat(box.style.transitionDuration)});
      if(time<400)requestAnimationFrame(sample);else resolve(frames);
    };
    document.querySelector('${section} button[aria-expanded]').click();sample();
  })`);
  expect(
    new Set(frames.map((frame) => frame.target)).size,
    "the paging tail changes the target during opening",
  ).toBeGreaterThan(1);
  expect(frames.some((frame) => frame.height > 1 && frame.height < 800)).toBe(
    true,
  );
  expect(
    frames
      .filter((frame) => frame.time < 150)
      .every((frame) => frame.duration > 0),
    "descendant resize cannot zero the disclosure duration",
  ).toBe(true);
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "sidebar-tall-opening.json"),
      JSON.stringify(frames, null, 2),
    );
  await shot("sidebar-tall-open");
});
