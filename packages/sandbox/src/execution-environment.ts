import type { SandboxProvider, SignInHarness } from "./types.js";

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
  /**
   * The longest one foreground command may run (ADR 0174): an agent's
   * shell command, a workflow step's sandbox command. Background processes
   * are bounded by their sandbox's lifetime instead.
   */
  commandTimeoutSeconds?: number;
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
  /** Host placement revision, checked again when capacity is reserved. */
  admissionRevision?: string;
  /**
   * What runs the machine's sandboxes and why it was chosen (ADR 0204),
   * for operators: `microsandbox`, `container` with its runtime (`runsc`,
   * `runc`), or `local-process`.
   */
  backend?: { kind: string; runtime?: string; reason?: string };
}

/** Internal realization. Provider objects never cross an API boundary. */
export interface EnvironmentRuntimeBinding {
  descriptor: EnvironmentBinding;
  /** Physical placement selected by the host, never a user-supplied endpoint. */
  workerNodeId?: string;
  workerLeaseToken?: string;
  sandboxProvider?: SandboxProvider;
  /**
   * The host placed the owner's work on a machine no one else's work
   * reaches (ADR 0167 access naming only that person, or for a project's
   * own work only that project), so it may hold the owner's personal
   * credentials (ADR 0184) and the Environment's secrets (ADR 0206).
   */
  servesOnlyOwner?: boolean;
  /**
   * The host lets this placement hold its owner's own harness sign-in (ADR
   * 0213): a machine of theirs alone, or a single person's server whose
   * operator accepted personal credentials on it. Never a machine several
   * people's sign-ins would share.
   */
  ownSignIns?: boolean;
}

/**
 * What a machine offers beside its sandbox provider's own capabilities
 * (ADR 0184), advertised in its binding descriptor like them.
 */
export const MACHINE_CAPABILITIES = {
  /**
   * The operator lets members' own sign-ins run on this machine although
   * it runs several people's work as processes (ADR 0199).
   */
  personalCredentials: "credentials.personal",
  /** The machine's sandboxes can mount members' own sign-ins (ADR 0199). */
  signIns: "sign-ins",
  /** The Claude Code CLI is on the machine's path. */
  claudeCode: "harness.claude-code",
  /** The Codex CLI is on the machine's path. */
  codex: "harness.codex",
  /**
   * The machine reports its disk (ADR 0336), so admission keeps its floor
   * and reserves an Environment's `storageMb` there.
   */
  disk: "disk",
} as const;

export type MachineCapability =
  (typeof MACHINE_CAPABILITIES)[keyof typeof MACHINE_CAPABILITIES];

/** The machine capability saying a harness's CLI is installed. */
export function harnessCapability(harness: SignInHarness): string {
  return harness === "codex"
    ? MACHINE_CAPABILITIES.codex
    : MACHINE_CAPABILITIES.claudeCode;
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
     * which only nodes open to anyone or to `projectId` take (ADR 0167,
     * 0173).
     */
    ownerUserId?: string;
    /**
     * The chat key of a project's own chat (ADR 0173), so a node that is
     * for one key of the project takes it (ADR 0349).
     */
    chatKey?: string;
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
    /**
     * A cache fill of this size (ADR 0334, 0336): placed only where it
     * fits above the machine's full disk floor, whatever the workload. Not
     * a requirement: a machine that reports no disk still takes it.
     */
    fill?: { storageMb: number };
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
 * Whose work a node takes (ADRs 0167, 0349): anyone's, or named users'
 * work, named projects' own work (project chats and automations, ADR
 * 0173), and single chats of a project by their chat key. Host state,
 * never declared by the node itself. All three lists empty: nobody's.
 */
export type NodeAccess =
  | { everyone: true }
  | {
      everyone?: false;
      users: readonly string[];
      /** Projects whose own work (project chats, automations) it takes. */
      projects: readonly string[];
      /** Single chats of a project it takes, by their chat key. */
      keys: readonly { project: string; key: string }[];
    };

/**
 * How narrowly a node serves a piece of work, narrowest first: 0 for a
 * node of this one chat key alone, 1 for a node of the owner's alone (one
 * user, or for a project's own work that one project), 2 for one shared
 * with other named users, projects or keys, 3 for a node open to anyone,
 * undefined when the node does not take the work. A member's work never
 * lands on a node opened only to projects or keys.
 */
export type AccessTier = 0 | 1 | 2 | 3;

export function accessTier(args: {
  access: NodeAccess;
  /** The work's owner; absent for a project's own work. */
  owner: { userId: string } | undefined;
  projectId?: string;
  /** The chat key of a project's own chat. */
  chatKey?: string;
}): AccessTier | undefined {
  const { access, owner } = args;
  if (access.everyone) return 3;
  const principals =
    access.users.length + access.projects.length + access.keys.length;
  if (owner) {
    if (!access.users.includes(owner.userId)) return undefined;
    return principals === 1 ? 1 : 2;
  }
  if (!args.projectId) return undefined;
  const keyed =
    args.chatKey !== undefined &&
    access.keys.some(
      (entry) => entry.project === args.projectId && entry.key === args.chatKey,
    );
  const project = access.projects.includes(args.projectId);
  if (!keyed && !project) return undefined;
  if (principals > 1) return 2;
  return keyed ? 0 : 1;
}

/**
 * The node takes no one else's work (ADRs 0184, 0206): it is for this
 * owner alone, or for this one chat key alone.
 */
export function servesOnlyThisOwner(tier: AccessTier | undefined): boolean {
  return tier === 0 || tier === 1;
}

/**
 * Candidates the owner may use, narrowest first. `strict` keeps only the
 * narrowest tier present, so a full dedicated machine never spills onto a
 * shared one.
 */
export function placementOrder<T>(
  candidates: readonly T[],
  tier: (candidate: T) => AccessTier | undefined,
  options?: { strict?: boolean },
): T[] {
  const ranked = candidates
    .map((candidate) => ({ candidate, tier: tier(candidate) }))
    .filter(
      (entry): entry is { candidate: T; tier: AccessTier } =>
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
      !binding.resourceLimits?.includes(key) &&
      // Storage is reserved where it cannot be enforced, on a machine that
      // reports its disk (ADR 0336).
      !(key === "storageMb" && binding.capabilities.includes("disk"))
    ) {
      reasons.push(
        key === "storageMb"
          ? "Binding can neither enforce nor reserve 'storageMb'"
          : `Binding cannot enforce '${key}'`,
      );
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
    requested: requirements.resources?.commandTimeoutSeconds,
    ceiling: binding.resources.commandTimeoutSeconds,
    label: "Command time requirement",
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
