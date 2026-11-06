import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { callBackgroundRuntime } from "../src/main/background-runtime.js";
import { launchApp, removeE2eDirectory } from "./harness.js";

/** Actual Quit, not a hidden workspace or a retained renderer. */
it("exits the foreground OS process and runs an approved private schedule in a windowless helper", async () => {
  const app = await launchApp({
    env: { CATAMORPHIC_E2E_BACKGROUND_RUNTIME: "1" },
  });
  const resultFile = path.join(app.userDataDir, "scheduled-after-quit.json");
  let stopped = false;
  let helperPid: number | undefined;
  try {
    const projectRoot = path.join(app.userDataDir, "background-project");
    await app.eval(
      `window.catamorphicDesktop.createProject({name:'Background schedule',rootPath:${JSON.stringify(projectRoot)}})`,
    );
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const source = `import { defineWorkflow, trigger } from "@catamorphic/workflow";
import { writeFile } from "node:fs/promises";
/** @displayname Write after Quit */
export const afterQuit = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { at: ${JSON.stringify(scheduledAt)} })],
  steps: [defineBoundary({ run: async () => { await record({}); return { recorded: true }; } })],
}));
/** @displayname Record scheduled work */
async function record({}: Record<string, never>) {
  "use step";
  await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ completedAt: Date.now() }));
}
`;
    await app.eval(`(async()=>{
      const {url}=await window.catamorphicDesktop.getServerState();
      const {items}=await (await fetch(url+'/api/projects')).json();
      const project=items.find(p=>p.name==='Background schedule');
      const base=url+'/api/projects/'+project.id+'/private-workflows';
      const post=async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value};
      const artifact=await post(base,{name:'afterQuit',source:${JSON.stringify(source)}});
      const preview=await post(base+'/'+artifact.id+'/preview',{revision:artifact.revision});
      await post(base+'/'+artifact.id+'/activate',{revision:artifact.revision,consentDigest:preview.consentDigest});
    })()`);
    expect(fs.existsSync(resultFile)).toBe(false);
    const originalPid = app.processId;
    expect(originalPid).toBeTypeOf("number");
    await app.stop({
      preserveUserData: true,
      captureFinalFrame: false,
      shutdownTimeoutMs: 90_000,
    });
    stopped = true;
    const quitCompletedAt = Date.now();
    if (!originalPid) throw new Error("The foreground process had no id.");
    expect(() => process.kill(originalPid, 0)).toThrow();
    const inspection = await callBackgroundRuntime({
      userData: app.userDataDir,
      command: "inspect",
    });
    if (
      typeof inspection !== "object" ||
      inspection === null ||
      !("pid" in inspection) ||
      typeof inspection.pid !== "number"
    )
      throw new Error("The helper did not identify its OS process.");
    helperPid = inspection.pid;
    expect(helperPid).not.toBe(originalPid);
    expect(inspection).toMatchObject({ windows: 0, running: true });
    await expect
      .poll(() => fs.existsSync(resultFile), { timeout: 120_000 })
      .toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    expect(result.completedAt).toBeGreaterThan(quitCompletedAt);
  } finally {
    if (!stopped)
      await app.stop({
        preserveUserData: true,
        captureFinalFrame: false,
        shutdownTimeoutMs: 90_000,
      });
    if (fs.existsSync(path.join(app.userDataDir, "background-runtime.json"))) {
      if (!helperPid) {
        const record = JSON.parse(
          fs.readFileSync(
            path.join(app.userDataDir, "background-runtime.json"),
            "utf8",
          ),
        );
        if (typeof record.pid === "number") helperPid = record.pid;
      }
      await callBackgroundRuntime({
        userData: app.userDataDir,
        command: "shutdown",
      });
      if (helperPid) {
        const pid = helperPid;
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 60_000 },
          )
          .toBe(false);
      }
      await expect
        .poll(
          () =>
            fs.existsSync(
              path.join(app.userDataDir, "background-runtime.json"),
            ),
          { timeout: 60_000 },
        )
        .toBe(false);
    }
    removeE2eDirectory(app.userDataDir);
  }
});
