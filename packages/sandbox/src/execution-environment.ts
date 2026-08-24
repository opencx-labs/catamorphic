import type { SandboxProvider } from "./types.js";

export type WorkloadKind = "agent" | "workflow";
export type EnvironmentTrust = "local" | "managed";
export type EnvironmentIsolation = "none" | "process" | "sandbox";
export type AgentExecutionTopology =
  | "controller"
  | "contained"
  | "native"
  | "external";

export interface EnvironmentResourcePolicy {
  cpuMillis?: number;
  memoryMb?: number;
  storageMb?: number;
  gpu?: boolean;
  timeoutSeconds?: number;
  maxConcurrency?: number;
}

/** Public, non-secret description of one host-owned Environment binding. */
export interface EnvironmentBinding {
  id: string;
  label: string;
  description?: string;
  trust: EnvironmentTrust;
  isolation: EnvironmentIsolation;
  workloads: readonly WorkloadKind[];
  agentTopologies: readonly AgentExecutionTopology[];
  capabilities: readonly string[];
  resources: EnvironmentResourcePolicy;
}

/** Internal realization. Provider objects never cross an API boundary. */
export interface EnvironmentRuntimeBinding {
  descriptor: EnvironmentBinding;
  sandboxProvider?: SandboxProvider;
}

export interface EnvironmentRequirements {
  workload: WorkloadKind;
  topology?: AgentExecutionTopology;
  trust?: EnvironmentTrust;
  isolation?: EnvironmentIsolation;
  capabilities?: readonly string[];
  resources?: EnvironmentResourcePolicy;
}

export interface EnvironmentProvider {
  get(args: {
    tenantId: string;
    bindingId: string;
  }):
    | Promise<EnvironmentRuntimeBinding | undefined>
    | EnvironmentRuntimeBinding
    | undefined;
}

export type EnvironmentCompatibility =
  | { compatible: true }
  | { compatible: false; reasons: string[] };

const trustRank: Record<EnvironmentTrust, number> = {
  local: 0,
  managed: 1,
};

const isolationRank: Record<EnvironmentIsolation, number> = {
  none: 0,
  process: 1,
  sandbox: 2,
};

export function environmentSatisfies(
  binding: EnvironmentBinding,
  requirements: EnvironmentRequirements,
): EnvironmentCompatibility {
  const reasons: string[] = [];
  if (!binding.workloads.includes(requirements.workload)) {
    reasons.push(`Workload '${requirements.workload}' is not supported`);
  }
  if (
    requirements.topology &&
    !binding.agentTopologies.includes(requirements.topology)
  ) {
    reasons.push(`Agent topology '${requirements.topology}' is not supported`);
  }
  if (
    requirements.trust &&
    trustRank[binding.trust] < trustRank[requirements.trust]
  ) {
    reasons.push(`Trust level '${requirements.trust}' is required`);
  }
  if (
    requirements.isolation &&
    isolationRank[binding.isolation] < isolationRank[requirements.isolation]
  ) {
    reasons.push(`Isolation level '${requirements.isolation}' is required`);
  }
  for (const capability of requirements.capabilities ?? []) {
    if (!binding.capabilities.includes(capability)) {
      reasons.push(`Capability '${capability}' is not available`);
    }
  }
  compareResource({
    requested: requirements.resources?.cpuMillis,
    ceiling: binding.resources.cpuMillis,
    label: "CPU requirement",
    unit: " millicores",
    reasons,
  });
  compareResource({
    requested: requirements.resources?.memoryMb,
    ceiling: binding.resources.memoryMb,
    label: "Memory requirement",
    unit: " MB",
    reasons,
  });
  compareResource({
    requested: requirements.resources?.storageMb,
    ceiling: binding.resources.storageMb,
    label: "Storage requirement",
    unit: " MB",
    reasons,
  });
  compareResource({
    requested: requirements.resources?.timeoutSeconds,
    ceiling: binding.resources.timeoutSeconds,
    label: "Timeout requirement",
    unit: " seconds",
    reasons,
  });
  compareResource({
    requested: requirements.resources?.maxConcurrency,
    ceiling: binding.resources.maxConcurrency,
    label: "Concurrency requirement",
    unit: "",
    reasons,
  });
  if (requirements.resources?.gpu && !binding.resources.gpu) {
    reasons.push("A GPU is required but unavailable");
  }
  return reasons.length === 0
    ? { compatible: true }
    : { compatible: false, reasons };
}

function compareResource(args: {
  requested: number | undefined;
  ceiling: number | undefined;
  label: string;
  unit: string;
  reasons: string[];
}): void {
  if (
    args.requested !== undefined &&
    args.ceiling !== undefined &&
    args.requested > args.ceiling
  ) {
    args.reasons.push(
      `${args.label} ${args.requested}${args.unit} exceeds the ${args.ceiling}${args.unit} ceiling`,
    );
  }
}
