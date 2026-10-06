import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ContainerRuntime,
  ContainerSandboxProvider,
  type ContainerSupport,
  DockerClient,
  dockerEndpoint,
  probeContainerSupport,
} from "@catamorphic/container";
import type { WorkerCapacity } from "@catamorphic/core";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  dockerImageBuilder,
  MicrosandboxSandboxProvider,
  type MicrosandboxSupport,
  microsandboxSupport,
} from "@catamorphic/microsandbox";
import {
  MACHINE_CAPABILITIES,
  type MachineCapability,
} from "@catamorphic/sandbox";
import { signInRoot } from "./workers/sign-ins.js";

/** A sandbox backend this machine can run (ADR 0203). */
export type WorkSandboxBackend = "microsandbox" | "container" | "local-process";

/** How this machine executes agent and workflow sandboxes, as configured. */
export interface WorkExecutionSettings {
  /**
   * The backend the operator chose, or `auto`: the best this machine
   * offers, found at start by {@link resolveExecutionSettings} (ADR 0203).
   */
  backend: WorkSandboxBackend | "auto";
  /**
   * The container backend's runtime: gVisor (`runsc`) or `runc`. Unset, it
   * is gVisor when the Docker daemon has it, else runc.
   */
  containerRuntime?: "runsc" | "runc";
  /** The Docker daemon for the container backend (`DOCKER_HOST`). */
  dockerHost?: string;
  /**
   * The operator accepts privileged sandbox containers under runc, which
   * nested Docker needs there (`WORK_CONTAINER_PRIVILEGED=1`). gVisor
   * needs no such thing. A privileged container can reach the machine, so
   * such a machine enforces no egress policy and counts as plain processes
   * for a shared control plane's agents.
   */
  privilegedContainers?: boolean;
  /**
   * Processes one container sandbox may run at once
   * (`WORK_SANDBOX_PIDS_LIMIT`, default 4096).
   */
  pidsLimit?: number;
  capacity: WorkerCapacity;
  /** Per-workspace defaults; isolated backends only. */
  defaults: { cpuMillis?: number; memoryMb?: number };
  /**
   * The operator set CPU or memory budgets. A machine whose `auto` falls
   * back to local-process, which cannot enforce them, refuses to start.
   */
  explicitResources?: boolean;
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
  /**
   * Environment images and containers (ADR 0176). `imageBuilder` builds
   * project Dockerfiles for microsandbox; `containers` turns nested Docker
   * off for microsandbox and the container backend; `dockerSocket` gives
   * trusted local-process sandboxes a filtering Docker endpoint in front
   * of this host daemon.
   */
  images?: { builder?: "docker" | "podman" };
  containers?: boolean;
  dockerSocket?: string;
  dockerCliPlugins?: string;
  /**
   * The operator runs Environments with restricted egress on local-process
   * although nothing enforces it (ADR 0176).
   */
  acceptUnenforcedEgress?: boolean;
  /**
   * The operator accepts members' personal credentials in this machine's
   * process sandboxes although it may run several people's work (ADR
   * 0184, `WORK_PERSONAL_CREDENTIALS=accept`).
   */
  acceptPersonalCredentials?: boolean;
  /**
   * Days a volume may go unused before the machine forgets it (ADR 0207,
   * `WORK_VOLUME_RETENTION_DAYS`, default 30).
   */
  volumeRetentionDays: number;
}

