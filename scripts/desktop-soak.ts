import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { launchApp, setReactValueJs } from "../apps/desktop/e2e/harness.js";

const exec = promisify(execFile);
export function cpuSeconds(value: string): number {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = (clock ?? "0").split(":").map(Number);
  return (
    Number(days) * 86400 + parts.reduce((total, part) => total * 60 + part, 0)
  );
}
export function processTree(raw: string, root: number) {
  const processes = raw
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, rss, time] = line.trim().split(/\s+/);
      return time && Number.isFinite(Number(pid))
        ? [
            {
              pid: Number(pid),
              parent: Number(parent),
              rssKb: Number(rss),
              cpuSeconds: cpuSeconds(time),
            },
          ]
        : [];
    });
  const ids = new Set([root]);
  for (let size = 0; size !== ids.size; ) {
    size = ids.size;
    for (const process of processes)
      if (ids.has(process.parent)) ids.add(process.pid);
  }
  return processes.filter((process) => ids.has(process.pid));
}

async function main() {
  if (process.platform === "win32")
    throw new Error("The soak sampler currently supports macOS and Linux");
  const option = (name: string, fallback: string) =>
    process.argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=") ?? fallback;
  const duration = Number(option("duration", "300"));
  const interval = Number(option("interval", "5"));
  if (
    !Number.isFinite(duration) ||
    duration < 10 ||
    !Number.isFinite(interval) ||
    interval < 1
  )
    throw new Error(
      "Use a duration of at least 10 seconds and interval of at least 1 second",
    );
  const output = path.resolve(option("output", "/tmp/catamorphic-soak.json"));
  const fixture = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<title>Soak page</title><h1>Local fixture</h1>");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const fixtureUrl = `http://127.0.0.1:${address.port}`;
    const revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
    const dirty = Boolean(
      (await exec("git", ["status", "--porcelain"])).stdout.trim(),
    );
    const app = await launchApp({
      env: { CATAMORPHIC_E2E_WINDOW_MODE: "visible" },
    });
    const samples: Array<{
      elapsed: number;
      phase: string;
      rssMb: number;
      cpuPercent: number;
      processCount: number;
      renderer: unknown;
      processes: ReturnType<typeof processTree>;
      resources: { requests: number; guestCount: number; nodeCount: number };
    }> = [];
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      if (!app.processId) throw new Error("Missing Electron process id");
      await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
      await app.eval(
        `window.catamorphicDesktop.createProject({name:'Soak fixture',rootPath:${JSON.stringify(`${app.userDataDir}/soak-project`)}})`,
      );
      await app.eval("location.reload()");
      await app.waitFor(`document.body?.innerText.includes('Soak fixture')`);
      // Exercise retention before quiet sampling; all fixtures are local and credential-free.
      for (let cycle = 0; cycle < 8; cycle++) {
        await app.eval(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),altKey:true,bubbles:true}))`,
        );
        await app.waitFor(
          `!!document.querySelector('input[aria-label="Address and search bar"]')`,
        );
        await app.eval(
          `(() => { ${setReactValueJs}; const input = document.querySelector('input[aria-label="Address and search bar"]'); setReactValue(input, ${JSON.stringify(fixtureUrl)}); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`,
        );
        await app.waitFor(
          `document.querySelector('webview')?.getAttribute('src')?.startsWith(${JSON.stringify(fixtureUrl)})`,
        );
        await app.waitFor(
          `document.querySelector('[data-point-key^="browser:"]')?.textContent.includes('Soak page')`,
        );
        await app.eval(
          `document.querySelector('[data-point-key^="browser:"] button[aria-label^="Close "]').click()`,
        );
        await app.waitFor(`document.querySelectorAll('webview').length === 0`);
        await app.waitFor(
          `!document.querySelector('[data-point-key^="browser:"]')`,
        );
      }
      await app.waitFor(`document.querySelectorAll('webview').length === 0`);
      await app.eval(
        `(()=>{window.__soakRequests=0;window.__soakObserver=new PerformanceObserver(list=>{window.__soakRequests+=list.getEntries().length});window.__soakObserver.observe({type:'resource'})})()`,
      );
      await app.cdp("Performance.enable");
      const start = Date.now();
      let previousAt = start;
      let previous = new Map<number, number>();
      while (!stopping && Date.now() - start < duration * 1000) {
        const now = Date.now();
        const elapsed = (now - start) / 1000;
        const phase =
          elapsed < duration / 3
            ? "foreground"
            : elapsed < (duration * 2) / 3
              ? "background"
              : "resumed";
        await app.cdp("Emulation.setFocusEmulationEnabled", {
          enabled: phase !== "background",
        });
        const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,time="]);
        const processes = processTree(stdout, app.processId);
        const consumed = processes.reduce(
          (sum, process) =>
            sum +
            Math.max(
              0,
              process.cpuSeconds -
                (previous.get(process.pid) ?? process.cpuSeconds),
            ),
          0,
        );
        const renderer = await app.cdp("Performance.getMetrics");
        samples.push({
          elapsed,
          phase,
          rssMb:
            processes.reduce((sum, process) => sum + process.rssKb, 0) / 1024,
          cpuPercent: previous.size
            ? (consumed / ((now - previousAt) / 1000)) * 100
            : 0,
          processCount: processes.length,
          renderer,
          processes,
          resources: await app.eval<{
            requests: number;
            guestCount: number;
            nodeCount: number;
          }>(
            `({requests:window.__soakRequests,guestCount:document.querySelectorAll('webview').length,nodeCount:document.querySelectorAll('*').length})`,
          ),
        });
        previous = new Map(
          processes.map((process) => [process.pid, process.cpuSeconds]),
        );
        previousAt = now;
        await fs.writeFile(
          output,
          JSON.stringify(
            {
              revision,
              dirty,
              platform: process.platform,
              architecture: process.arch,
              osRelease: os.release(),
              duration,
              interval,
              scenario:
                "Local tab churn then foreground, simulated background and resumed idle. Does not simulate OS sleep.",
              samples,
              errors: app.getRendererErrors(),
            },
            null,
            2,
          ),
        );
        console.log(
          `[soak] ${elapsed.toFixed(0)}s ${phase}: ${samples.at(-1)?.rssMb.toFixed(0)} MB, ${samples.at(-1)?.cpuPercent.toFixed(1)}% CPU`,
        );
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
      if (app.getRendererErrors().length)
        throw new Error(app.getRendererErrors().join("\n"));
      console.log(`Resource samples: ${output}`);
    } catch (error) {
      await app.screenshot(`${output}.png`).catch(() => undefined);
      throw error;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await app.stop();
    }
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
}
if (import.meta.main) await main();
