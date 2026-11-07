import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPrivateCustomizationEvalHost } from "../../apps/desktop/evals/private-customization-host.js";
import {
  privateSnapshotSchema,
  versionSchema,
} from "../../apps/desktop/src/shared/customization-protocol.js";
import { createCodexAdapter } from "../../packages/codex/src/index.js";
import { removeTestDirectory, settleTestProcesses } from "../test-processes.js";
import type { EvalFixture } from "./fixture.js";

let directory: string;
let project: string;
let modulePath: string;
let manifest: string;
let fixture: EvalFixture;
const declaration = (permissions: string[]) =>
  JSON.stringify({
    name: "state-sidebar",
    private: true,
    catamorphic: { access: { permissions } },
  });

beforeAll(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "eval-real-state-")),
  );
  project = path.join(directory, "project");
  const pkg = path.join(project, "sidebar");
  await mkdir(pkg, { recursive: true });
  modulePath = path.join(pkg, "source.ts");
  manifest = path.join(pkg, "package.json");
  await writeFile(modulePath, "export default {};");
  fixture = await createPrivateCustomizationEvalHost({
    project,
    directory,
    adapter: createCodexAdapter(),
    scenario: "todo-sidebar",
    bunPath: execFileSync("bun", ["-p", "process.execPath"], {
      encoding: "utf8",
    }).trim(),
  });
});
beforeEach(async () => {
  await writeFile(manifest, declaration(["state"]));
});
afterAll(async () => {
  await fixture?.close();
  if (directory) await removeTestDirectory(directory);
});

function sourceWork(file = modulePath) {
  if (!fixture.sourceWork) throw new Error("Real source state host is missing");
  return fixture.sourceWork({ modulePath: file });
}

it("returns the production state snapshot and preserves CAS versions across source instances", async () => {
  const first = sourceWork();
  const absent = privateSnapshotSchema.parse(
    await first("load", { op: "state-read", key: "tasks" }),
  );
  expect(absent).toMatchObject({ key: "tasks", version: 0, value: null });
  expect(absent.address).toMatch(/^_work\/packages\/[a-f0-9]{64}\/tasks$/);
  const written = privateSnapshotSchema.parse(
    await first("save", {
      op: "state-write",
      key: "tasks",
      value: { title: "Remember this" },
      ifVersion: 0,
    }),
  );
  expect(written.version).toBeGreaterThan(0);
  expect(written.address).toBe(absent.address);
  const restarted = sourceWork();
  expect(await restarted("load", { op: "state-read", key: "tasks" })).toEqual(
    written,
  );
  await expect(
    restarted("stale", {
      op: "state-write",
      key: "tasks",
      value: {},
      ifVersion: 0,
    }),
  ).rejects.toThrow();
  const deleted = versionSchema.parse(
    await restarted("delete", {
      op: "state-delete",
      key: "tasks",
      ifVersion: written.version,
    }),
  );
  expect(
    await restarted("load", { op: "state-read", key: "tasks" }),
  ).toMatchObject({
    ...deleted,
    key: "tasks",
    value: null,
    address: absent.address,
  });
});

it("shares state within one canonical package and keeps sibling packages separate", async () => {
  const first = sourceWork();
  await first("save", {
    op: "state-write",
    key: "shared",
    value: "saved",
    ifVersion: 0,
  });
  const sibling = path.join(path.dirname(modulePath), "second.ts");
  await writeFile(sibling, "export default {};");
  expect(
    await sourceWork(sibling)("load", { op: "state-read", key: "shared" }),
  ).toMatchObject({ key: "shared", value: "saved" });
  const other = path.join(project, "other");
  await mkdir(other);
  await writeFile(path.join(other, "package.json"), declaration(["state"]));
  const otherModule = path.join(other, "source.ts");
  await writeFile(otherModule, "export default {};");
  expect(
    await sourceWork(otherModule)("load", { op: "state-read", key: "shared" }),
  ).toMatchObject({ version: 0, value: null });
});

it("requires state in both process-start and current declarations", async () => {
  const running = sourceWork();
  await writeFile(manifest, declaration([]));
  await expect(
    running("load", { op: "state-read", key: "denied" }),
  ).rejects.toThrow("needs state");
  const unprivileged = sourceWork();
  await writeFile(manifest, declaration(["state"]));
  await expect(
    unprivileged("load", { op: "state-read", key: "denied" }),
  ).rejects.toThrow("needs state");
});

it("refuses a changed owning package and unsupported source operations", async () => {
  const nested = path.join(path.dirname(modulePath), "nested");
  await mkdir(nested);
  const file = path.join(nested, "source.ts");
  await writeFile(file, "export default {};");
  const running = sourceWork(file);
  await writeFile(path.join(nested, "package.json"), declaration(["state"]));
  await expect(
    running("load", { op: "state-read", key: "moved" }),
  ).rejects.toThrow("package changed");
  await expect(
    sourceWork()("load", { op: "read", source: "tabs" }),
  ).rejects.toThrow("work.state operations only");
});

