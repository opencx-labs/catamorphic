import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeAccess } from "../shared/code-access.js";
import { canonicalModuleAccess, readModuleAccess } from "./module-access.js";
import { launchConfinedModule, moduleProfile } from "./module-sandbox.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function folder(prefix: string) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)),
  );
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function server(body: string) {
  const listening = http.createServer((_request, response) =>
    response.end(body),
  );
  await new Promise<void>((resolve) =>
    listening.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(
    () => new Promise<void>((resolve) => listening.close(() => resolve())),
  );
  const address = listening.address();
  if (!address || typeof address === "string") throw new Error("No port.");
  return address.port;
}

function compileWorker() {
  const target = path.join(folder("module-worker"), "worker.mjs");
  execFileSync(
    "bun",
    [
      "build",
      path.join(import.meta.dirname, "sidebar-source-worker.ts"),
      "--target=bun",
      "--outfile",
      target,
    ],
    { stdio: "pipe" },
  );
  return target;
}

/** Load a module once through the real worker, as Work starts it. */
async function loadConfined(
  source: string,
  access: CodeAccess,
  project = folder("module-project"),
  blocked?: (host: string, port: number) => boolean,
  isolation?: {
    scope?: string;
    scratchRoot?: string;
    executable?: string;
    workerPath?: string;
    beforeSpawn?: () => void;
  },
) {
  const modulePath = path.join(project, "module.ts");
  fs.writeFileSync(modulePath, source);
  const launch = await launchConfinedModule({
    executable: isolation?.executable ?? "bun",
    workerPath: isolation?.workerPath ?? compileWorker(),
    modulePath,
    projectRoot: project,
    access: canonicalModuleAccess({ access, projectRoot: project }),
    toolchain: { PATH: process.env.PATH ?? "" },
    scratchRoot: isolation?.scratchRoot ?? folder("module-scratch"),
    scope: isolation?.scope,
    blocked,
  });
  cleanups.push(() => launch.close());
  isolation?.beforeSpawn?.();
  const child = spawn(launch.command, launch.args, {
    cwd: project,
    env: launch.env,
    stdio: ["pipe", "ignore", "pipe", "pipe", ...(launch.inheritedFds ?? [])],
  });
  launch.spawned?.();
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await exited;
  });
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  const output = child.stdio[3];
  if (!output || !("readable" in output)) throw new Error("No output.");
  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No answer. ${stderr}`)),
      20_000,
    );
    createInterface({ input: output }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "capabilities")
        child.stdin?.write(
          `${JSON.stringify({ method: "load", id: "1", parentId: null })}\n`,
        );
      else if (message.id === "1") {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error));
        else
          resolve(
            Object.fromEntries(
              message.result.items.map(
                (item: { id: string; label: string }) => [item.id, item.label],
              ),
            ),
          );
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Worker ${child.pid} exited ${code ?? child.signalCode}: ${stderr}`,
        ),
      );
    });
  });
}

/** A module that tries each way out and reports what happened. */
const linuxConfinement =
  process.platform === "linux" &&
  process.env.CATAMORPHIC_TEST_MODULE_CONFINEMENT === "1";
const PROBE = (ports: { allowed: number; other: number }, secret: string) => `
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
const attempt = async (fn) => { try { return String(await fn()); } catch (error) { return "blocked"; } };
export default {
  async load() {
    const rows = {
      allowed: await attempt(async () => (await fetch("http://localhost:${ports.allowed}/")).text()),
      other: await attempt(async () => { const answer = await fetch("http://localhost:${ports.other}/"); if (!answer.ok) throw new Error(); return answer.text(); }),
      socket: await attempt(() => new Promise((resolve, reject) => { const socket = net.connect(${ports.other}, "127.0.0.1", () => { socket.end(); resolve("connected"); }); socket.on("error", reject); })),
      secret: await attempt(() => readFileSync(${JSON.stringify(secret)}, "utf8")),
      project: await attempt(() => readFileSync("notes.md", "utf8")),
      declared: await attempt(() => { writeFileSync("out.txt", "x"); return "written"; }),
      undeclared: await attempt(() => { writeFileSync("notes.md", "x"); return "written"; }),
      env: Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort().join(","),
    };
    return { items: Object.entries(rows).map(([id, label]) => ({ id, label })) };
  },
};
`;

