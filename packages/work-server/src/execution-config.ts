import os from "node:os";
import path from "node:path";
import type { WorkerCapacity } from "@catamorphic/core";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";

/** How this machine executes agent and workflow sandboxes. */
export interface WorkExecutionSettings {
  backend: "local-process" | "microsandbox";
  capacity: WorkerCapacity;
  /** Per-workspace defaults; microsandbox only. */
  defaults: { cpuMillis?: number; memoryMb?: number };
  sandboxImage?: string;
  /** Executable search path for trusted subprocess execution. */
  path: string;
  /**
   * Workloads this control-plane machine runs itself (ADR 0164). A company
   * deployment keeps agents on enrolled workers with `["workflow"]`.
   */
  workloads: ("agent" | "workflow")[];
  /**
   * Explicitly accept agent code as a plain subprocess of a shared control
   * plane, where it could read the server's own secrets.
   */
  trustControlPlaneAgents: boolean;
}

/** Parse and validate the `WORK_SANDBOX` and capacity variables. */
export function executionSettingsFromEnv(
  env: Record<string, string | undefined>,
): WorkExecutionSettings {
  const positive = (name: string, fallback: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const backend = env.WORK_SANDBOX ?? "local-process";
  if (backend !== "local-process" && backend !== "microsandbox")
    throw new Error("WORK_SANDBOX must be microsandbox or local-process");
  const capacity: WorkerCapacity = {
    workspaces: positive("WORK_MAX_WORKSPACES", 8),
    ...(backend === "microsandbox"
      ? {
          cpuMillis: positive(
            "WORK_CAPACITY_CPU_MILLIS",
            Math.max(1, os.availableParallelism() - 1) * 1000,
          ),
          memoryMb: positive(
            "WORK_CAPACITY_MEMORY_MB",
            Math.max(1024, Math.floor((os.totalmem() / 1024 / 1024) * 0.75)),
          ),
        }
      : {}),
  };
  const defaults =
    backend === "microsandbox"
      ? {
          cpuMillis: positive("WORK_WORKSPACE_CPU_MILLIS", 1000),
          memoryMb: positive("WORK_WORKSPACE_MEMORY_MB", 1024),
        }
      : {};
  if (
    backend === "local-process" &&
    [
      "WORK_CAPACITY_CPU_MILLIS",
      "WORK_CAPACITY_MEMORY_MB",
      "WORK_WORKSPACE_CPU_MILLIS",
      "WORK_WORKSPACE_MEMORY_MB",
    ].some((key) => env[key] !== undefined)
  )
    throw new Error("CPU and memory limits require WORK_SANDBOX=microsandbox");
  const settings: WorkExecutionSettings = {
    backend,
    capacity,
    defaults,
    ...(env.WORK_SANDBOX_IMAGE ? { sandboxImage: env.WORK_SANDBOX_IMAGE } : {}),
    path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    workloads: workloadsFromEnv(env.WORK_CONTROL_PLANE_WORKLOADS),
    trustControlPlaneAgents: env.WORK_TRUST_CONTROL_PLANE_AGENTS === "1",
  };
  validateExecutionSettings(settings);
  return settings;
}

function workloadsFromEnv(raw: string | undefined): ("agent" | "workflow")[] {
  if (raw === undefined) return ["agent", "workflow"];
  const workloads = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const workload of workloads) {
    if (workload !== "agent" && workload !== "workflow") {
      throw new Error(
        "WORK_CONTROL_PLANE_WORKLOADS lists agent, workflow, or nothing",
      );
    }
  }
  return workloads.filter(
    (workload): workload is "agent" | "workflow" =>
      workload === "agent" || workload === "workflow",
  );
}

function validateExecutionSettings(settings: WorkExecutionSettings): void {
  const { capacity, defaults } = settings;
  if (defaults.cpuMillis && defaults.cpuMillis % 1000 !== 0)
    throw new Error("Microsandbox CPU limits require whole cores");
  if (
    (defaults.cpuMillis ?? 0) > (capacity.cpuMillis ?? Infinity) ||
    (defaults.memoryMb ?? 0) > (capacity.memoryMb ?? Infinity)
  )
    throw new Error(
      "Default workspace resources exceed this machine's capacity",
    );
  if (
    settings.backend === "local-process" &&
    (capacity.cpuMillis !== undefined ||
      capacity.memoryMb !== undefined ||
      defaults.cpuMillis !== undefined ||
      defaults.memoryMb !== undefined)
  )
    throw new Error("CPU and memory limits require the microsandbox backend");
}

/** Work server choices only. Embedders construct providers and budgets themselves. */
export function workExecution(args: {
  settings: WorkExecutionSettings;
  dataDir: string;
}) {
  const { settings } = args;
  validateExecutionSettings(settings);
  const provider =
    settings.backend === "microsandbox"
      ? new MicrosandboxSandboxProvider({
          image: settings.sandboxImage,
          cpus: (settings.defaults.cpuMillis ?? 1000) / 1000,
          memoryMib: settings.defaults.memoryMb,
        })
      : new LocalProcessSandboxProvider({
          root: path.join(args.dataDir, "sandboxes"),
          env: { PATH: settings.path, LANG: "C.UTF-8" },
        });
  return {
    provider,
    capacity: settings.capacity,
    defaults: settings.defaults,
    isolation:
      settings.backend === "microsandbox"
        ? ("sandbox" as const)
        : ("process" as const),
  };
}
