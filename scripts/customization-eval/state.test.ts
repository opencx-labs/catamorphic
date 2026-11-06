import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
  });
});
beforeEach(async () => {
  await writeFile(manifest, declaration(["state"]));
});
afterAll(async () => {
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
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

it.skipIf(process.platform === "win32")(
  "a real reminder evaluation exits after destroying its immutable runtime sandbox",
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
    import {createPrivateCustomizationEvalHost} from ${JSON.stringify(path.join(repository, "apps/desktop/evals/private-customization-host.ts"))};
    import {createCodexAdapter} from ${JSON.stringify(path.join(repository, "packages/codex/src/index.ts"))};
    const directory=${JSON.stringify(temporary)};const project=path.join(directory,'project');await fs.mkdir(project);
    const fixture=await createPrivateCustomizationEvalHost({project,directory,adapter:createCodexAdapter()});
    let closed=false;
    try{
      await fixture.seed();
      const {title,dueAt,stateKey}=JSON.parse(await fs.readFile(path.join(project,'reminder-request.json'),'utf8'));
      await fixture.invoke({name:'private_state_write',input:{key:stateKey,value:{title,dueAt},ifVersion:0}});
      const source='import {defineWorkflow,trigger,type BoundaryContext} from "@catamorphic/workflow"; export const reminder=defineWorkflow(({defineBoundary})=>({permissions:["notifications:write"],triggers:[trigger("schedule",{at:'+JSON.stringify(dueAt)+'})],steps:[defineBoundary({run:({host}:BoundaryContext<unknown>)=>host["catamorphic.notifications"].publish({title:'+JSON.stringify(title)+',idempotencyKey:"cleanup-test"})})]}));';
      const artifact=await fixture.invoke({name:'private_workflow',input:{action:'create',name:'reminder',source}});
      const preview=await fixture.invoke({name:'private_workflow',input:{action:'preview',artifactId:artifact.id,revision:artifact.revision}});
      await fixture.invoke({name:'private_workflow',input:{action:'activate',artifactId:artifact.id,revision:artifact.revision,consentDigest:preview.consentDigest}});
      const grades=await fixture.grade();
      await fixture.close();closed=true;
      const remaining=(await fs.readdir(path.join(directory,'host-state/sandboxes'))).filter(name=>name.startsWith('local-'));
      console.log(JSON.stringify({grades,remaining}));
    }finally{if(!closed)await fixture.close()}
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
        evidence.grades.every((grade: { passed: boolean }) => grade.passed),
      ).toBe(true);
      expect(evidence.remaining).toEqual([]);
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