it.skipIf(process.platform !== "darwin")(
  "real confined preview and runtime restarts share the actual private state host",
  async () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    const driver = path.join(directory, "source-state-driver.ts");
    await writeFile(
      driver,
      `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {createPrivateCustomizationEvalHost} from ${JSON.stringify(path.join(repository, "apps/desktop/evals/private-customization-host.ts"))};
    import {createCodexAdapter} from ${JSON.stringify(path.join(repository, "packages/codex/src/index.ts"))};
    import {stageSourceWorker} from ${JSON.stringify(path.join(repository, "scripts/customization-eval/sdk.ts"))};
    import {evalCustomizationTool} from ${JSON.stringify(path.join(repository, "scripts/customization-eval/tools.ts"))};
    import {createEvalSourceRuntime} from ${JSON.stringify(path.join(repository, "scripts/customization-eval/grade.ts"))};
    const directory=${JSON.stringify(path.join(directory, "runtime"))};
    const project=path.join(directory,'project');
    await fs.mkdir(project,{recursive:true});
    const modulePath=path.join(project,'source.ts');
    await fs.writeFile(path.join(project,'package.json'),${JSON.stringify(declaration(["state"]))});
    await fs.writeFile(modulePath,\`export default {async load({work}){const saved=await work.state.read({key:'counter'});const count=typeof saved.value==='number'?saved.value+1:1;await work.state.write({key:'counter',value:count,ifVersion:saved.version});return {items:[{id:'counter',label:String(count)}]}}};\`);
    const fixture=await createPrivateCustomizationEvalHost({project,directory,adapter:createCodexAdapter(),scenario:'todo-sidebar'});
    let runtime;
    try{
      await stageSourceWorker({repository:${JSON.stringify(repository)},directory});
      const preview=await evalCustomizationTool({name:'preview_customization',input:{source:'source.ts'},project,directory,repository:${JSON.stringify(repository)},sourceWork:fixture.sourceWork});
      const labels=[];
      for(let attempt=0;attempt<2;attempt++){
        runtime=createEvalSourceRuntime({project,modulePath,directory,repository:${JSON.stringify(repository)},sourceWork:fixture.sourceWork});
        const result=await runtime.request({projectId:'eval',sectionId:'state',requestId:String(attempt),method:'load'});
        labels.push(result.items[0].label);runtime.dispose();
      }
      console.log(JSON.stringify({preview,labels}));
    }finally{runtime?.dispose();await fixture.close()}
  `,
    );
    const result = await promisify(execFile)("bun", [driver], {
      cwd: repository,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const evidence = JSON.parse(result.stdout);
    expect(evidence.preview).toMatchObject({
      ok: true,
      result: { items: [{ label: "1" }] },
    });
    expect(evidence.labels).toEqual(["2", "3"]);
  },
);

it.skipIf(process.platform !== "darwin")(
  "real reminder installs, module imports, boundaries and nested Bun stay confined and clean up",
  async () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    const temporary = path.join(directory, "reminder-cleanup");
    await mkdir(temporary);
    const driver = path.join(temporary, "driver.ts");
    await writeFile(
      driver,
      `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import http from 'node:http';
    import {spawnSync} from 'node:child_process';
    import {createPrivateCustomizationEvalHost} from ${JSON.stringify(path.join(repository, "apps/desktop/evals/private-customization-host.ts"))};
    import {createCodexAdapter} from ${JSON.stringify(path.join(repository, "packages/codex/src/index.ts"))};
    const directory=${JSON.stringify(temporary)};const project=path.join(directory,'project');await fs.mkdir(project);
    const hidden=path.join(directory,'hidden-grader.txt');await fs.writeFile(hidden,'unchanged');
    const control=path.join(directory,'root-hook-control');await fs.mkdir(control);
    await fs.writeFile(path.join(control,'package.json'),JSON.stringify({name:'root-hook-control',private:true,scripts:{postinstall:'bun hook.ts'}}));
    await fs.writeFile(path.join(control,'hook.ts'),'import fs from "node:fs";fs.writeFileSync("hook-ran","ran")');
    const baseline=spawnSync(process.execPath,['install','--no-save','--backend=copyfile'],{cwd:control,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:control,TMPDIR:control},encoding:'utf8',timeout:5000});
    if(baseline.status!==0)throw new Error('Root lifecycle control failed: '+baseline.stderr);
    const rootHookControl=await fs.readFile(path.join(control,'hook-ran'),'utf8');
    const launcher=path.join(directory,'workflow-launcher','bun');
    let connections=0;const server=http.createServer((_request,response)=>{connections++;response.end('host listener')});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const endpoint='http://127.0.0.1:'+server.address().port;
    const fixture=await createPrivateCustomizationEvalHost({project,directory,adapter:createCodexAdapter()});
    let closed=false;
    try{
      await fixture.seed();
      const {title,dueAt,stateKey}=JSON.parse(await fs.readFile(path.join(project,'reminder-request.json'),'utf8'));
      await fixture.invoke({name:'private_state_write',input:{key:stateKey,value:{title,dueAt},ifVersion:0}});
      const probe=\`
        import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
        const hidden=\${JSON.stringify(hidden)};const launcher=\${JSON.stringify(launcher)};const hostPid=\${process.pid};
        function denied(fn){try{fn();return false}catch(error){return ['EACCES','EPERM'].includes(error.code)}}
        export function probe(stage){const inspect=spawnSync('/bin/ps',['-p',String(hostPid),'-o','command='],{encoding:'utf8'});const result={read:denied(()=>fs.readFileSync(hidden)),write:denied(()=>fs.writeFileSync(hidden,'tampered')),policyRead:denied(()=>fs.readFileSync(launcher)),policyWrite:denied(()=>fs.writeFileSync(launcher,'tampered')),sourceMode:denied(()=>fs.chmodSync(import.meta.path,0o600)),sourceWrite:denied(()=>fs.writeFileSync(import.meta.path,'tampered')),runtimeWrite:denied(()=>fs.writeFileSync(path.join(process.env.CATAMORPHIC_RUNTIME_ARTIFACT_ROOT,'../runtime/entry.mjs'),'tampered')),hardlink:denied(()=>fs.linkSync(hidden,path.join(process.env.HOME,'hardlink'))),hostSignal:denied(()=>process.kill(hostPid,0)),hostInspection:inspect.status!==0||!inspect.stdout.trim()};process.kill(process.pid,0);fs.writeFileSync(path.join(process.env.HOME,stage+'.json'),JSON.stringify(result));if(!Object.values(result).every(Boolean))throw new Error('Host boundary escaped at '+stage)}
        export async function network(stage){let blocked=false;try{await fetch(\${JSON.stringify(endpoint)},{signal:AbortSignal.timeout(1000)})}catch{blocked=true}fs.writeFileSync(path.join(process.env.HOME,stage+'-network.json'),JSON.stringify({blocked}));if(!blocked)throw new Error('Host listener reachable')}
        export async function boundary(){probe('boundary');await network('boundary');const nested=spawnSync('bun',['-e',\\\`const fs=require('node:fs');let blocked=false;try{fs.readFileSync(\\\${JSON.stringify(hidden)})}catch{blocked=true}if(!blocked)process.exit(3);process.kill(process.ppid,0);fs.writeFileSync(process.env.HOME+'/nested.json',JSON.stringify({read:blocked,parentSignal:true}));\\\`],{encoding:'utf8'});if(nested.status!==0)throw new Error('Nested Bun failed: '+nested.stderr)}
        if(process.argv[2]==='install'){fs.writeFileSync(path.join(process.env.HOME,'install.json'),'ran');fs.unlinkSync('workflows/package.json');fs.symlinkSync(hidden,'workflows/package.json')}
      \`;
      const source='import {defineWorkflow,trigger,type BoundaryContext} from "@catamorphic/workflow"; import {probe,boundary,network} from "../../../probe"; probe("module"); await network("module"); export const reminder=defineWorkflow(({defineBoundary})=>({permissions:["notifications:write"],triggers:[trigger("schedule",{at:'+JSON.stringify(dueAt)+'})],steps:[defineBoundary({run:async({host}:BoundaryContext<unknown>)=>{await boundary();return host["catamorphic.notifications"].publish({title:'+JSON.stringify(title)+',idempotencyKey:"cleanup-test"})}})]}));';
      const artifact=await fixture.invoke({name:'private_workflow',input:{action:'create',name:'reminder',source,files:{'.work/probe.ts':probe,'.work/package.json':JSON.stringify({name:'eval-install',private:true,workspaces:['contracts','workflows'],scripts:{postinstall:'bun probe.ts install'}}),'.work/bunfig.toml':'preload = ["./startup.ts"]\\n','.work/.env':'BUN_OPTIONS="--preload ./startup.ts"\\n','.work/startup.ts':'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(hidden)+',"startup escaped");throw new Error("Guest startup executed")'}}});
      const preview=await fixture.invoke({name:'private_workflow',input:{action:'preview',artifactId:artifact.id,revision:artifact.revision}});
      await fixture.invoke({name:'private_workflow',input:{action:'activate',artifactId:artifact.id,revision:artifact.revision,consentDigest:preview.consentDigest}});
      const grades=await fixture.grade();
      const sandboxes=path.join(directory,'host-state/sandboxes');const proofs={};
      for(const name of await fs.readdir(sandboxes)){if(!name.startsWith('local-'))continue;for(const stage of ['install','module','boundary','nested','module-network','boundary-network']){try{proofs[stage]=JSON.parse(await fs.readFile(path.join(sandboxes,name,'home',stage+'.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}}}
      await fixture.close();closed=true;
      const remaining=(await fs.readdir(path.join(directory,'host-state/sandboxes'))).filter(name=>name.startsWith('local-'));
      console.log(JSON.stringify({grades,remaining,proofs,connections,rootHookControl,hidden:await fs.readFile(hidden,'utf8')}));
    }finally{if(!closed)await fixture.close();await new Promise(resolve=>server.close(resolve))}
  `,
    );
    try {
      const result = await promisify(execFile)("bun", [driver], {
        cwd: repository,
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const evidence = JSON.parse(
        result.stdout.trim().split("\n").at(-1) ?? "null",
      );
      expect(evidence.grades).toHaveLength(5);
      expect(
        evidence.grades.filter((grade: { passed: boolean }) => !grade.passed),
      ).toEqual([]);
      expect(evidence.remaining).toEqual([]);
      expect(evidence.proofs.install).toBeUndefined();
      for (const stage of ["module", "boundary"])
        expect(evidence.proofs[stage]).toEqual({
          read: true,
          write: true,
          policyRead: true,
          policyWrite: true,
          sourceMode: true,
          sourceWrite: true,
          runtimeWrite: true,
          hardlink: true,
          hostSignal: true,
          hostInspection: true,
        });
      expect(evidence.proofs.nested).toEqual({
        read: true,
        parentSignal: true,
      });
      for (const stage of ["module-network", "boundary-network"])
        expect(evidence.proofs[stage]).toEqual({ blocked: true });
      expect(evidence.hidden).toBe("unchanged");
      expect(evidence.connections).toBe(0);
      expect(evidence.rootHookControl).toBe("ran");
    } finally {
      await settleTestProcesses({
        temporaryRoot: temporary,
        signal: "SIGTERM",
      });
      await removeTestDirectory(temporary);
    }
  },
  40_000,
);

it.skipIf(process.platform !== "darwin")(
  "drives manual reminder runs through source grants and a full host restart",
  async () => {
    const artifact = await fixture.invoke({
      name: "private_workflow",
      input: {
        action: "create",
        name: "manualReminder",
        source: `import {defineWorkflow,type BoundaryContext,type PauseResult} from '@catamorphic/workflow';
 type R={title:string;delay:string;key:string};
 export const manualReminder=defineWorkflow(({defineBoundary})=>({permissions:['notifications:write'],steps:[
 defineBoundary({run:({input,pause}:BoundaryContext<R>)=>pause<null,R>({timeout:input.delay,state:input})}),
 defineBoundary({run:({input,host}:BoundaryContext<PauseResult<null,R>>)=>host['catamorphic.notifications'].publish({title:input.state.title,idempotencyKey:input.state.key})})
 ]}));`,
      },
    });
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      Array.isArray(artifact) ||
      typeof artifact.id !== "string" ||
      typeof artifact.revision !== "number"
    )
      throw Error("Invalid private workflow artifact");
    const preview = await fixture.invoke({
      name: "private_workflow",
      input: {
        action: "preview",
        artifactId: artifact.id,
        revision: artifact.revision,
      },
    });
    if (
      typeof preview !== "object" ||
      preview === null ||
      Array.isArray(preview) ||
      typeof preview.consentDigest !== "string"
    )
      throw Error("Invalid private workflow consent preview");
    await fixture.invoke({
      name: "private_workflow",
      input: {
        action: "activate",
        artifactId: artifact.id,
        revision: artifact.revision,
        consentDigest: preview.consentDigest,
      },
    });
    const workflow = `private:${artifact.id}:${artifact.revision}`;
    await writeFile(
      manifest,
      JSON.stringify({
        name: "state-sidebar",
        catamorphic: {
          access: { permissions: ["state"], workflows: [workflow] },
        },
      }),
    );
    const allowed = sourceWork();
    for (const [i, delay] of ["2d", "7d", "2s"].entries())
      await allowed("add", {
        op: "start",
        workflow,
        input: {
          title: i === 2 ? "Manually added custom reminder" : "Presets",
          delay,
          key: `manual:${i}`,
        },
      });
    const errors = vi.spyOn(console, "error");
    try {
      const grades = await fixture.grade();
      expect(grades).toEqual([
        expect.objectContaining({
          id: "manual-reminder-after-host-restart",
          passed: true,
        }),
      ]);
      expect(errors.mock.calls.flat().join("\n")).not.toContain("poll failed");
    } finally {
      errors.mockRestore();
    }
  },
  20000,
);
