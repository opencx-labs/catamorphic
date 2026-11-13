import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { addTodoInput } from "../fixtures/customization-todos.js";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

let app: AppHandle, root: string;
let projectId: string;
const section =
  '[data-workspace-visible="true"] [data-sidebar-section="manual-todos"]';
const json = JSON.stringify;
async function capture(name: string) {
  const out = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
  if (!out) return;
  const folder = path.join(out, "customization-forms");
  fs.mkdirSync(folder, { recursive: true });
  await app.waitFor(
    `!document.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity)`,
  );
  await app.screenshot(path.join(folder, `${name}.png`));
}
async function click(selector: string) {
  const box = await app.waitFor<{ x: number; y: number }>(
    `(()=>{const el=document.querySelector(${json(selector)});if(!el||el.closest('[inert]')||el.matches(':disabled'))return false;el.scrollIntoView({block:'nearest',inline:'nearest'});const surface=el.closest('[role="dialog"], [data-sidebar]');if(surface?.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:false})()`,
  );
  await app.clickPointer(box);
}
async function fill(name: string, text: string) {
  const selector = `[role="dialog"] [name="${name}"]`;
  await click(selector);
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
  await app.waitFor(`document.querySelector(${json(selector)})?.value===''`, {
    label: `${name} cleared`,
  });
  await app.insertText(text);
  await app.waitFor(
    `document.querySelector(${json(selector)})?.value===${json(text)}`,
    { label: `${name} entered ${text}` },
  );
}
async function select(name: string, value: string) {
  const selector = `[role="dialog"] select[name="${name}"]`;
  const { current, target } = await app.waitFor<{
    current: number;
    target: number;
  }>(
    `(()=>{const el=document.querySelector(${json(selector)});if(!el)return false;return{current:el.selectedIndex,target:[...el.options].findIndex(o=>o.value===${json(value)})}})()`,
  );
  expect(target).toBeGreaterThanOrEqual(0);
  await click(selector);
  await app.waitFor(
    `document.querySelector(${json(selector)})?.matches(':open')`,
    {
      label: `${name} picker opened`,
    },
  );
  for (let i = 0; i < Math.abs(target - current); i++)
    await app.press(target < current ? "ArrowUp" : "ArrowDown");
  await app.press("Enter");
  await app.waitFor(
    `!document.querySelector(${json(selector)})?.matches(':open')`,
    {
      label: `${name} picker closed`,
    },
  );
  await app.waitFor(
    `document.querySelector(${json(selector)})?.value===${json(value)}`,
    { label: `${name} selected ${value}` },
  );
}
const runs = () =>
  app.eval<{
    items: Array<{
      status: string;
      error: string | null;
      input: unknown;
      activePause: unknown;
    }>;
  }>(
    `(async()=>{const {url}=await window.catamorphicDesktop.getServerState();return (await fetch(url+'/api/projects/'+${json(projectId)}+'/workflows/remind/runs')).json()})()`,
  );
async function submit() {
  await click('[role="dialog"] button[type="submit"]');
  await app
    .waitFor(
      `!document.querySelector('[data-action-input]') || [...document.querySelectorAll('[role="dialog"] [role="alert"]')].some(e=>e.textContent)`,
      { label: "action form completed or reported error" },
    )
    .catch(async (error) => {
      console.log(
        "Form diagnostic",
        await app.eval(
          `JSON.stringify([...document.querySelectorAll('form input,form select,form textarea')].map(e=>({name:e.name,value:e.value,valid:e.validity.valid,reason:e.validationMessage})))`,
        ),
      );
      throw error;
    });
  const error = await app.eval<string>(
    `[...document.querySelectorAll('[role="dialog"] [role="alert"]')].map(e=>e.textContent).join(' ')`,
  );
  if (error) throw Error(error);
  await app.waitFor(`!document.querySelector('[data-action-input]')`);
}
async function openAdd() {
  await click(`${section} button[aria-label="Add task"]`);
  await app.waitFor(`!!document.querySelector('input[name="title"]')`);
}

