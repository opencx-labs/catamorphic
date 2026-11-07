import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalModuleAccess } from "./module-access.js";
import { launchConfinedModule } from "./module-sandbox.js";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";

/** Native confinement without Electron or a person's display. */
it
  .runIf(
    process.platform === "linux" &&
      process.env.CATAMORPHIC_TEST_MODULE_CONFINEMENT === "1",
  )
  .each([
    { ending: "dispose", ignoreTerm: false },
    { ending: "exit", ignoreTerm: true },
  ])(
  "ends ordinary confined children after worker $ending, including children ignoring TERM=$ignoreTerm",
  async ({ ending, ignoreTerm }) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "source-children-")),
    );
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, "data"), { recursive: true });
    const modulePath = path.join(projectRoot, "source.ts");
    const marker = `work-source-child:${root}`;
    // Read from the test's namespace. A child-reported process.pid belongs to
    // bwrap's nested PID namespace and must never be signalled on the host.
    const hostChildren = () =>
      fs.readdirSync("/proc").flatMap((entry) => {
        if (!/^\d+$/.test(entry) || Number(entry) < 2) return [];
        try {
          const args = fs
            .readFileSync(`/proc/${entry}/cmdline`, "utf8")
            .split("\0");
          return args.includes(marker) ? [Number(entry)] : [];
        } catch {
          // A process may exit between reading the directory and its argv.
          return [];
        }
      });
    const script = `const fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}let count=0;setInterval(()=>fs.writeFileSync('data/heartbeat',String(++count)),20);`;
    fs.writeFileSync(
      modulePath,
      `import {spawn} from 'node:child_process';
export default {async load(){const child=spawn(process.execPath,['-e',${JSON.stringify(script)},${JSON.stringify(marker)}],{stdio:'ignore'});child.unref();return {items:[{id:'child',label:'Child started'}]}},action(){process.exit(0)}};`,
    );
    const workerPath = path.join(root, "worker.mjs");
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
    const runtime = new SidebarSourceRuntime({
      modulePath,
      projectRoot,
      launch: () =>
        launchConfinedModule({
          executable: "bun",
          workerPath,
          modulePath,
          projectRoot,
          access: canonicalModuleAccess({
            projectRoot,
            access: { writes: ["data"] },
          }),
          scratchRoot: path.join(root, "scratch"),
          toolchain: { PATH: process.env.PATH ?? "" },
        }),
    });
    try {
      await runtime.request({
        projectId: "test",
        sectionId: "children",
        method: "load",
        requestId: "load",
      });
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(projectRoot, "data/heartbeat"))).toBe(
          true,
        ),
      );
      const pids = hostChildren();
      expect(pids).toHaveLength(1);
      const [pid] = pids;
      if (!pid) throw new Error("No fixture child process on the host.");
      expect(() => process.kill(pid, 0)).not.toThrow();
      if (ending === "dispose") runtime.dispose();
      else
        await expect(
          runtime.request({
            projectId: "test",
            sectionId: "children",
            method: "action",
            requestId: "exit",
            itemId: "child",
            action: "end",
          }),
        ).rejects.toThrow("stopped");
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
        timeout: 2_000,
      });
    } finally {
      runtime.dispose();
      for (const pid of hostChildren()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "darwin").each([false, true])(
  "denies native source forks, including detached=%s, while loading imports and formatting dates",
  async (detached) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "source-forks-")),
    );
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, "data"), { recursive: true });
    const modulePath = path.join(projectRoot, "source.ts");
    fs.writeFileSync(
      path.join(projectRoot, "helper.ts"),
      `export const label=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Amman',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date('2026-11-06T09:00:00Z'));`,
    );
    fs.writeFileSync(
      modulePath,
      `import {label} from './helper.ts';import {spawn} from 'node:child_process';
export default {async load(){const fork=await new Promise(resolve=>{try{const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{detached:${detached},stdio:'ignore'});child.once('error',e=>resolve(e.code));child.once('spawn',()=>{child.unref();resolve(String(child.pid))})}catch(e){resolve(e.code)}});return {items:[{id:'date',label},{id:'fork',label:fork},{id:'pid',label:String(process.pid)}]}}};`,
    );
    const workerPath = path.join(root, "worker.mjs");
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
    const runtime = new SidebarSourceRuntime({
      modulePath,
      projectRoot,
      launch: () =>
        launchConfinedModule({
          executable: "bun",
          workerPath,
          modulePath,
          projectRoot,
          access: {},
          scratchRoot: path.join(root, "scratch"),
          toolchain: { PATH: process.env.PATH ?? "" },
        }),
    });
    let escapedPid: number | undefined;
    try {
      const response = await runtime.request({
        projectId: "test",
        sectionId: "forks",
        method: "load",
        requestId: "load",
      });
      const page = z
        .object({
          items: z.array(z.object({ id: z.string(), label: z.string() })),
        })
        .parse(response);
      const rows = Object.fromEntries(
        page.items.map((item) => [item.id, item.label]),
      );
      if (/^\d+$/.test(rows.fork ?? "")) escapedPid = Number(rows.fork);
      expect(rows.fork).toBe("EPERM");
      expect(rows.date).toBe("12:00");
      const pid = Number(rows.pid);
      if (!Number.isSafeInteger(pid) || pid < 2)
        throw new Error("No fixture worker process.");
      runtime.dispose();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      runtime.dispose();
      if (escapedPid && escapedPid > 1) {
        try {
          process.kill(escapedPid, "SIGKILL");
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
