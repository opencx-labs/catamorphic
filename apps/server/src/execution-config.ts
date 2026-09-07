import os from "node:os";
import path from "node:path";
import type { WorkerCapacity } from "@catamorphic/core";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";

/** Stock-host choices only. Embedders construct providers and budgets themselves. */
export function stockExecution(args: {
  env: Record<string, string | undefined>;
  data: string;
}) {
  const { env } = args;
  const positive = (name: string, fallback: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const backend = env.CATAMORPHIC_SANDBOX ?? "local-process";
  if (backend !== "local-process" && backend !== "microsandbox")
    throw new Error(
      "CATAMORPHIC_SANDBOX must be microsandbox or local-process",
    );
  const capacity: WorkerCapacity = {
    workspaces: positive("CATAMORPHIC_MAX_WORKSPACES", 8),
    ...(backend === "microsandbox"
      ? {
          cpuMillis: positive(
            "CATAMORPHIC_CAPACITY_CPU_MILLIS",
            Math.max(1, os.availableParallelism() - 1) * 1000,
          ),
          memoryMb: positive(
            "CATAMORPHIC_CAPACITY_MEMORY_MB",
            Math.max(1024, Math.floor((os.totalmem() / 1024 / 1024) * 0.75)),
          ),
        }
      : {}),
  };
  const defaults =
    backend === "microsandbox"
      ? {
          cpuMillis: positive("CATAMORPHIC_WORKSPACE_CPU_MILLIS", 1000),
          memoryMb: positive("CATAMORPHIC_WORKSPACE_MEMORY_MB", 1024),
        }
      : {};
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
    backend === "local-process" &&
    [
      "CATAMORPHIC_CAPACITY_CPU_MILLIS",
      "CATAMORPHIC_CAPACITY_MEMORY_MB",
      "CATAMORPHIC_WORKSPACE_CPU_MILLIS",
      "CATAMORPHIC_WORKSPACE_MEMORY_MB",
    ].some((key) => env[key] !== undefined)
  )
    throw new Error(
      "CPU and memory limits require CATAMORPHIC_SANDBOX=microsandbox",
    );
  const provider =
    backend === "microsandbox"
      ? new MicrosandboxSandboxProvider({
          image: env.CATAMORPHIC_SANDBOX_IMAGE,
          cpus: (defaults.cpuMillis ?? 1000) / 1000,
          memoryMib: defaults.memoryMb,
        })
      : new LocalProcessSandboxProvider({
          root: path.join(args.data, "sandboxes"),
          env: {
            PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
          },
        });
  return {
    provider,
    capacity,
    defaults,
    isolation:
      backend === "microsandbox" ? ("sandbox" as const) : ("process" as const),
  };
}
