import { Sandbox } from "microsandbox";
import { MicrosandboxSandboxProvider } from "../src/index.js";

const provider = new MicrosandboxSandboxProvider({ namePrefix: "bench" });

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`${label}: ${ms(start)}`);
  return result;
}

async function metricsWithRetry(id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (await Sandbox.get(id)).metrics();
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const handles: string[] = [];
try {
  // 1. Cold create (image already pulled)
  const h1 = await timed("create sandbox (boot to ready)", () =>
    provider.createSandbox({}),
  );
  handles.push(h1.id);

  // 2. Exec latency: 20 sequential trivial commands
  await provider.executeCommand(h1.id, "true"); // warm connection
  {
    const start = performance.now();
    const n = 20;
    for (let i = 0; i < n; i++) {
      await provider.executeCommand(h1.id, "true");
    }
    console.log(
      `exec latency (bash -lc true): ${((performance.now() - start) / n).toFixed(1)}ms avg over ${n}`,
    );
  }

  // 3. Real command
  const bunVersion = await timed("exec `bun --version`", () =>
    provider.executeCommand(h1.id, "bun --version"),
  );
  console.log(`  -> ${bunVersion.result.trim()} (exit ${bunVersion.exitCode})`);

  // 4. File upload (50 small files) + download
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++)
    files[`src/file-${i}.ts`] = `export const v${i} = ${i};\n`;
  await timed("upload 50 files", () =>
    provider.uploadFiles(h1.id, files, `${provider.workspaceRoot}/proj`),
  );
  await timed("download 1 file", () =>
    provider.downloadFile(
      h1.id,
      `${provider.workspaceRoot}/proj/src/file-0.ts`,
    ),
  );

  // 5. Guest + host memory for idle sandbox
  const handle = await Sandbox.get(h1.id);
  const metrics = await handle.metrics();
  console.log(
    `guest memory: ${(metrics.memoryBytes / 1024 / 1024).toFixed(1)} MiB used / ${(metrics.memoryLimitBytes / 1024 / 1024).toFixed(0)} MiB limit`,
  );
  if (metrics.memoryHostResidentBytes) {
    console.log(
      `host-resident: ${(metrics.memoryHostResidentBytes / 1024 / 1024).toFixed(1)} MiB`,
    );
  }

  // 6. Concurrent sandboxes: boot 5 in parallel, measure wall clock + memory
  const start5 = performance.now();
  const five = await Promise.all(
    Array.from({ length: 5 }, () => provider.createSandbox({})),
  );
  console.log(`boot 5 sandboxes in parallel: ${ms(start5)}`);
  handles.push(...five.map((h) => h.id));
  let hostTotal = 0;
  for (const h of five) {
    const m = await metricsWithRetry(h.id);
    hostTotal += m.memoryHostResidentBytes ?? m.memoryBytes;
  }
  console.log(
    `avg host-resident per idle sandbox: ${(hostTotal / 5 / 1024 / 1024).toFixed(1)} MiB`,
  );

  // 7. Stop/start cycle (warm restart)
  await timed("stop sandbox", () => provider.stopSandbox(h1.id));
  await timed("restart sandbox", () => provider.startSandbox(h1.id));
  const persisted = await provider.downloadFile(
    h1.id,
    `${provider.workspaceRoot}/proj/src/file-0.ts`,
  );
  console.log(`file persisted across restart: ${persisted.length > 0}`);
} finally {
  const start = performance.now();
  await Promise.all(
    handles.map((id) => provider.destroySandbox(id).catch(() => {})),
  );
  console.log(`destroy ${handles.length} sandboxes: ${ms(start)}`);
}
