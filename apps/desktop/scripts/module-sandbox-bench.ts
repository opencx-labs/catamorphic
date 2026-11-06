/** Non-GUI, synthetic module benchmark. No project secrets or external services. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { launchConfinedModule } from "../src/main/module-sandbox.js";

const samples = Number(process.env.MODULE_BENCH_SAMPLES ?? 30);
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "work-module-bench-")),
);
const worker = path.join(root, "worker.mjs");
const project = path.join(root, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "input"), Buffer.alloc(4096, 42));
fs.mkdirSync(path.join(project, "output"));
fs.writeFileSync(
  worker,
  `
import fs from 'node:fs';
import {createInterface} from 'node:readline';
const send = value => fs.writeSync(3, JSON.stringify(value)+'\\n');
send({ready:true});
createInterface({input:process.stdin}).on('line', async line => {
 const request=JSON.parse(line); if(request.stop) process.exit(0);
 const {url}=request, cpu=process.cpuUsage();
 const start=performance.now();
 let hash=0; for(let i=0;i<200000000;i++) hash=(hash+i)|0;
 const cpuMs=performance.now()-start;
 const io=performance.now();
 for(let i=0;i<1000;i++) { const b=fs.readFileSync('input'); fs.writeFileSync('output/item',b); }
 const ioMs=performance.now()-io;
 const net=performance.now();
 if(url) for(let i=0;i<100;i++) { const res=await fetch(url); if(await res.text()!=='fixture') throw Error('Bad response'); }
 const networkMs=url?performance.now()-net:null;
 const idleStart=process.cpuUsage();
 await new Promise(resolve=>setTimeout(resolve,1000));
 send({cpuMs,ioMs,networkMs,cpu:process.cpuUsage(cpu),idleCpu:process.cpuUsage(idleStart),rss:process.memoryUsage().rss,hash});
});
`,
);
const fixture = http.createServer((_req, res) => res.end("fixture"));
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw Error("No fixture port");
const fixturePort = address.port;
const url = `http://127.0.0.1:${fixturePort}/`;

const ticksPerSecond =
  process.platform === "linux"
    ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
    : 0;

function treeStats(pid: number): { bytes: number; cpuMs: number } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map(
      (line) =>
        line.trim().split(/\s+/).map(Number) as [number, number, number],
    );
  const descendants = new Set([pid]);
  for (let i = 0; i < rows.length; i++)
    for (const [id, parent] of rows)
      if (descendants.has(parent)) descendants.add(id);
  // Bubblewrap does not propagate descendant rusage to GNU time. Read the
  // live tree on Linux; include wrappers and relays, at CLK_TCK resolution.
  let bytes = 0,
    cpuMs = 0;
  for (const [id, , rss] of rows) {
    if (!descendants.has(id)) continue;
    bytes += rss * 1024;
    if (process.platform === "linux") {
      try {
        const text = fs.readFileSync(`/proc/${id}/stat`, "utf8");
        const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ");
        cpuMs +=
          ((Number(fields[11]) +
            Number(fields[12]) +
            Number(fields[13]) +
            Number(fields[14])) *
            1000) /
          ticksPerSecond;
      } catch {
        /* A finished relay has no live sample. */
      }
    }
  }
  return { bytes, cpuMs };
}

async function run(confined: boolean, network: boolean) {
  global.gc?.();
  const heapBefore = global.gc ? process.memoryUsage().heapUsed : null;
  let parentCpu = process.cpuUsage();
  const started = performance.now();
  const launch = confined
    ? await launchConfinedModule({
        executable: process.env.CATAMORPHIC_BUN ?? "bun",
        workerPath: worker,
        modulePath: worker,
        projectRoot: project,
        access: {
          writes: [path.join(project, "output")],
          ...(network ? { hosts: [`127.0.0.1:${fixturePort}`] } : {}),
        },
        scratchRoot: path.join(root, "scratch"),
        toolchain: { PATH: process.env.PATH ?? "" },
      })
    : {
        command: process.env.CATAMORPHIC_BUN ?? "bun",
        args: [worker],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          TMPDIR: root,
          LANG: "en_US.UTF-8",
        },
        close: async () => {},
      };
  const child = spawn("/usr/bin/time", ["-p", launch.command, ...launch.args], {
    cwd: project,
    detached: true,
    env: launch.env,
    stdio: [
      "pipe",
      "ignore",
      "pipe",
      "pipe",
      ...("inheritedFds" in launch ? (launch.inheritedFds ?? []) : []),
    ],
  });
  if ("spawned" in launch) launch.spawned?.();
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const output = child.stdio[3];
  if (!output || !("readable" in output)) throw Error("No protocol pipe");
  let readyMs = 0,
    treeBytes = 0;
  let startupParentCpu: NodeJS.CpuUsage | undefined;
  try {
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`Benchmark timed out: ${stderr}`)),
          30000,
        );
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(Error(`Exited ${code}: ${stderr}`));
        });
        createInterface({ input: output }).on("line", (line) => {
          const value = JSON.parse(line);
          if (value.ready) {
            readyMs = performance.now() - started;
            startupParentCpu = process.cpuUsage(parentCpu);
            treeBytes = treeStats(child.pid!).bytes;
            parentCpu = process.cpuUsage();
            child.stdin?.write(
              `${JSON.stringify({ url: network ? url : null })}\n`,
            );
          } else {
            clearTimeout(timer);
            resolve(value);
          }
        });
      },
    );
    const workParentCpu = process.cpuUsage(parentCpu);
    global.gc?.();
    const parentHeapDelta =
      heapBefore === null ? null : process.memoryUsage().heapUsed - heapBefore;
    const finalTree = treeStats(child.pid!);
    treeBytes = Math.max(treeBytes, finalTree.bytes);
    const exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.stdin?.end(`${JSON.stringify({ stop: true })}\n`);
    await exited;
    const seconds = (label: string) =>
      Number(new RegExp(`^${label} +([0-9.]+)`, "m").exec(stderr)?.[1]);
    return {
      parentHeapDelta,
      startupParentCpu,
      totalCpuMs:
        process.platform === "linux"
          ? finalTree.cpuMs
          : (seconds("user") + seconds("sys")) * 1000,
      readyMs,
      treeBytes,
      ...result,
      parentCpu: workParentCpu,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      process.kill(-child.pid!, "SIGTERM");
      await exited;
    }
    await launch.close();
  }
}
const results: Array<Record<string, unknown>> = [];
try {
  for (let sample = -2; sample < samples; sample++) {
    for (const network of [false, true])
      for (const confined of sample % 2 === 0 ? [false, true] : [true, false]) {
        const result = await run(confined, network);
        if (sample >= 0) results.push({ sample, confined, network, ...result });
      }
    if (sample >= 0) process.stderr.write(`Sample ${sample + 1}/${samples}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        environment: {
          platform: process.platform,
          arch: process.arch,
          kernel: os.release(),
          cpu: os.cpus()[0]?.model,
          bun: execFileSync(
            process.env.CATAMORPHIC_BUN ?? "bun",
            ["--version"],
            { encoding: "utf8" },
          ).trim(),
          parent: process.version,
        },
        samples: results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
