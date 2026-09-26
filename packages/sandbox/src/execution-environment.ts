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
  resourceLimits?: readonly ("cpuMillis" | "memoryMb" | "storageMb" | "gpu")[];
  /** Host-assigned labels an Environment's `pool` selects on (ADR 0167). */
  labels?: Readonly<Record<string, string>>;
}

/** Internal realization. Provider objects never cross an API boundary. */
export interface EnvironmentRuntimeBinding {
  descriptor: EnvironmentBinding;
  /** Physical placement selected by the host, never a user-supplied endpoint. */
  workerNodeId?: string;
  workerLeaseToken?: string;
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
    projectId?: string;
    /**
     * Whose work this is: the session owner. Absent for project-owned work,
     * which only nodes open to everyone take (ADR 0167).
     */
    ownerUserId?: string;
    clientRunnerId?: string;
    /** Resolve an existing Allocation's binding again, by its id. */
    allocationBindingId?: string;
    /** Node labels the Environment selects; every key must match. */
    pool: Readonly<Record<string, string>>;
    /** Never fall back past the narrowest nodes open to the owner. */
    strict?: boolean;
    requirements?: EnvironmentRequirements;
    /** Preserve an existing Allocation's physical owner when resolving a pool. */
    workerNodeId?: string;
  }):
    | Promise<EnvironmentRuntimeBinding | undefined>
    | EnvironmentRuntimeBinding
    | undefined;
}

/** Whether a binding's labels satisfy an Environment's pool selector. */
export function poolMatches(
  labels: Readonly<Record<string, string>> | undefined,
  pool: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(pool).every(([key, value]) => labels?.[key] === value);
}

/**
 * Whose work a node takes (ADR 0167): everyone, or named people and
 * groups. Host state, never declared by the node itself.
 */
export type NodeAccess =
  | { everyone: true }
  | { everyone?: false; users: readonly string[]; groups: readonly string[] };

/**
 * How narrowly a node serves an owner: 0 for a node of theirs alone, 1 for
 * one they share with named people or groups, 2 for a node open to
 * everyone, undefined when the node does not take their work.
 */
export function accessTier(
  access: NodeAccess,
  owner: { userId: string; groups: readonly string[] } | undefined,
): 0 | 1 | 2 | undefined {
  if (access.everyone) return 2;
  if (!owner) return undefined;
  const named = access.users.includes(owner.userId);
  if (named && access.users.length === 1 && access.groups.length === 0)
    return 0;
  if (named || access.groups.some((group) => owner.groups.includes(group)))
    return 1;
  return undefined;
}

/**
 * Candidates the owner may use, narrowest first. `strict` keeps only the
 * narrowest tier present, so a full dedicated machine never spills onto a
 * shared one.
 */
export function placementOrder<T>(
  candidates: readonly T[],
  tier: (candidate: T) => 0 | 1 | 2 | undefined,
  options?: { strict?: boolean },
): T[] {
  const ranked = candidates
    .map((candidate) => ({ candidate, tier: tier(candidate) }))
    .filter(
      (entry): entry is { candidate: T; tier: 0 | 1 | 2 } =>
        entry.tier !== undefined,
    )
    .sort((left, right) => left.tier - right.tier);
  const narrowest = ranked[0]?.tier;
  return ranked
    .filter((entry) => !options?.strict || entry.tier === narrowest)
    .map((entry) => entry.candidate);
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
  if (
    requirements.topology === "native" &&
    ["cpuMillis", "memoryMb", "storageMb", "gpu"].some((key) =>
      Object.entries(requirements.resources ?? {}).some(
        ([name, value]) => name === key && Boolean(value),
      ),
    )
  ) {
    reasons.push(
      "Native agent execution does not enforce sandbox resource limits; choose a controller agent",
    );
  }
  for (const key of ["cpuMillis", "memoryMb", "storageMb", "gpu"] as const) {
    if (
      requirements.resources?.[key] &&
      !binding.resourceLimits?.includes(key)
    ) {
      reasons.push(`Binding cannot enforce '${key}'`);
    }
  }
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
