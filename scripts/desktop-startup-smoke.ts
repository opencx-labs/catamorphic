// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This release CLI launches an isolated packaged process outside Turbo.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertIsolatedDesktopTestHost } from "./desktop-test-environment.js";

const LEGACY = {
  "review-comment:release:new": "Unsent review draft",
  "catamorphic.draft:release:main": "Unsaved editor draft",
};
const UPDATED = {
  "review-comment:release:new": "Edited after upgrading",
  "catamorphic.draft:release:main": "Newer editor draft",
};
const MARKER = "__work_origin_migrated_v1";

async function storageFixture(
  directory: string,
  profile: string,
  mode: "seed" | "inspect" | "verify",
) {
  const requireDesktop = createRequire(
    path.resolve("apps/desktop/package.json"),
  );
  const electron: unknown = requireDesktop("electron");
  if (typeof electron !== "string")
    throw new Error("No fixture Electron binary");
  const html = path.join(directory, "legacy.html");
  await fs.writeFile(html, "<!doctype html><title>Storage fixture</title>");
  const file = path.join(directory, "storage-fixture.cjs");
  await fs.writeFile(
    file,
    `
const {app,protocol,session,WebContentsView}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});
protocol.registerSchemesAsPrivileged([{scheme:'work-internal',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.whenReady().then(async()=>{
  const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try {
    await view.webContents.loadFile(${JSON.stringify(html)});
    const legacy=await view.webContents.executeJavaScript(${JSON.stringify(`(() => { ${mode === "seed" ? `for(const [k,v] of Object.entries(${JSON.stringify(LEGACY)})) localStorage.setItem(k,v);` : ""} return Object.fromEntries(${JSON.stringify(Object.keys(LEGACY))}.map(k=>[k,localStorage.getItem(k)])); })()`)});
    if(JSON.stringify(legacy)!==JSON.stringify(${JSON.stringify(LEGACY)}))throw Error('Legacy source changed');
    ${
      mode !== "seed"
        ? `session.defaultSession.protocol.handle('work-internal',()=>new Response('<!doctype html><title>Storage fixture</title>',{headers:{'content-type':'text/html'}}));
    await view.webContents.loadURL('work-internal://shell/index.html');
    const current=await view.webContents.executeJavaScript(${JSON.stringify(`(() => { const result=Object.fromEntries(${JSON.stringify([...Object.keys(LEGACY), MARKER])}.map(k=>[k,localStorage.getItem(k)])); ${mode === "inspect" ? `for(const [k,v]of Object.entries(${JSON.stringify(UPDATED)}))localStorage.setItem(k,v);` : ""} return result; })()`)});
    if(JSON.stringify(current)!==JSON.stringify(${JSON.stringify({ ...(mode === "inspect" ? Object.fromEntries(Object.keys(LEGACY).map((key) => [key, null])) : UPDATED), [MARKER]: null })}))throw Error('Internal storage differs: '+JSON.stringify(current));`
        : ""
    }
    view.webContents.close(); session.defaultSession.flushStorageData(); console.log('WORK_STORAGE_FIXTURE_OK'); app.quit();
  }catch(e){console.error(e);view.webContents.close();app.exit(1)}
});
setTimeout(()=>app.exit(2),30000).unref();
`,
  );
  execFileSync(electron, [file, "--use-mock-keychain"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ELECTRON_RUN_AS_NODE: undefined,
    },
    timeout: 45_000,
    stdio: "pipe",
  });
}

async function boot(
  binary: string,
  profile: string,
  version: string,
  windowProbe: string,
) {
  const child = spawn(binary, ["--use-mock-keychain"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: process.env.SHELL,
      TMPDIR: process.env.TMPDIR,
      CATAMORPHIC_E2E_DATA_DIR: profile,
      CATAMORPHIC_E2E_FAKE_AGENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Observe rejection immediately, including spawn failures before the readiness loop.
  void exited.catch(() => {});
  let stopped = false;
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Packaged app exited before startup: ${output}`);
      if (Date.now() >= deadline)
        throw new Error(`Packaged app did not boot: ${output}`);
      const successful = await fs
        .readFile(path.join(profile, "data/last-successful-version"), "utf8")
        .catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      if (
        output.includes("[desktop] API ready on ") &&
        successful.trim() === version &&
        child.pid
      ) {
        const windows = execFileSync(windowProbe, [String(child.pid)], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        if (Number(windows) > 0) break;
      }
      await delay(100);
    }
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const result = await exited;
      stopped = true;
      if (
        result.code !== 0 ||
        result.signal !== null ||
        !output.includes("Shutdown complete")
      )
        throw new Error(
          `Packaged app did not quit cleanly: ${JSON.stringify(result)}\n${output}`,
        );
      if (
        /Main process (uncaught|unhandled)|ERR_FILE_NOT_FOUND|embedded server failed to start/.test(
          output,
        )
      )
        throw new Error(`Packaged startup reported an error: ${output}`);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (!stopped) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

async function main() {
  assertIsolatedDesktopTestHost();
  if (process.platform !== "darwin")
    throw new Error(
      "Signed startup verification requires an isolated macOS runner",
    );
  const app = process.argv[2];
  if (!app || process.argv.length !== 3)
    throw new Error(
      "Usage: bun scripts/desktop-startup-smoke.ts <signed Work.app>",
    );
  const binary = path.resolve(app, "Contents/MacOS/Work");
  const version = execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleShortVersionString",
      path.resolve(app, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "work-packaged-startup-"),
  );
  let success = false;
  try {
    const swift = path.join(directory, "windows.swift"),
      probe = path.join(directory, "windows");
    await fs.writeFile(
      swift,
      `import Cocoa\nimport CoreGraphics\nlet pid=Int32(CommandLine.arguments[1])!\nlet windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []\nprint(windows.filter { item in guard let owner=item[kCGWindowOwnerPID as String] as? Int32,owner==pid,let bounds=item[kCGWindowBounds as String] as? [String:Any],let width=bounds["Width"] as? Double,let height=bounds["Height"] as? Double else{return false};return width>=700 && height>=400 }.count)\n`,
    );
    execFileSync(
      "xcrun",
      [
        "swiftc",
        swift,
        "-module-cache-path",
        path.join(directory, "swift-cache"),
        "-o",
        probe,
      ],
      { timeout: 120_000, stdio: "pipe" },
    );
    const fresh = path.join(directory, "fresh"),
      legacy = path.join(directory, "upgrade");
    await fs.mkdir(fresh);
    await fs.mkdir(legacy);
    await boot(binary, fresh, version, probe);
    await storageFixture(directory, legacy, "seed");
    await boot(binary, legacy, version, probe);
    await storageFixture(directory, legacy, "inspect");
    await boot(binary, legacy, version, probe);
    await storageFixture(directory, legacy, "verify");
    console.log(
      `Verified signed Work ${version}: fresh startup, upgrade without file-origin import, retained internal drafts, visible windows, embedded server, and normal quits`,
    );
    success = true;
  } finally {
    if (success) await fs.rm(directory, { recursive: true, force: true });
    else console.error(`Packaged startup diagnostics retained at ${directory}`);
  }
}
if (import.meta.main) await main();