beforeAll(async () => {
  app = await launchApp();
  root = path.join(app.userDataDir, "manual-todos");
  const project = await createProjectWorkspace({
    app,
    name: "Manual reminders",
    rootPath: root,
  });
  projectId = project.id;
  const receipt = path.join(app.userDataDir, "reminder-receipt.json");
  const source = `import {defineWorkflow,type BoundaryContext,type PauseResult} from '@catamorphic/workflow';
 import {writeFile} from 'node:fs/promises';
 type Reminder={title:string;dueAt:string;key:string};
 export const remind=defineWorkflow(({defineBoundary})=>({permissions:['notifications:write'],steps:[
 defineBoundary({run:({input,pause}:BoundaryContext<Reminder>)=>pause<null,Reminder>({timeout:Math.max(0,new Date(input.dueAt).getTime()-Date.now())+'ms',state:input})}),
 defineBoundary({run:({input,host}:BoundaryContext<PauseResult<null,Reminder>>)=>host['catamorphic.notifications'].publish({title:input.state.title,idempotencyKey:input.state.key})}),
 defineBoundary({run:async({input}:BoundaryContext<unknown>)=>{await record({value:input});return input;}})
 ]}));
 /**
  * @displayname Record Reminder Receipt
  * @param value - @displayname Notification result | @description The completed notification result
  */
 async function record({value}:{value:unknown}){'use step';await writeFile(${json(receipt)},JSON.stringify(value));}`;
  const workflow = await app.eval<string>(
    `(async()=>{const {url}=await window.catamorphicDesktop.getServerState();const base=url+'/api/projects/'+${json(project.id)}+'/private-workflows';const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v};const a=await post(base,{name:'remind',source:${json(source)}});const p=await post(base+'/'+a.id+'/preview',{revision:a.revision});await post(base+'/'+a.id+'/activate',{revision:a.revision,consentDigest:p.consentDigest});return 'private:'+a.id+':'+a.revision})()`,
  );
  fs.mkdirSync(path.join(root, ".work/todos"), { recursive: true });
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../fixtures/customization-todos.ts"),
    path.join(root, ".work/todos/index.ts"),
  );
  fs.writeFileSync(
    path.join(root, ".work/todos/package.json"),
    json({
      name: "manual-todos",
      private: true,
      catamorphic: {
        access: { permissions: ["state"], workflows: [workflow] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, "reminder-workflow.json"),
    json({ workflow }),
  );
  fs.writeFileSync(path.join(root, "tasks.md"), "# Tasks\n");
  fs.writeFileSync(
    path.join(root, ".work/workspace.js"),
    `module.exports=${json({ sidebars: { left: [{ id: "tasks", title: "Tasks", sections: [{ id: "manual-todos", title: "Tasks", source: ".work/todos/index.ts", headerActions: [{ action: "add", label: "Add task", icon: "Plus", input: addTodoInput }] }] }], right: [] } })}`,
  );
  await app.reload();
  await click(`${section} [data-testid="module-access-allow"]`);
  await app.waitFor(
    `!document.querySelector(${json(`${section} [data-testid="module-access-request"]`)})`,
  );
});
afterAll(async () => {
  await app?.stop();
});

it("adds tasks with presets and repeated custom reminders through native controls", async () => {
  await openAdd();
  await fill("title", "Plan launch");
  await fill("notes", "Confirm the checklist and invite the team.");
  await app.waitFor(
    `document.querySelector('select[name="reminders.0.preset"]')?.value==='2d'`,
  );
  const frames: Array<{ timestamp: number; data: string }> = [];
  const off = app.onCdpEvent("Page.screencastFrame", (raw) => {
    const frame = z
      .object({
        sessionId: z.number(),
        data: z.string(),
        metadata: z.object({ timestamp: z.number() }),
      })
      .parse(raw);
    frames.push({ timestamp: frame.metadata.timestamp, data: frame.data });
    void app.cdp("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await app.cdp("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await click("[data-repeat-add]");
  await select("reminders.1.preset", "1w");
  await app.cdp("Page.stopScreencast");
  off();
  if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
    fs.writeFileSync(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
        "manual-reminder-motion.json",
      ),
      JSON.stringify(frames),
    );
  await capture("modal-presets");
  await submit();
  await app.waitFor(`document.body.innerText.includes('Plan launch')`);
  await openAdd();
  await fill("title", "Send reminder");
  await app.eval(`(()=>{
    window.__conditionalMotion=[];window.__conditionalMotionDone=false;
    const control=document.querySelector('select[name="reminders.0.preset"]');
    const dialog=control.closest('[role="dialog"]');
    window.__conditionalMotion.push(dialog.getBoundingClientRect().height);
    control.addEventListener('change',()=>{
      const start=performance.now();
      const sample=()=>{window.__conditionalMotion.push(dialog.getBoundingClientRect().height);
        if(performance.now()-start<600)requestAnimationFrame(sample);else window.__conditionalMotionDone=true;};
      requestAnimationFrame(sample);
    },{once:true});return true;
  })()`);
  await select("reminders.0.preset", "custom");
  await app.waitFor(`window.__conditionalMotionDone===true`);
  const heights = await app.eval<number[]>(`window.__conditionalMotion`);
  const first = heights[0] ?? 0,
    last = heights.at(-1) ?? 0;
  expect(last).toBeGreaterThan(first + 20);
  expect(
    heights.some((height) => height > first + 1 && height < last - 1),
  ).toBe(true);
  await fill("reminders.0.amount", "30");
  await capture("modal-custom");
  await select("reminders.0.unit", "seconds");
  const submittedAt = Date.now();
  await submit();
  await app.waitFor(`document.body.innerText.includes('Send reminder')`);
  const reminder = z.object({ title: z.string(), dueAt: z.iso.datetime() });
  const scheduled = (await runs()).items
    .map((r) => reminder.safeParse(r.input))
    .find((r) => r.success && r.data.title === "Send reminder");
  expect(scheduled?.success).toBe(true);
  if (!scheduled?.success) throw Error("Custom reminder was not enrolled.");
  const dueAt = new Date(scheduled.data.dueAt).getTime();
  expect(dueAt).toBeGreaterThanOrEqual(submittedAt + 30000);
  expect(dueAt).toBeLessThanOrEqual(Date.now() + 30000);
});
it("composes openings once and provides readable, copyable rich hover details", async () => {
  const target = await app.eval<{ x: number; y: number }>(
    `(()=>{const b=[...document.querySelectorAll(${json(`${section} [data-tree-primary]`)})].find(e=>e.textContent==='Plan launch');const r=b.getBoundingClientRect();return{x:r.x+40,y:r.y+r.height/2}})()`,
  );
  await app.movePointer(target);
  await app.waitFor(
    `!!document.querySelector('[data-resource-inspector][data-open=true]')`,
  );
  await app.waitFor(
    `document.querySelector('[data-resource-inspector]')?.textContent.includes('(Asia/Amman)')`,
  );
  const detail = await app.eval<{ wrapped: boolean; uppercase: boolean }>(
    `(()=>{const p=document.querySelector('[data-resource-inspector]');const d=p.querySelector('dd');return{wrapped:getComputedStyle(d).textOverflow!=='ellipsis',uppercase:getComputedStyle(p.querySelector('dt')).textTransform==='uppercase'}})()`,
  );
  expect(detail).toEqual({ wrapped: true, uppercase: false });
  await capture("inspector-light");
  await click('[data-resource-inspector] button[aria-label="Copy reminder 1"]');
  await app.waitFor(
    `!!document.querySelector('[data-resource-inspector] [data-copied=true]')`,
  );
  await click("[data-resource-inspector] button:not([aria-label])");
  await app.movePointer({ x: 900, y: 600 });
  await app.press("Escape");
  // Open by right click, so the full generated menu is tested rather than its data.
  await app.movePointer(target);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "right",
    buttons: 2,
    clickCount: 1,
    ...target,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "right",
    buttons: 0,
    clickCount: 1,
    ...target,
  });
  await app.waitFor(`!!document.querySelector('[role="menu"]')`);
  const labels = await app.eval<string[]>(
    `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(e=>e.textContent.trim())`,
  );
  expect(labels.filter((l) => l === "Open in new tab")).toHaveLength(1);
  expect(labels.filter((l) => l.startsWith("Open"))).toHaveLength(4);
  await capture("menu-composed");
  await app.press("Escape");
  await app.movePointer({ x: 800, y: 700 });
  await app.waitFor(
    `!document.querySelector('[role="menu"]')&&!document.querySelector('[data-resource-inspector][data-open=true]')`,
  );
  await app.eval(
    `window.catamorphicDesktop.devWindow('setSize',900,900);window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
  );
  await app.waitFor(
    `document.documentElement.dataset.theme==='dark'||document.querySelector('[data-theme=dark]')`,
  );
  await app.movePointer(target);
  await app.waitFor(
    `!!document.querySelector('[data-resource-inspector][data-open=true]')`,
  );
  await capture("inspector-dark-narrow");
  await app.movePointer({ x: 800, y: 700 });
  await app.press("Escape");
  await app.eval(
    `window.catamorphicDesktop.devWindow('setSize',1200,800);window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
  );
  const out = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR;
  if (out) {
    fs.mkdirSync(path.join(out, "customization-forms"), { recursive: true });
    await app.screenshot(
      path.join(out, "customization-forms", "inspector.png"),
    );
  }
});
it("retains tasks after a full restart and finishes the ordinary reminder workflow", async () => {
  const userDataDir = app.userDataDir;
  await app.stop({ preserveUserData: true });
  app = await launchApp({ userDataDir });
  await app.waitFor(
    `document.body.innerText.includes('Plan launch') && document.body.innerText.includes('Send reminder')`,
  );
  const before = await runs();
  expect(before.items.some((r) => r.status === "waiting")).toBe(true);
  try {
    await expect
      .poll(
        () => fs.existsSync(path.join(userDataDir, "reminder-receipt.json")),
        { timeout: 60000 },
      )
      .toBe(true);
  } finally {
    const result = await runs();
    console.log("Reminder workflow outcomes", result.items);
  }
  expect(
    JSON.parse(
      fs.readFileSync(path.join(userDataDir, "reminder-receipt.json"), "utf8"),
    ),
  ).toBeTruthy();
});
