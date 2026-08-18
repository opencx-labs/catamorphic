import { Sandbox } from "microsandbox";

// Compares host->supervisor transports for a minimal echo server in the
// guest, all against the same booted sandbox:
//   A) curl spawned inside the guest via exec (the current
//      CommandDeploymentRuntimeProvider path)
//   B) host fetch() to a published port (host TCP -> guest)
//   C) JSON-lines over a long-lived execStream's stdin/stdout (no TCP,
//      rides microsandbox's native host<->guest channel)

const ECHO_SERVER = `
const server = Bun.serve({
  port: 8321,
  hostname: "0.0.0.0",
  async fetch(req) {
    const body = await req.text();
    return new Response(JSON.stringify({ echo: body, t: Date.now() }), {
      headers: { "content-type": "application/json" },
    });
  },
});
console.log("ready on " + server.port);
`;

const STDIO_SERVER = `
const decoder = new TextDecoder();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ echo: msg.payload, seq: msg.seq }) + "\\n");
  }
});
console.log(JSON.stringify({ ready: true }));
`;

const N = 50;
const PAYLOAD = JSON.stringify({ invocationId: "inv-1", input: { x: 1 } });

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${label}: mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms (n=${samples.length})`,
  );
}

await using sandbox = await Sandbox.builder("bench-transport")
  .image("oven/bun")
  .memory(1024)
  .cpus(1)
  .port(18321, 8321)
  .patch((patch) =>
    patch
      .mkdir("/app", { mode: 0o755 })
      .text("/app/echo-server.ts", ECHO_SERVER)
      .text("/app/stdio-server.ts", STDIO_SERVER),
  )
  .replace()
  .create();

// Start echo server in the guest and wait for readiness.
const serverHandle = await sandbox.execStream("bun", [
  "run",
  "/app/echo-server.ts",
]);
for await (const event of serverHandle) {
  if (
    event.kind === "stdout" &&
    new TextDecoder().decode(event.data).includes("ready")
  )
    break;
  if (event.kind === "exited") throw new Error("echo server died");
}

// --- A) per-request process spawn in guest (current runtime provider
// transport shape; oven/bun has no curl, so a bun -e fetch stands in) ---
{
  const FETCH_ONCE = `const r = await fetch("http://127.0.0.1:8321/", {method:"POST", body: process.argv[2]}); process.stdout.write(await r.text());`;
  await sandbox.exec("bun", ["-e", FETCH_ONCE, "warm"]); // warm
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    const out = await sandbox.exec("bun", ["-e", FETCH_ONCE, PAYLOAD]);
    if (out.code !== 0) throw new Error(`guest fetch failed: ${out.stderr()}`);
    samples.push(performance.now() - start);
  }
  report("A) exec(spawn) per request  ", samples);
}

// --- B) host fetch() via published port ---
{
  await fetch("http://127.0.0.1:18321/", { method: "POST", body: "warm" });
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    const res = await fetch("http://127.0.0.1:18321/", {
      method: "POST",
      body: PAYLOAD,
    });
    await res.text();
    samples.push(performance.now() - start);
  }
  report("B) host fetch published port", samples);
}

// --- C) JSON-lines over execStream stdin/stdout ---
{
  const handle = await sandbox.execStreamWith("bun", (b) =>
    b.args(["run", "/app/stdio-server.ts"]).stdinPipe(),
  );
  const stdin = await handle.takeStdin();
  if (!stdin) throw new Error("no stdin sink");

  const decoder = new TextDecoder();
  let buffer = "";
  const pending: ((line: string) => void)[] = [];
  void (async () => {
    for await (const event of handle) {
      if (event.kind !== "stdout") continue;
      buffer += decoder.decode(event.data, { stream: true });
      let idx: number = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (line.trim()) pending.shift()?.(line);
      }
    }
  })();
  const nextLine = (): Promise<string> =>
    new Promise((resolve) => pending.push(resolve));
  const request = (msg: object): Promise<string> => {
    const reply = nextLine();
    void stdin.write(`${JSON.stringify(msg)}\n`);
    return reply;
  };

  await nextLine(); // the {"ready":true} banner
  await request({ seq: -1, payload: "warm" });
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await request({ seq: i, payload: PAYLOAD });
    samples.push(performance.now() - start);
  }
  report("C) stdio stream (no TCP)    ", samples);
  await handle.kill();
}

await serverHandle.kill();
