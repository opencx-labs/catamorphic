import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";

let app: AppHandle;
let projectRoot: string;
let projectId: string;
let otherProjectId: string;
const read = (name: string) =>
  fs.readFileSync(path.join(projectRoot, "probe-data", name), "utf8");

async function watchPulse(value: string) {
  await expect
    .poll(() => {
      fs.writeFileSync(path.join(projectRoot, "probe-data", "pulse"), value);
      return read("events")
        .split("\n")
        .filter(Boolean)
        .some((line) => JSON.parse(line).event === `pulse:${value}`);
    })
    .toBe(true);
}

beforeAll(async () => {
  app = await launchApp();
  projectRoot = path.join(app.userDataDir, "sidebar-owner-project");
  const project = await createProjectWorkspace({
    app,
    name: "Sidebar owner",
    rootPath: projectRoot,
  });
  projectId = project.id;
  fs.mkdirSync(path.join(projectRoot, ".work", "probe"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(projectRoot, "probe-data"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "probe-data", "label"), "First row");
  fs.writeFileSync(
    path.join(projectRoot, ".work", "probe", "package.json"),
    JSON.stringify({
      name: "sidebar-visibility-probe",
      private: true,
      catamorphic: { access: { writes: ["probe-data"] } },
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work", "probe", "index.ts"),
    `import {readFileSync,writeFileSync,appendFileSync,watch} from 'node:fs';
const mark=event=>appendFileSync('probe-data/events',JSON.stringify({event,pid:process.pid})+'\\n');
export default {
  load(){const label=readFileSync('probe-data/label','utf8');return {items:label?[{id:'row',label}]:[]};},
  subscribe({invalidate}){
    writeFileSync('probe-data/subscribed','yes');mark('subscribe');
    const watcher=watch('probe-data',(_event,name)=>{
      if(name==='pulse')mark('pulse:'+readFileSync('probe-data/pulse','utf8'));
      if(name==='label')invalidate();
    });
    return()=>{watcher.close();writeFileSync('probe-data/subscribed','no');mark('cleanup');};
  }
};`,
  );
  fs.writeFileSync(
    path.join(projectRoot, ".work", "workspace.js"),
    `module.exports={sidebars:{left:[{id:'probe',title:'Probe',sections:[{id:'probe',title:'Probe',source:'.work/probe/index.ts',hideEmpty:true}]}],right:[]}};`,
  );
  await app.reload();
  const allow =
    '[data-sidebar-section="probe"] [data-testid="module-access-allow"]';
  await app.waitFor(`!!document.querySelector(${JSON.stringify(allow)})`);
  await app.eval(`document.querySelector(${JSON.stringify(allow)}).click()`);
  await app.waitFor(
    `document.querySelector('[data-project-runtime="${projectId}"] [data-sidebar-source="probe"]')?.textContent.includes('First row')`,
  );
}, 180_000);

afterAll(async () => {
  await app?.stop();
});

it("pauses sidebar subscriptions in a retained project and resumes its existing view", async () => {
  await expect.poll(() => read("subscribed")).toBe("yes");
  const owner = `[data-project-runtime="${projectId}"]`;
  await app.eval(
    `window.__sidebarOwner=document.querySelector(${JSON.stringify(owner)});window.__sidebarRow=document.querySelector('${owner} [data-sidebar-item-id="row"]');undefined`,
  );
  await watchPulse("visible");
  const other = await createProjectWorkspace({
    app,
    name: "Other project",
    rootPath: path.join(app.userDataDir, "sidebar-other-project"),
  });
  otherProjectId = other.id;
  await app.waitFor(
    `document.querySelector('${owner}')?.dataset.workspaceVisible==='false' && document.querySelector('${owner}')?.inert && !!document.querySelector('[data-project-runtime="${other.id}"][data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  try {
    await expect.poll(() => read("subscribed")).toBe("no");
  } finally {
    // If release failed, a positive watch event distinguishes actual hidden
    // work from a stale marker; keep the observation in the failure log.
    if (read("subscribed") === "yes") {
      fs.writeFileSync(path.join(projectRoot, "probe-data", "pulse"), "hidden");
      await expect.poll(() => read("events")).toContain('"pulse:hidden"');
      console.info("Inactive sidebar probe", read("events"));
    }
  }
  fs.writeFileSync(
    path.join(projectRoot, "probe-data", "label"),
    "Updated row",
  );
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(projectId)}})`,
  );
  await app.waitFor(
    `document.querySelector('${owner}')?.dataset.workspaceVisible==='true' && document.querySelector('${owner} [data-sidebar-source="probe"]')?.textContent.includes('Updated row')`,
  );
  await expect.poll(() => read("subscribed")).toBe("yes");
  expect(
    await app.eval(
      `window.__sidebarOwner===document.querySelector('${owner}') && window.__sidebarRow===document.querySelector('${owner} [data-sidebar-item-id="row"]')`,
    ),
  ).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});

it("observes an empty source only while its project is in front", async () => {
  const owner = `[data-project-runtime="${projectId}"]`;
  fs.writeFileSync(path.join(projectRoot, "probe-data", "label"), "");
  await app.waitFor(
    `(() => {const source=document.querySelector('${owner} [data-sidebar-source="probe"]');return !!source?.closest('[hidden]') && !source.querySelector('[data-sidebar-item-id]');})()`,
  );
  expect(read("subscribed")).toBe("yes");
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(otherProjectId)}})`,
  );
  await app.waitFor(
    `document.querySelector('${owner}')?.dataset.workspaceVisible==='false' && !!document.querySelector('[data-project-runtime="${otherProjectId}"][data-workspace-visible="true"] [data-workspace-ready]')`,
  );
  await expect.poll(() => read("subscribed")).toBe("no");
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(projectId)}})`,
  );
  await expect.poll(() => read("subscribed")).toBe("yes");
  await watchPulse("empty-return");
  fs.writeFileSync(
    path.join(projectRoot, "probe-data", "label"),
    "Returned row",
  );
  await app.waitFor(
    `document.querySelector('${owner}')?.dataset.workspaceVisible==='true' && document.querySelector('${owner} [data-sidebar-source="probe"]')?.textContent.includes('Returned row') && !document.querySelector('${owner} [data-sidebar-widget="probe"]')?.hidden`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