/** The settings once the backend is known: what a machine runs with. */
export interface ResolvedExecutionSettings
  extends Omit<WorkExecutionSettings, "backend" | "containerRuntime"> {
  backend: WorkSandboxBackend;
  /** The container backend's runtime, as the Docker daemon reported it. */
  containerRuntime?: ContainerRuntime;
  /** Why this backend: logged at start and shown with the machine. */
  reason: string;
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
  const backend = env.WORK_SANDBOX ?? "auto";
  if (
    backend !== "auto" &&
    backend !== "local-process" &&
    backend !== "microsandbox" &&
    backend !== "container"
  )
    throw new Error(
      "WORK_SANDBOX must be auto, microsandbox, container, or local-process",
    );
  const resourceVariables = [
    "WORK_CAPACITY_CPU_MILLIS",
    "WORK_CAPACITY_MEMORY_MB",
    "WORK_WORKSPACE_CPU_MILLIS",
    "WORK_WORKSPACE_MEMORY_MB",
  ];
  const explicitResources = resourceVariables.some(
    (key) => env[key] !== undefined,
  );
  if (backend === "local-process" && explicitResources)
    throw new Error(
      "CPU and memory limits require WORK_SANDBOX=microsandbox, container, or auto",
    );
  const isolated = backend !== "local-process";
  const capacity: WorkerCapacity = {
    workspaces: positive("WORK_MAX_WORKSPACES", 8),
    ...(isolated
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
  const defaults = isolated
    ? {
        cpuMillis: positive("WORK_WORKSPACE_CPU_MILLIS", 1000),
        memoryMb: positive("WORK_WORKSPACE_MEMORY_MB", 1024),
      }
    : {};
  const settings: WorkExecutionSettings = {
    backend,
    capacity,
    defaults,
    ...(explicitResources ? { explicitResources: true } : {}),
    ...(env.WORK_SANDBOX_IMAGE ? { sandboxImage: env.WORK_SANDBOX_IMAGE } : {}),
    path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    workloads: workloadsFromEnv(env.WORK_CONTROL_PLANE_WORKLOADS),
    trustControlPlaneAgents: env.WORK_TRUST_CONTROL_PLANE_AGENTS === "1",
    volumeRetentionDays: positive("WORK_VOLUME_RETENTION_DAYS", 30),
    ...(env.WORK_SANDBOX_PIDS_LIMIT !== undefined
      ? { pidsLimit: positive("WORK_SANDBOX_PIDS_LIMIT", 4096) }
      : {}),
    ...containerSettings({ backend, env }),
    ...imageAndContainerSettings({ backend, env }),
  };
  validateExecutionSettings(settings);
  return settings;
}

function containerSettings(args: {
  backend: WorkExecutionSettings["backend"];
  env: Record<string, string | undefined>;
}): Pick<
  WorkExecutionSettings,
  "containerRuntime" | "dockerHost" | "privilegedContainers"
> {
  const { backend, env } = args;
  const runtime = env.WORK_CONTAINER_RUNTIME;
  if (runtime !== undefined && runtime !== "runsc" && runtime !== "runc")
    throw new Error("WORK_CONTAINER_RUNTIME must be runsc or runc");
  const privileged = env.WORK_CONTAINER_PRIVILEGED;
  if (privileged !== undefined && privileged !== "0" && privileged !== "1")
    throw new Error("WORK_CONTAINER_PRIVILEGED must be 0 or 1");
  if (
    (runtime || privileged === "1" || env.WORK_SANDBOX_PIDS_LIMIT) &&
    backend !== "container" &&
    backend !== "auto"
  )
    throw new Error(
      "WORK_CONTAINER_RUNTIME, WORK_CONTAINER_PRIVILEGED and WORK_SANDBOX_PIDS_LIMIT apply to WORK_SANDBOX=container or auto",
    );
  if (env.DOCKER_HOST) dockerEndpoint(env.DOCKER_HOST);
  return {
    ...(runtime ? { containerRuntime: runtime } : {}),
    ...(env.DOCKER_HOST ? { dockerHost: env.DOCKER_HOST } : {}),
    ...(privileged === "1" ? { privilegedContainers: true } : {}),
  };
}

function imageAndContainerSettings(args: {
  backend: WorkExecutionSettings["backend"];
  env: Record<string, string | undefined>;
}): Pick<
  WorkExecutionSettings,
  | "images"
  | "containers"
  | "dockerSocket"
  | "dockerCliPlugins"
  | "acceptUnenforcedEgress"
  | "acceptPersonalCredentials"
> {
  const { backend, env } = args;
  const builder = env.WORK_IMAGE_BUILDER;
  if (builder !== undefined && builder !== "docker" && builder !== "podman")
    throw new Error("WORK_IMAGE_BUILDER must be docker or podman");
  if (builder && backend !== "microsandbox" && backend !== "auto")
    throw new Error(
      backend === "container"
        ? "WORK_IMAGE_BUILDER is for microsandbox: the container backend builds images with its own Docker daemon"
        : "WORK_IMAGE_BUILDER requires WORK_SANDBOX=microsandbox",
    );
  const containers = env.WORK_SANDBOX_CONTAINERS;
  if (containers !== undefined && containers !== "0" && containers !== "1")
    throw new Error("WORK_SANDBOX_CONTAINERS must be 0 or 1");
  if (env.WORK_DOCKER_SOCKET && backend === "microsandbox")
    throw new Error(
      "WORK_DOCKER_SOCKET is for local-process; microsandbox runs Docker inside each VM",
    );
  if (env.WORK_DOCKER_SOCKET && backend === "container")
    throw new Error(
      "WORK_DOCKER_SOCKET is for local-process; the container backend runs Docker inside each sandbox (set DOCKER_HOST to name its daemon)",
    );
  const egress = env.WORK_UNENFORCED_EGRESS;
  if (egress !== undefined && egress !== "accept")
    throw new Error("WORK_UNENFORCED_EGRESS must be accept");
  if (egress && backend !== "local-process" && backend !== "auto")
    throw new Error("WORK_UNENFORCED_EGRESS applies to local-process only");
  const personal = env.WORK_PERSONAL_CREDENTIALS;
  if (personal !== undefined && personal !== "accept")
    throw new Error("WORK_PERSONAL_CREDENTIALS must be accept");
  if (personal && backend === "microsandbox")
    throw new Error(
      "WORK_PERSONAL_CREDENTIALS applies to process isolation only: microsandbox gives each chat its own VM",
    );
  return {
    ...(builder ? { images: { builder } } : {}),
    ...(backend === "local-process"
      ? { containers: Boolean(env.WORK_DOCKER_SOCKET) }
      : { containers: containers !== "0" }),
    ...(env.WORK_DOCKER_SOCKET ? { dockerSocket: env.WORK_DOCKER_SOCKET } : {}),
    ...(env.WORK_DOCKER_CLI_PLUGINS
      ? { dockerCliPlugins: env.WORK_DOCKER_CLI_PLUGINS }
      : {}),
    ...(egress ? { acceptUnenforcedEgress: true } : {}),
    ...(personal ? { acceptPersonalCredentials: true } : {}),
  };
}

/** What `auto` and explicit backends check on this machine. Tests inject them. */
export interface ExecutionProbes {
  microsandbox(): MicrosandboxSupport;
  container(dockerHost: string | undefined): Promise<ContainerSupport>;
}

const machineProbes: ExecutionProbes = {
  microsandbox: () => microsandboxSupport(),
  container: async (dockerHost) => {
    try {
      return await probeContainerSupport(
        new DockerClient(dockerEndpoint(dockerHost)),
        // A daemon starting beside this machine's worker (a reboot) gets
        // a minute before the machine settles for a lesser backend.
        { waitMs: 60_000 },
      );
    } catch (error) {
      return {
        ok: false,
        reason: `The Docker daemon did not answer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * Choose this machine's backend (ADR 0203). `auto` takes microsandbox
 * where it can run (an Apple silicon Mac, or Linux with a usable
 * `/dev/kvm`), else the container backend under gVisor where the Docker
 * daemon has a `runsc` runtime, else under runc where a daemon answers,
 * else local-process. A backend named explicitly that cannot run refuses
 * with what is missing.
 */
export async function resolveExecutionSettings(args: {
  settings: WorkExecutionSettings;
  probes?: Partial<ExecutionProbes>;
}): Promise<ResolvedExecutionSettings> {
  const { settings } = args;
  const probes = { ...machineProbes, ...args.probes };
  const container = async (
    reasonPrefix: string,
  ): Promise<ResolvedExecutionSettings | { failed: string }> => {
    const support = await probes.container(settings.dockerHost);
    if (!support.ok) return { failed: support.reason };
    if (settings.containerRuntime === "runsc" && !support.runsc)
      throw new Error(
        "The Docker daemon has no runsc (gVisor) runtime. Install gVisor and register it as runsc, or set WORK_CONTAINER_RUNTIME=runc.",
      );
    if (support.runsc && settings.containerRuntime !== "runc")
      return finish({
        settings,
        backend: "container",
        containerRuntime: support.runsc,
        reason: `${reasonPrefix}containers run under gVisor (runsc)${
          support.runsc.hostSockets
            ? ""
            : "; its runtime lacks --host-uds=open, so egress policies are not offered"
        }${
          support.runsc.netRaw
            ? ""
            : "; its runtime lacks --net-raw, so nested containers are not offered"
        }`,
      });
    return finish({
      settings,
      backend: "container",
      containerRuntime: { kind: "runc", ...support.runc },
      reason: `${reasonPrefix}${
        settings.containerRuntime === "runc"
          ? "containers run under runc, as WORK_CONTAINER_RUNTIME asks"
          : "the Docker daemon has no runsc runtime, so containers run under runc (process isolation)"
      }`,
    });
  };
  switch (settings.backend) {
    case "local-process":
      return finish({
        settings,
        backend: "local-process",
        reason: "WORK_SANDBOX=local-process",
      });
    case "microsandbox": {
      const support = probes.microsandbox();
      if (!support.ok) throw new Error(support.reason);
      return finish({
        settings,
        backend: "microsandbox",
        reason: "WORK_SANDBOX=microsandbox",
      });
    }
    case "container": {
      const chosen = await container("WORK_SANDBOX=container: ");
      if ("failed" in chosen)
        throw new Error(
          `${chosen.failed}, so the container backend cannot run here. Start Docker or set DOCKER_HOST, or use WORK_SANDBOX=auto.`,
        );
      return chosen;
    }
    case "auto": {
      const micro = probes.microsandbox();
      if (micro.ok)
        return finish({
          settings,
          backend: "microsandbox",
          reason: "auto: microsandbox can run on this machine",
        });
      const why = firstSentence(micro.reason);
      const chosen = await container(`auto: ${why}; `);
      if (!("failed" in chosen)) return chosen;
      return finish({
        settings,
        backend: "local-process",
        reason: `auto: ${why}; ${firstSentence(chosen.failed)}; sandboxes run as plain processes`,
      });
    }
  }
}

/** A reason's first sentence: auto states why, not the advice after it. */
function firstSentence(text: string): string {
  return text.split(/\.(?:\s|$)/)[0] ?? text;
}

/** Settle budgets and validation for the backend that was chosen. */
function finish(args: {
  settings: WorkExecutionSettings;
  backend: WorkSandboxBackend;
  containerRuntime?: ContainerRuntime;
  reason: string;
}): ResolvedExecutionSettings {
  const { containerRuntime: _requested, ...settings } = args.settings;
  if (args.backend === "local-process" && settings.explicitResources)
    throw new Error(
      `CPU and memory limits need an isolated sandbox backend, and none can run here (${args.reason})`,
    );
  const resolved: ResolvedExecutionSettings = {
    ...settings,
    backend: args.backend,
    ...(args.containerRuntime
      ? { containerRuntime: args.containerRuntime }
      : {}),
    reason: args.reason,
    ...(args.backend === "local-process"
      ? {
          capacity: { workspaces: settings.capacity.workspaces },
          defaults: {},
          containers: Boolean(settings.dockerSocket),
        }
      : {}),
  };
  validateExecutionSettings(resolved);
  return resolved;
}

/** Whether an executable of this name is on a search path. */
function onPath(command: string, searchPath: string): boolean {
  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        fs.accessSync(path.join(directory, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * What this machine offers beside its sandbox provider (ADR 0184): the
 * operator's acceptance of personal credentials where sandboxes are
 * process-isolated (local-process, containers under runc), and the harness
 * CLIs a local-process sandbox finds on its path. A VM or a container
 * gets its CLIs from the Environment's image instead.
 */
export function machineCapabilities(
  settings: Pick<
    ResolvedExecutionSettings,
    "backend" | "containerRuntime" | "path" | "acceptPersonalCredentials"
  >,
): MachineCapability[] {
  const processIsolated =
    settings.backend === "local-process" ||
    (settings.backend === "container" &&
      settings.containerRuntime?.kind === "runc");
  if (!processIsolated) return [];
  return [
    ...(settings.acceptPersonalCredentials
      ? [MACHINE_CAPABILITIES.personalCredentials]
      : []),
    ...(settings.backend === "local-process" && onPath("claude", settings.path)
      ? [MACHINE_CAPABILITIES.claudeCode]
      : []),
    ...(settings.backend === "local-process" && onPath("codex", settings.path)
      ? [MACHINE_CAPABILITIES.codex]
      : []),
  ];
}

/**
 * Whether agent code on this machine could reach the machine itself, and
 * so a shared control plane's secrets (ADR 0164): plain processes, and
 * containers under runc that may be privileged. Such a control plane runs
 * agents only when its operator trusts them (`WORK_TRUST_CONTROL_PLANE_AGENTS`).
 */
export function agentsReachMachine(
  settings: Pick<
    ResolvedExecutionSettings,
    "backend" | "containerRuntime" | "privilegedContainers"
  >,
): boolean {
  return (
    settings.backend === "local-process" ||
    (settings.backend === "container" &&
      settings.containerRuntime?.kind === "runc" &&
      Boolean(settings.privilegedContainers))
  );
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

function validateExecutionSettings(
  settings: WorkExecutionSettings | ResolvedExecutionSettings,
): void {
  const { capacity, defaults } = settings;
  if (
    settings.backend === "microsandbox" &&
    defaults.cpuMillis &&
    defaults.cpuMillis % 1000 !== 0
  )
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
    throw new Error(
      "CPU and memory limits require the microsandbox or container backend",
    );
}

/** Work server choices only. Embedders construct providers and budgets themselves. */
export function workExecution(args: {
  settings: ResolvedExecutionSettings;
  dataDir: string;
  log?: (line: string) => void;
}) {
  const { settings } = args;
  validateExecutionSettings(settings);
  // Members' own sign-ins, made on this machine (ADR 0199).
  const signIns = signInRoot(args.dataDir);
  const runtime = settings.containerRuntime;
  const provider =
    settings.backend === "microsandbox"
      ? new MicrosandboxSandboxProvider({
          image: settings.sandboxImage,
          cpus: (settings.defaults.cpuMillis ?? 1000) / 1000,
          memoryMib: settings.defaults.memoryMb,
          containers: settings.containers ?? true,
          signInRoot: signIns,
          stateDirectory: path.join(args.dataDir, "microsandbox"),
          ...(settings.images?.builder
            ? {
                imageBuilder: dockerImageBuilder({
                  command: settings.images.builder,
                }),
              }
            : {}),
        })
      : settings.backend === "container"
        ? new ContainerSandboxProvider({
            docker: new DockerClient(dockerEndpoint(settings.dockerHost)),
            runtime: runtime ?? { kind: "runc" },
            stateDirectory: path.join(args.dataDir, "container"),
            ...(settings.sandboxImage ? { image: settings.sandboxImage } : {}),
            ...(settings.pidsLimit ? { pidsLimit: settings.pidsLimit } : {}),
            ...(settings.defaults.cpuMillis
              ? { cpuMillis: settings.defaults.cpuMillis }
              : {}),
            ...(settings.defaults.memoryMb
              ? { memoryMb: settings.defaults.memoryMb }
              : {}),
            containers: settings.containers ?? true,
            ...(settings.privilegedContainers
              ? { privilegedContainers: true }
              : {}),
            signInRoot: signIns,
            ...(args.log ? { log: args.log } : {}),
          })
        : new LocalProcessSandboxProvider({
            root: path.join(args.dataDir, "sandboxes"),
            env: { PATH: settings.path, LANG: "C.UTF-8" },
            signInRoot: signIns,
            ...(settings.dockerSocket
              ? {
                  docker: {
                    socketPath: settings.dockerSocket,
                    ...(settings.dockerCliPlugins
                      ? { cliPlugins: settings.dockerCliPlugins }
                      : {}),
                  },
                }
              : {}),
            ...(settings.acceptUnenforcedEgress
              ? { acceptUnenforcedEgress: true }
              : {}),
          });
  return {
    provider,
    capacity: settings.capacity,
    defaults: settings.defaults,
    isolation:
      settings.backend === "microsandbox" ||
      (settings.backend === "container" && runtime?.kind === "runsc")
        ? ("sandbox" as const)
        : ("process" as const),
    machineCapabilities: machineCapabilities(settings),
    signInRoot: signIns,
    /** What runs this machine's sandboxes and why, for operators (ADR 0203). */
    backend: {
      kind: settings.backend,
      ...(runtime ? { runtime: runtime.kind } : {}),
      reason: settings.reason,
    },
    volumeRetentionMs: settings.volumeRetentionDays * 24 * 60 * 60 * 1000,
  };
}