describe("confined modules (ADR 0277)", () => {
  it.skipIf(process.platform !== "darwin")(
    "denies unapproved files outside the usual home and temporary roots",
    async () => {
      const outside = fs.mkdtempSync("/private/var/tmp/work-module-private-");
      cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
      const secret = path.join(outside, "private");
      fs.writeFileSync(secret, "must-not-leak");
      const program = path.join(outside, "program");
      fs.writeFileSync(
        `${program}.c`,
        '#include <stdio.h>\nint main(){puts("must-not-leak");return 0;}',
      );
      execFileSync("/usr/bin/cc", [`${program}.c`, "-o", program], {
        stdio: "pipe",
      });
      expect(execFileSync(program, { encoding: "utf8" }).trim()).toBe(
        "must-not-leak",
      );
      const rows = await loadConfined(
        `import fs from 'node:fs';
         import {execFileSync} from 'node:child_process';
         export default {async load(){let read='blocked',execute='blocked';try{read=fs.readFileSync(${JSON.stringify(secret)},'utf8')}catch{};try{execute=execFileSync(${JSON.stringify(program)},{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{};return {items:[{id:'read',label:read},{id:'execute',label:execute}]}}};`,
        {},
      );
      expect(rows.read).toBe("blocked");
      expect(rows.execute).toBe("blocked");
    },
    30_000,
  );

  it.skipIf(!linuxConfinement)(
    "does not follow a grant retargeted between approval and namespace setup",
    async () => {
      const project = folder("module-project"),
        outside = folder("module-outside"),
        granted = path.join(folder("module-grant"), "file"),
        secret = path.join(outside, "private");
      fs.writeFileSync(granted, "approved");
      fs.writeFileSync(secret, "must-not-leak");
      const rows = await loadConfined(
        `import fs from 'node:fs';
         export default {async load(){let label='blocked';try{label=fs.readFileSync(${JSON.stringify(granted)},'utf8')}catch{};return {items:[{id:'read',label}]}}};`,
        { reads: [granted] },
        project,
        undefined,
        {
          beforeSpawn: () => {
            fs.renameSync(granted, `${granted}.approved`);
            fs.symlinkSync(secret, granted);
          },
        },
      );
      expect(rows.read).toBe("approved");
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "blocks raw process-environment reads, with an unconfined control",
    async () => {
      const project = folder("module-project"),
        probe = path.join(project, "probe");
      fs.writeFileSync(
        `${probe}.c`,
        `#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv){char b[1048576];size_t n=sizeof(b);int mib[]={CTL_KERN,KERN_PROCARGS2,atoi(argv[1])};int rc=sysctl(mib,3,b,&n,NULL,0);puts(rc==0 && memmem(b,n,"module-native-secret",20)?"escaped":"blocked");return 0;}`,
      );
      execFileSync("/usr/bin/cc", [`${probe}.c`, "-o", probe], {
        stdio: "pipe",
      });
      const fixture = spawn(
        process.execPath,
        ["-e", "console.log('ready');setInterval(()=>{},1000)"],
        {
          env: { DUMMY_MODULE_SECRET: "module-native-secret" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      cleanups.push(async () => {
        if (fixture.exitCode !== null || fixture.signalCode !== null) return;
        const done = new Promise<void>((resolve) =>
          fixture.once("exit", () => resolve()),
        );
        fixture.kill();
        await done;
      });
      await new Promise<void>((resolve) =>
        fixture.stdout!.once("data", () => resolve()),
      );
      expect(
        execFileSync(probe, [String(fixture.pid)], { encoding: "utf8" }).trim(),
      ).toBe("escaped");
      const rows = await loadConfined(
        `
      import {execFileSync} from 'node:child_process';
      export default {async load(){return {items:[{id:'native',label:execFileSync(${JSON.stringify(probe)},[${JSON.stringify(String(fixture.pid))}],{encoding:'utf8'}).trim()}]}}};
    `,
        {},
        project,
      );
      expect(rows.native).toBe("blocked");
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "allows Bun itself without exposing a home that contains its bin folder",
    async () => {
      const home = folder("module-tool-home"),
        bin = path.join(home, "bin"),
        executable = path.join(bin, "bun");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(home, "private"), "must-not-leak");
      const bun = execFileSync(
        "bun",
        ["-e", "process.stdout.write(process.execPath)"],
        { encoding: "utf8" },
      );
      fs.copyFileSync(bun, executable, fs.constants.COPYFILE_FICLONE);
      const rows = await loadConfined(
        `
      import fs from 'node:fs';
      export default {async load(){let label='blocked';try{label=fs.readFileSync(${JSON.stringify(path.join(home, "private"))},'utf8')}catch{};return {items:[{id:'read',label}]}}};
    `,
        {},
        undefined,
        undefined,
        { executable },
      );
      expect(rows.read).toBe("blocked");
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "keeps profiles' private files apart even for the same project module",
    async () => {
      const project = folder("module-project"),
        runtimeRoot = folder("module-runtime"),
        scratchRoot = path.join(runtimeRoot, "scratch"),
        workerPath = path.join(runtimeRoot, "worker.mjs");
      execFileSync(
        "bun",
        [
          "build",
          path.join(import.meta.dirname, "sidebar-source-worker.ts"),
          "--target=bun",
          "--outfile",
          workerPath,
        ],
        { stdio: "pipe" },
      );
      const first = await loadConfined(
        `
      import fs from 'node:fs';
      export default {async load(){fs.writeFileSync(process.env.HOME+'/private','profile-a');return {items:[{id:'home',label:process.env.HOME}]}}};
    `,
        {},
        project,
        undefined,
        { scope: "profile-a", scratchRoot, workerPath },
      );
      const second = await loadConfined(
        `
      import fs from 'node:fs';
      export default {async load(){let label='blocked';try{label=fs.readFileSync(${JSON.stringify(`${first.home!}/private`)},'utf8')}catch{};return {items:[{id:'read',label},{id:'home',label:process.env.HOME}]}}};
    `,
        {},
        project,
        undefined,
        { scope: "profile-b", scratchRoot, workerPath },
      );
      expect(second.home).not.toBe(first.home);
      expect(second.read).toBe("blocked");
    },
    30_000,
  );

  it.skipIf(!linuxConfinement)(
    "reads local service configuration only with an explicit file grant",
    async () => {
      // The isolated native CI lane owns these empty fixture parents.
      // Every value is synthetic and readable by the ordinary test user.
      for (const parent of [
        "/usr/local/etc/work-module-tests",
        "/etc/ssl/work-module-tests",
      ]) {
        const privateDir = fs.mkdtempSync(`${parent}/private-`);
        cleanups.push(() =>
          fs.rmSync(privateDir, { recursive: true, force: true }),
        );
        const secret = path.join(privateDir, "service.env");
        fs.writeFileSync(secret, "synthetic-private-configuration");
        expect(fs.readFileSync(secret, "utf8")).toBe(
          "synthetic-private-configuration",
        );
        const source = `
          import fs from 'node:fs';
          export default {async load(){let label='blocked';try{label=fs.readFileSync(${JSON.stringify(secret)},'utf8')}catch{};return {items:[{id:'read',label}]}}};
        `;
        expect((await loadConfined(source, {})).read).toBe("blocked");
        expect((await loadConfined(source, { reads: [secret] })).read).toBe(
          "synthetic-private-configuration",
        );
      }
    },
    30_000,
  );

  it.skipIf(!linuxConfinement)(
    "blocks host Unix sockets, parent processes and namespace escapes",
    async () => {
      const socketFolder = folder("module-host-socket");
      const socketPath = path.join(socketFolder, "service.sock");
      const privateFile = path.join(folder("module-private"), "secret");
      fs.writeFileSync(privateFile, "must-not-leak");
      const listening = net.createServer((socket) => socket.end("escaped"));
      await new Promise<void>((resolve) =>
        listening.listen(socketPath, resolve),
      );
      cleanups.push(
        () => new Promise<void>((resolve) => listening.close(() => resolve())),
      );
      const rows = await loadConfined(
        `
      import fs from 'node:fs';
      import net from 'node:net';
      import {execFileSync} from 'node:child_process';
      const attempt=async fn=>{try{return String(await fn())}catch{return 'blocked'}};
      export default {async load(){
        const rows={
          unix:await attempt(()=>new Promise((resolve,reject)=>{const socket=net.connect(${JSON.stringify(socketPath)},()=>{socket.destroy();resolve('escaped')});socket.on('error',reject)})),
          parent:await attempt(()=>fs.readFileSync('/proc/1/environ','utf8')),
          namespace:await attempt(()=>execFileSync('/usr/bin/unshare',['-Ur','/bin/true'],{stdio:'pipe'})),
          nestedMount:await attempt(()=>execFileSync('/usr/bin/unshare',['-m','/bin/true'],{stdio:'pipe'})),
          descriptors:(()=>{for(const id of fs.readdirSync('/proc/self/fd')){try{if(fs.fstatSync(Number(id)).isDirectory()&&fs.readFileSync('/proc/self/fd/'+id+'/'+'../'.repeat(20)+${JSON.stringify(privateFile.slice(1))},'utf8')==='must-not-leak')return 'escaped'}catch{}}return 'blocked'})(),
          env:process.env.SRT_ALLOW_NESTED_USERNS??'clean',
        };
        return {items:Object.entries(rows).map(([id,label])=>({id,label}))};
      }};
    `,
        { reads: [socketFolder] },
      );
      expect(rows).toMatchObject({
        unix: "blocked",
        parent: "blocked",
        namespace: "blocked",
        nestedMount: "blocked",
        descriptors: "blocked",
        env: "clean",
      });
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "cannot read another process's environment",
    async () => {
      const fixture = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          env: { DUMMY_MODULE_SECRET: "module-process-probe" },
          stdio: "ignore",
        },
      );
      cleanups.push(async () => {
        if (fixture.exitCode !== null || fixture.signalCode !== null) return;
        const exited = new Promise<void>((resolve) =>
          fixture.once("exit", () => resolve()),
        );
        fixture.kill("SIGTERM");
        await exited;
      });
      const rows = await loadConfined(
        `
        import {execFileSync} from "node:child_process";
        export default {async load(){
          let label="blocked";
          try { if(execFileSync("/bin/ps",["eww","-p",${JSON.stringify(String(fixture.pid))}],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).includes("module-process-probe"))label="escaped"; } catch {}
          return {items:[{id:"environment",label}]};
        }};
      `,
        {},
      );
      expect(rows.environment).toBe("blocked");
    },
    30_000,
  );

  it("refuses a canonical directory replaced by a symlink before launch", async () => {
    const project = folder("module-project");
    const output = path.join(project, "output");
    const outside = folder("unapproved-output");
    fs.mkdirSync(output);
    const access = canonicalModuleAccess({
      access: { writes: ["output"] },
      projectRoot: project,
    });
    fs.rmdirSync(output);
    fs.symlinkSync(outside, output, "dir");
    await expect(
      launchConfinedModule({
        executable: "bun",
        workerPath: "/worker.mjs",
        modulePath: path.join(project, "module.ts"),
        projectRoot: project,
        access,
        toolchain: {},
        scratchRoot: folder("module-scratch"),
        platform: "linux",
        unconfined: true,
      }),
    ).rejects.toThrow("access paths changed");
  });

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "cannot write through a symlink retargeted after its destination was approved",
    async () => {
      const project = folder("module-project");
      const first = folder("approved-output");
      const second = folder("unapproved-output");
      const link = path.join(project, "output");
      fs.symlinkSync(first, link, "dir");
      const approved = canonicalModuleAccess({
        access: { writes: ["output"] },
        projectRoot: project,
      });
      fs.unlinkSync(link);
      fs.symlinkSync(second, link, "dir");
      const rows = await loadConfined(
        `
        import fs from "node:fs";
        export default { async load() {
          let label = "escaped";
          try { fs.writeFileSync("output/hook", "dummy"); } catch { label = "blocked"; }
          return { items: [{id:"write", label}] };
        } };
      `,
        approved,
        project,
      );
      expect(rows.write).toBe("blocked");
      expect(fs.existsSync(path.join(second, "hook"))).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "cannot tunnel to a blocked Work port through 0.0.0.0",
    async () => {
      const port = await server("escaped");
      const rows = await loadConfined(
        `
        import http from "node:http";
        export default { async load() {
          const proxy = new URL(process.env.HTTP_PROXY);
          const label = await new Promise((resolve, reject) => {
            http.get({ host: proxy.hostname, port: Number(proxy.port),
              path: "http://0.0.0.0:${port}/api/private", headers: {host:"127.0.0.1:${port}"} },
              res => { res.resume(); res.on("end", () => resolve(String(res.statusCode))); }).on("error", reject);
          });
          return {items:[{id:"api", label}]};
        } };
      `,
        { hosts: [`0.0.0.0:${port}`] },
        folder("module-project"),
        (_host, targetPort) => targetPort === port,
      );
      expect(rows.api).toBe("403");
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "reach only declared hosts and files, with an environment of their own",
    async () => {
      const allowed = await server("hello");
      const other = await server("leaked");
      const secret = path.join(folder("secret"), "token");
      fs.writeFileSync(secret, "s3cret");
      const project = folder("module-project");
      fs.writeFileSync(path.join(project, "notes.md"), "notes");
      fs.writeFileSync(path.join(project, "out.txt"), "");
      const rows = await loadConfined(
        PROBE({ allowed, other }, secret),
        { hosts: [`localhost:${allowed}`], writes: ["out.txt"] },
        project,
      );
      const { env, ...attempts } = rows;
      expect(env).not.toMatch(/SECRET|TOKEN|SRT_/);
      expect(attempts).toEqual({
        allowed: "hello",
        other: "blocked",
        socket: "blocked",
        secret: "blocked",
        project: "notes",
        declared: "written",
        undeclared: "blocked",
      });
      expect(fs.readFileSync(path.join(project, "notes.md"), "utf8")).toBe(
        "notes",
      );
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" && !linuxConfinement)(
    "has no network at all when it declares no hosts",
    async () => {
      const port = await server("leaked");
      const rows = await loadConfined(
        PROBE({ allowed: port, other: port }, "/etc/hosts"),
        {},
      );
      expect(rows).toMatchObject({
        allowed: "blocked",
        other: "blocked",
        socket: "blocked",
      });
    },
    30_000,
  );

  it("refuses to run unconfined, except for a throwaway E2E profile", async () => {
    const project = folder("module-project");
    const args = {
      executable: "bun",
      workerPath: "/worker.mjs",
      modulePath: path.join(project, "module.ts"),
      projectRoot: project,
      access: {},
      toolchain: { PATH: process.env.PATH ?? "", SECRET_KEY: "no" },
      scratchRoot: folder("module-scratch"),
      platform: "win32" as const,
    };
    await expect(launchConfinedModule(args)).rejects.toThrow(
      "require macOS or Linux",
    );
    const launch = await launchConfinedModule({ ...args, unconfined: true });
    // Found on PATH, as the shell would; nothing else of the toolchain kept.
    expect(launch.command).toMatch(/bun$/);
    expect(launch.env).not.toHaveProperty("SECRET_KEY");
    await launch.close();
  });

  it("writes a profile that opens only the proxy's port and declared places", () => {
    const profile = moduleProfile({
      projectRoot: "/Users/me/project",
      readable: ['/Users/me/odd "name"'],
      writable: ["/Users/me/project/out.txt"],
      proxyPort: 4321,
    });
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:4321"))',
    );
    expect(profile).toContain('(subpath "/Users/me/odd \\"name\\"")');
    expect(profile).toContain("(deny mach-lookup)");
    expect(
      moduleProfile({
        projectRoot: "/p",
        readable: [],
        writable: [],
        proxyPort: null,
      }),
    ).not.toContain("network-outbound");
  });
});

describe("a module's declaration (ADR 0277)", () => {
  it("is the nearest package.json's catamorphic.access, up to the project", () => {
    const project = folder("module-project");
    fs.mkdirSync(path.join(project, ".work", "linear"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".work", "package.json"),
      JSON.stringify({ catamorphic: { access: { lists: ["tabs"] } } }),
    );
    fs.writeFileSync(
      path.join(project, ".work", "linear", "package.json"),
      JSON.stringify({
        name: "linear",
        catamorphic: { access: { hosts: ["api.linear.app"] } },
      }),
    );
    expect(
      readModuleAccess({
        modulePath: path.join(project, ".work", "todos.ts"),
        projectRoot: project,
      }),
    ).toEqual({
      access: { lists: ["tabs"] },
      file: path.join(project, ".work", "package.json"),
    });
    expect(
      readModuleAccess({
        modulePath: path.join(project, ".work", "linear", "index.ts"),
        projectRoot: project,
      }).access,
    ).toEqual({ hosts: ["api.linear.app"] });
    // No package.json up to the root: it reads the project, nothing else.
    expect(
      readModuleAccess({
        modulePath: path.join(project, "scripts", "x.ts"),
        projectRoot: project,
      }),
    ).toEqual({ access: {}, file: null });
    expect(() =>
      readModuleAccess({
        modulePath: path.join(project, "..", "elsewhere.ts"),
        projectRoot: project,
      }),
    ).toThrow("outside the project");
  });
});
