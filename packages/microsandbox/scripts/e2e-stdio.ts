import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import type { RuntimeInvocationEvent } from "@catamorphic/sandbox";
import { MicrosandboxSandboxProvider } from "../src/index.js";

const provider = new MicrosandboxSandboxProvider({ namePrefix: "e2e" });
const runtimeProvider = provider.deploymentRuntime;

const WORKFLOW = `export async function greet(input) {
  return globalThis.__catamorphicRunStep(
    "greet-node",
    "Greet",
    async () => ({ message: \`hello \${input.name}\`, invocation: process.env.CATAMORPHIC_INVOCATION_ID }),
    input,
  );
}
export async function slowEcho(input) {
  await new Promise((r) => setTimeout(r, input.delayMs ?? 0));
  return { echoed: input };
}`;

const identity = {
  deploymentArtifactId: "artifact-e2e",
  artifactDigest: "digest-e2e",
  transformVersion: "transform-1",
  runtimeVersion: "runtime-1",
};

function invocation(args: {
  runtimeId: string;
  invocationId: string;
  exportName: string;
  input: unknown;
  events?: RuntimeInvocationEvent[];
}) {
  return {
    runtimeId: args.runtimeId,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    invocationId: args.invocationId,
    ...identity,
    kind: "workflow" as const,
    target: { modulePath: "workflow.ts", exportName: args.exportName },
    input: args.input,
    attempt: 1,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    ...(args.events
      ? {
          eventSink: {
            report: async ({ events }: { events: readonly RuntimeInvocationEvent[] }) => {
              args.events?.push(...events);
            },
          },
        }
      : {}),
  };
}

let sandboxId: string | undefined;
try {
  console.log("== boot ==");
  let start = performance.now();
  const handle = await provider.createSandbox({});
  sandboxId = handle.id;
  console.log(`sandbox created: ${(performance.now() - start).toFixed(0)}ms`);

  const projectDirectory = `${provider.workspaceRoot}/project`;
  await provider.uploadFiles(sandboxId, { "workflow.ts": WORKFLOW }, projectDirectory);

  start = performance.now();
  const runtime = await runtimeProvider.ensureRuntime({
    sandboxId,
    ...identity,
    workingDirectory: projectDirectory,
    maxConcurrency: 4,
  });
  console.log(
    `ensureRuntime (upload supervisor + bun boot + ready): ${(performance.now() - start).toFixed(0)}ms`,
  );

  console.log("\n== correctness ==");
  const events: RuntimeInvocationEvent[] = [];
  const receipt = await runtimeProvider.invoke(
    invocation({
      runtimeId: runtime.runtimeId,
      invocationId: "inv-greet-1",
      exportName: "greet",
      input: { name: "Ada" },
      events,
    }),
  );
  console.log(`terminal: ${receipt.terminal.status}`);
  if (receipt.terminal.status !== "completed") throw new Error("expected completed");
  console.log(`result: ${JSON.stringify(receipt.terminal.result)}`);
  console.log(`event types (pushed): ${events.map((event) => event.type).join(", ")}`);
  console.log(`steps recorded: ${receipt.terminal.steps.length}`);

  const dedupe = await runtimeProvider.invoke(
    invocation({
      runtimeId: runtime.runtimeId,
      invocationId: "inv-greet-1",
      exportName: "greet",
      input: { name: "Ada" },
    }),
  );
  console.log(
    `idempotent redelivery returns same result: ${JSON.stringify(dedupe.terminal) === JSON.stringify(receipt.terminal)}`,
  );

  const health = await runtimeProvider.getHealth({ runtimeId: runtime.runtimeId });
  console.log(`health: ${health.runtimeStatus}, maxConcurrency=${health.maxConcurrency}`);

  console.log("\n== invocation latency (full invoke round trip) ==");
  {
    const n = 30;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await runtimeProvider.invoke(
        invocation({
          runtimeId: runtime.runtimeId,
          invocationId: `inv-lat-${i}`,
          exportName: "slowEcho",
          input: { delayMs: 0, i },
        }),
      );
      samples.push(performance.now() - t);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      `slowEcho(0ms) x${n}: mean=${(samples.reduce((a, b) => a + b, 0) / n).toFixed(1)}ms p50=${sorted[Math.floor(n * 0.5)]?.toFixed(1)}ms p95=${sorted[Math.floor(n * 0.95)]?.toFixed(1)}ms`,
    );
    console.log(
      "  (includes worker child_process fork + module import inside the VM per invocation)",
    );
  }

  console.log("\n== concurrent invocations ==");
  {
    const t = performance.now();
    const receipts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runtimeProvider.invoke(
          invocation({
            runtimeId: runtime.runtimeId,
            invocationId: `inv-conc-${i}`,
            exportName: "slowEcho",
            input: { delayMs: 250, i },
          }),
        ),
      ),
    );
    const ok = receipts.every((r) => r.terminal.status === "completed");
    console.log(
      `8 x slowEcho(250ms) @ maxConcurrency=4: ${(performance.now() - t).toFixed(0)}ms total, all completed: ${ok}`,
    );
  }

  console.log("\n== cancellation ==");
  {
    const controller = new AbortController();
    const pending = runtimeProvider.invoke({
      ...invocation({
        runtimeId: runtime.runtimeId,
        invocationId: "inv-cancel-1",
        exportName: "slowEcho",
        input: { delayMs: 20_000 },
      }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test cancel")), 300);
    const outcome = await pending.then(
      (r) => `terminal=${r.terminal.status}`,
      (e) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.log(`canceled invocation -> ${outcome}`);
  }
} finally {
  if (sandboxId) await provider.destroySandbox(sandboxId).catch(() => {});
  const shutdown = (runtimeProvider as { shutdown?: () => Promise<void> }).shutdown;
  if (shutdown) await shutdown.call(runtimeProvider).catch(() => {});
  console.log("\ncleaned up");
}
