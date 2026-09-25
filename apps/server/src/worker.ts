import { emitLog } from "@catamorphic/otel";
import { startTelemetry } from "@catamorphic/otel/node";
import {
  executionSettingsFromEnv,
  startWorkWorker,
} from "@catamorphic/work-server";

/**
 * A Work worker (ADR 0164): the same image, started with
 * `bun apps/server/src/worker.ts`. It executes agent sandboxes for a control
 * plane and holds no database URL, deployment secret, or vault key.
 *
 *   WORK_CONTROL_PLANE_URL   the control plane's public origin (HTTPS)
 *   WORK_WORKER_ENROLLMENT   one-time code, needed only on first start
 *   WORK_DATA_DIR            local state: credential and sandboxes (/data)
 *   WORK_SANDBOX, WORK_MAX_WORKSPACES, WORK_CAPACITY_*, WORK_WORKSPACE_*
 *                            execution backend and budgets, as on a server
 */
const telemetry = startTelemetry({ serviceName: "work-worker" });
const controlPlaneUrl = process.env.WORK_CONTROL_PLANE_URL;
if (!controlPlaneUrl) {
  throw new Error("Set WORK_CONTROL_PLANE_URL to the control plane's origin");
}
for (const name of ["DATABASE_URL", "WORK_SECRET", "WORK_VAULT_KEY"]) {
  // A worker that holds the control plane's secrets defeats its purpose.
  if (process.env[name]) {
    throw new Error(`${name} must not be set on a worker`);
  }
}

const worker = await startWorkWorker({
  controlPlaneUrl,
  dataDir: process.env.WORK_DATA_DIR ?? "/data",
  ...(process.env.WORK_WORKER_ENROLLMENT
    ? { enrollmentCode: process.env.WORK_WORKER_ENROLLMENT }
    : {}),
  execution: executionSettingsFromEnv(process.env),
  log: (line) => console.log(line),
});
emitLog({ scope: "work-worker", body: `Worker ${worker.nodeId} started` });
console.log(`Work worker ${worker.nodeId} is running.`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping worker…`);
  try {
    await worker.stop();
  } finally {
    await telemetry.shutdown();
  }
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
