import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  EnvironmentBinding,
  EnvironmentIsolation,
  EnvironmentProvider,
  EnvironmentRequirements,
  EnvironmentResourcePolicy,
  EnvironmentRuntimeBinding,
  EnvironmentTrust,
  PersonalLoginKind,
  SandboxCapability,
} from "@catamorphic/sandbox";
import {
  dockerfileDigest,
  environmentSatisfies,
  harnessCapability,
  MACHINE_CAPABILITIES,
  resolveEgress,
  SANDBOX_CAPABILITIES,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import type { Identity } from "../identity.js";
import {
  hasProjectPermission,
  identityMayUseEnvironment,
  isProjectPrincipal,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import type {
  EnvironmentAllocationPolicy,
  EnvironmentSandbox,
} from "./execution-allocations-service.js";
import {
  DEFAULT_IDLE_RELEASE_MINUTES,
  type ProjectEnvironmentDefinition,
  type ProjectEnvironmentsService,
} from "./project-environments-service.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";

const tracer = getTracer("@catamorphic/core");

/**
 * Why admission chose an Environment (ADR 0173): the caller named it, the
 * agent prefers it, it is the project default, or it was the first that fit.
 */
export type PlacementReason =
  | "requested"
  | "agent_preferred"
  | "project_default"
  | "available";

export interface EnvironmentAdmission {
  environmentName: string;
  reason: PlacementReason;
  runtime: EnvironmentRuntimeBinding;
  binding: EnvironmentBinding;
  effectiveRequirements: EnvironmentRequirements;
  /** What the sandbox is given: image, containers, egress (ADR 0176). */
  sandbox: EnvironmentSandbox;
  /** How long unattended escalations wait for a person (ADR 0176). */
  approvals?: { waitMinutes: number };
  /**
   * This placement may hold the owner's personal credentials (ADR 0184):
   * the Environment allows them, the work is a member's own, and the
   * machine isolates it.
   */
  personalCredentials: boolean;
}

/**
 * Whether one placement may hold a member's personal credentials (ADR
 * 0184), and if not, what is missing and how to fix it. The Environment
 * must allow them, the work must be a member's own (never a project
 * chat's), and the placement must isolate that member: a sandbox VM, the
 * member's own device, a machine only they use, or a machine whose
 * operator accepted personal credentials on shared processes.
 */
export function personalCredentialsDecision(input: {
  environment: string;
  definition: Pick<
    ProjectEnvironmentDefinition,
    "personalCredentials" | "device"
  >;
  owner: string | null;
  runtime: Pick<EnvironmentRuntimeBinding, "descriptor" | "servesOnlyOwner">;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!input.definition.personalCredentials)
    return {
      allowed: false,
      reason: `Environment '${input.environment}' does not allow personal credentials. Add "personalCredentials": true to it in ${PROJECT_MANIFEST_PATH}`,
    };
  if (!input.owner)
    return {
      allowed: false,
      reason:
        "Personal credentials reach only a member's own chats, and this is the project's own work. Use an agent with a model connection instead",
    };
  const { descriptor } = input.runtime;
  if (
    input.definition.device === "member" ||
    descriptor.isolation === "sandbox" ||
    input.runtime.servesOnlyOwner === true ||
    descriptor.capabilities.includes(MACHINE_CAPABILITIES.personalCredentials)
  )
    return { allowed: true };
  return {
    allowed: false,
    reason: `The machine for Environment '${input.environment}' runs other people's work as plain processes, so it may not hold your credentials. Use microsandbox, a machine only you use, or set WORK_PERSONAL_CREDENTIALS=accept on that machine`,
  };
}

const HARNESS_NAMES: Record<PersonalLoginKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * The policy an Allocation keeps from its admission: binding, requirements,
 * connections, the sandbox's image, containers and egress, and the approval
 * wait (ADR 0176). Every admission path builds it here, so a workload admitted
 * again (readmission after idle release, reallocation, a mirrored session)
 * keeps what its Environment gives it.
 */
export function admissionPolicy(input: {
  admission: EnvironmentAdmission;
  connections: readonly ResolvedConnectionBinding[];
  workflowEnablementId?: string;
}): EnvironmentAllocationPolicy {
  const { admission } = input;
  return {
    binding: admission.binding,
    requirements: admission.effectiveRequirements,
    connections: input.connections,
    sandbox: admission.sandbox,
    ...(admission.approvals ? { approvals: admission.approvals } : {}),
    ...(input.workflowEnablementId
      ? { workflowEnablementId: input.workflowEnablementId }
      : {}),
  };
}

/** The largest Dockerfile an Environment may name. */
const MAX_DOCKERFILE_BYTES = 64 * 1024;

/**
 * Machine capabilities an Environment's sandbox needs (ADR 0176), so
 * placement only picks machines that provide them.
 */
export function sandboxCapabilitiesFor(
  definition: ProjectEnvironmentDefinition,
): SandboxCapability[] {
  return [
    ...(definition.image ? [SANDBOX_CAPABILITIES.images] : []),
    ...(definition.image?.kind === "dockerfile"
      ? [SANDBOX_CAPABILITIES.imageBuild]
      : []),
    ...(definition.requirements?.containers
      ? [SANDBOX_CAPABILITIES.containers]
      : []),
    ...(definition.network && definition.network.egress !== "open"
      ? [SANDBOX_CAPABILITIES.egressPolicy]
      : []),
  ];
}

export interface EnvironmentDiscoveryItem {
  name: string;
  label: string;
  description?: string;
  available: boolean;
  clientRequired?: boolean;
  /** False when no machine for it is online and open to this work. */
  machineOnline: boolean;
  compatible: boolean;
  preferred: boolean;
  allowed: boolean;
  /**
   * Present when the Environment allows personal credentials (ADR 0184):
   * whether this caller's own chats placed there would carry them.
   */
  personalCredentials?: boolean;
  reasons: readonly string[];
  binding?: Pick<
    EnvironmentBinding,
    "trust" | "isolation" | "capabilities" | "resources"
  >;
}

export interface EnvironmentDiscovery {
  items: readonly EnvironmentDiscoveryItem[];
  defaultEnvironment?: string;
}

/**
 * The project's committed Environment policy (`.work/project.json`) is
 * invalid: the project must fix it before work can be placed.
 */
export class InvalidEnvironmentPolicyError extends Error {
  constructor(reason: string) {
    super(`Invalid ${PROJECT_MANIFEST_PATH}: ${reason}`);
    this.name = "InvalidEnvironmentPolicyError";
  }
}

export class EnvironmentNotFoundError extends Error {
  constructor(readonly environment: string) {
    super(`Environment '${environment}' is not declared by this project`);
    this.name = "EnvironmentNotFoundError";
  }
}

export class EnvironmentAccessDeniedError extends Error {
  constructor(readonly environment: string) {
    super(`This identity may not use Environment '${environment}'`);
    this.name = "EnvironmentAccessDeniedError";
  }
}

export class EnvironmentBindingUnavailableError extends Error {
  constructor(readonly environment: string) {
    super(
      `No machine for Environment '${environment}' is online and open to this work`,
    );
    this.name = "EnvironmentBindingUnavailableError";
  }
}

export class EnvironmentIncompatibleError extends Error {
  constructor(
    readonly environment: string,
    readonly reasons: readonly string[],
  ) {
    super(
      `Environment '${environment}' is incompatible: ${reasons.join("; ")}`,
    );
    this.name = "EnvironmentIncompatibleError";
  }
}

export class NoCompatibleEnvironmentError extends Error {
  constructor(readonly reasons: Readonly<Record<string, readonly string[]>>) {
    const detail = Object.entries(reasons)
      .map(([name, why]) => `${name}: ${why.join("; ")}`)
      .join(". ");
    super(
      `No accessible project Environment satisfies this workload${
        detail ? ` (${detail})` : ""
      }`,
    );
    this.name = "NoCompatibleEnvironmentError";
  }
}

/** A session's or caller's user, or null for the project's own work. */
export function placementOwner(externalUserId: string): string | null {
  return isProjectPrincipal(externalUserId) ? null : externalUserId;
}

/**
 * Whose work is being placed (ADR 0167). Omitted, the caller's; `null`, the
 * project's own work, which only nodes open to everyone take.
 */
export type PlacementOwner = string | null | undefined;

export class ExecutionEnvironmentsService {
  constructor(
    private readonly projects: ProjectEnvironmentsService,
    private readonly provider: EnvironmentProvider,
    /** A member's own connected computer, for `device: "member"` (ADR 0098). */
    private readonly memberDevices?: EnvironmentProvider,
    private readonly options: {
      /**
       * Hosts a sandbox reaches the control plane at (its public URL's
       * host). Restricted egress always allows them (ADR 0176).
       */
      gatewayHosts?: readonly string[];
    } = {},
  ) {}

  /** Resolve the host-only runtime realization recorded by an Allocation. */
  getRuntimeBinding(args: {
    identity: Identity;
    bindingId: string;
    workerNodeId?: string;
    /**
     * Whose work the Allocation holds: a machine open only to that person
     * resolves only for their work (ADR 0167).
     */
    owner?: string | null;
  }):
    | Promise<EnvironmentRuntimeBinding | undefined>
    | EnvironmentRuntimeBinding
    | undefined {
    return this.provider.get({
      tenantId: args.identity.tenantId,
      pool: {},
      allocationBindingId: args.bindingId,
      ...(args.workerNodeId ? { workerNodeId: args.workerNodeId } : {}),
      ...(args.owner ? { ownerUserId: args.owner } : {}),
    });
  }

  async discover(args: {
    identity: Identity;
    projectId: string;
    owner?: PlacementOwner;
    requirements: EnvironmentRequirements;
    allowed?: readonly string[];
    preferred?: readonly string[];
    /** The agent runs with the owner's own harness login (ADR 0184). */
    personalLogin?: PersonalLoginKind;
  }): Promise<EnvironmentDiscovery> {
    return withSpan(
      {
        tracer,
        name: "environment.discover",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId,
        },
      },
      async () => {
        if (!mayUseProject(args.identity, args.projectId)) {
          throw new AccessDeniedError();
        }
        const policy = await this.projects.list(args);
        if (policy.invalid)
          throw new InvalidEnvironmentPolicyError(policy.invalid.error);
        const includeDenied = hasProjectPermission(
          args.identity,
          args.projectId,
          "program:read",
        );
        const items: EnvironmentDiscoveryItem[] = [];
        for (const name of Object.keys(policy.environments).sort()) {
          const granted = identityMayUseEnvironment(
            args.identity,
            args.projectId,
            name,
          );
          const agentAllowed = !args.allowed || args.allowed.includes(name);
          const allowed = granted && agentAllowed;
          if (!allowed && !includeDenied) continue;
          const definition = policy.environments[name];
          if (!definition) continue;
          const evaluated = await this.evaluate({ ...args, name }).catch(
            (error) => {
              if (error instanceof EnvironmentCapacityError)
                return {
                  bindingUnavailable: false as const,
                  reasons: [error.message],
                };
              throw error;
            },
          );
          const admission =
            "admission" in evaluated ? evaluated.admission : undefined;
          const compatibilityReasons =
            "admission" in evaluated
              ? []
              : evaluated.bindingUnavailable
                ? ["No machine for it is online and open to this work"]
                : evaluated.reasons;
          const reasons = allowed
            ? compatibilityReasons
            : [
                ...(granted
                  ? []
                  : ["Identity is not granted this Environment"]),
                ...(agentAllowed
                  ? []
                  : ["Agent policy does not allow this Environment"]),
              ];
          items.push({
            name,
            label:
              definition.device === "member" ||
              admission?.binding.trust === "local"
                ? "This machine"
                : name,
            clientRequired: definition.device === "member",
            ...(definition.description
              ? { description: definition.description }
              : {}),
            available: Boolean(admission),
            machineOnline: !(
              "bindingUnavailable" in evaluated && evaluated.bindingUnavailable
            ),
            compatible: Boolean(admission) && allowed,
            preferred: args.preferred?.includes(name) ?? false,
            allowed,
            ...(definition.personalCredentials
              ? { personalCredentials: admission?.personalCredentials ?? false }
              : {}),
            reasons,
            ...(admission
              ? {
                  binding: {
                    trust: admission.binding.trust,
                    isolation: admission.binding.isolation,
                    capabilities: admission.binding.capabilities,
                    resources: admission.binding.resources,
                  },
                }
              : {}),
          });
        }
        const defaultEnvironment = [
          ...(args.preferred ?? []),
          policy.defaultEnvironment,
          ...items.map((item) => item.name),
        ].find((name) =>
          items.some(
            (item) =>
              item.name === name &&
              item.allowed &&
              item.compatible &&
              item.available,
          ),
        );
        return { items, ...(defaultEnvironment ? { defaultEnvironment } : {}) };
      },
    );
  }

  async listCompatible(args: {
    identity: Identity;
    projectId: string;
    requirements: EnvironmentRequirements;
  }): Promise<EnvironmentAdmission[]> {
    const policy = await this.projects.list(args);
    if (policy.invalid) {
      throw new InvalidEnvironmentPolicyError(policy.invalid.error);
    }
    const admissions: EnvironmentAdmission[] = [];
    for (const name of Object.keys(policy.environments).sort()) {
      if (!identityMayUseEnvironment(args.identity, args.projectId, name)) {
        continue;
      }
      const admission = await this.evaluate({ ...args, name });
      if ("admission" in admission) admissions.push(admission.admission);
    }
    return admissions;
  }

  async admit(args: {
    identity: Identity;
    projectId: string;
    owner?: PlacementOwner;
    environment?: string;
    workerNodeId?: string;
    allocationBindingId?: string;
    allowed?: readonly string[];
    preferred?: readonly string[];
    requirements: EnvironmentRequirements;
    /** The agent runs with the owner's own harness login (ADR 0184). */
    personalLogin?: PersonalLoginKind;
  }): Promise<EnvironmentAdmission> {
    return withSpan(
      {
        tracer,
        name: "environment.admit",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId,
        },
      },
      async () => {
        const policy = await this.projects.list(args);
        if (policy.invalid)
          throw new InvalidEnvironmentPolicyError(policy.invalid.error);
        if (args.environment) {
          const definition = policy.environments[args.environment];
          if (!definition) throw new EnvironmentNotFoundError(args.environment);
          if (args.allowed && !args.allowed.includes(args.environment)) {
            throw new EnvironmentAccessDeniedError(args.environment);
          }
          if (
            !identityMayUseEnvironment(
              args.identity,
              args.projectId,
              args.environment,
            )
          ) {
            throw new EnvironmentAccessDeniedError(args.environment);
          }
          const evaluated = await this.evaluate({
            ...args,
            name: args.environment,
            reason: "requested",
          });
          if ("admission" in evaluated) return evaluated.admission;
          if (evaluated.bindingUnavailable) {
            throw new EnvironmentBindingUnavailableError(args.environment);
          }
          throw new EnvironmentIncompatibleError(
            args.environment,
            evaluated.reasons,
          );
        }

        const ordered = [
          ...(args.preferred ?? []),
          ...(policy.defaultEnvironment ? [policy.defaultEnvironment] : []),
          ...Object.keys(policy.environments).sort(),
        ].filter((name, index, all) => all.indexOf(name) === index);
        const reasons: Record<string, readonly string[]> = {};
        for (const name of ordered) {
          if (!policy.environments[name]) continue;
          if (args.allowed && !args.allowed.includes(name)) {
            reasons[name] = ["Agent policy does not allow this Environment"];
            continue;
          }
          if (!identityMayUseEnvironment(args.identity, args.projectId, name)) {
            reasons[name] = ["Identity is not granted this Environment"];
            continue;
          }
          const reason: PlacementReason = args.preferred?.includes(name)
            ? "agent_preferred"
            : name === policy.defaultEnvironment
              ? "project_default"
              : "available";
          const evaluated = await this.evaluate({
            ...args,
            name,
            reason,
          }).catch((error) => {
            if (error instanceof EnvironmentCapacityError)
              return {
                bindingUnavailable: false as const,
                reasons: [error.message],
              };
            throw error;
          });
          if ("admission" in evaluated) return evaluated.admission;
          reasons[name] = evaluated.bindingUnavailable
            ? ["No machine for it is online and open to this work"]
            : evaluated.reasons;
        }
        for (const entry of policy.entries) {
          if (entry.invalid)
            reasons[entry.name] = [
              `invalid in ${PROJECT_MANIFEST_PATH}: ${entry.invalid.error}`,
            ];
        }
        throw new NoCompatibleEnvironmentError(reasons);
      },
    );
  }

  /**
   * Minutes a chat in this Environment may wait without a turn before its
   * workspace is released (ADR 0173); 0 never releases it.
   */
  async idleReleaseMinutes(args: {
    identity: Identity;
    projectId: string;
    environment: string;
  }): Promise<number> {
    const definition = await this.projects.get({
      identity: args.identity,
      projectId: args.projectId,
      name: args.environment,
    });
    return definition?.idleReleaseMinutes ?? DEFAULT_IDLE_RELEASE_MINUTES;
  }

  private async evaluate(args: {
    identity: Identity;
    projectId: string;
    owner?: PlacementOwner;
    name: string;
    reason?: PlacementReason;
    workerNodeId?: string;
    allocationBindingId?: string;
    requirements: EnvironmentRequirements;
    personalLogin?: PersonalLoginKind;
  }): Promise<
    | { admission: EnvironmentAdmission }
    | { bindingUnavailable: true; reasons: [] }
    | { bindingUnavailable: false; reasons: readonly string[] }
  > {
    const definition = await this.projects.get(args);
    if (!definition)
      return { bindingUnavailable: false, reasons: ["Not declared"] };
    if (!definition.workloads.includes(args.requirements.workload)) {
      return {
        bindingUnavailable: false,
        reasons: [`Workload '${args.requirements.workload}' is not declared`],
      };
    }
    const effectiveRequirements = mergeRequirements(args.requirements, {
      ...definition.requirements,
      capabilities: [
        ...(definition.requirements?.capabilities ?? []),
        ...sandboxCapabilitiesFor(definition),
      ],
    });
    const source =
      definition.device === "member" ? this.memberDevices : this.provider;
    const owner =
      args.owner === undefined
        ? placementOwner(args.identity.externalUserId)
        : args.owner;
    const runtime = await source?.get({
      tenantId: args.identity.tenantId,
      pool: definition.pool ?? {},
      ...(definition.strict ? { strict: true } : {}),
      requirements: effectiveRequirements,
      projectId: args.projectId,
      ...(owner ? { ownerUserId: owner } : {}),
      clientRunnerId: args.identity.clientRunnerId,
      allocationBindingId: args.allocationBindingId,
      workerNodeId: args.workerNodeId,
    });
    if (!runtime) return { bindingUnavailable: true, reasons: [] };
    const compatibility = environmentSatisfies(
      runtime.descriptor,
      effectiveRequirements,
    );
    if (!compatibility.compatible) {
      return { bindingUnavailable: false, reasons: compatibility.reasons };
    }
    const personal = personalCredentialsDecision({
      environment: args.name,
      definition,
      owner,
      runtime,
    });
    if (args.personalLogin) {
      if (!personal.allowed)
        return { bindingUnavailable: false, reasons: [personal.reason] };
      // An Environment image supplies the CLI; otherwise the machine must.
      if (
        !definition.image &&
        !runtime.descriptor.capabilities.includes(
          harnessCapability(args.personalLogin),
        )
      )
        return {
          bindingUnavailable: false,
          reasons: [
            `${HARNESS_NAMES[args.personalLogin]} is not installed on this Environment's machine. Name an image that has it, or install it on the machine's PATH`,
          ],
        };
    }
    const sandbox = await this.sandboxFor({ ...args, definition });
    if ("reason" in sandbox)
      return { bindingUnavailable: false, reasons: [sandbox.reason] };
    return {
      admission: {
        environmentName: args.name,
        reason: args.reason ?? "requested",
        runtime,
        binding: runtime.descriptor,
        effectiveRequirements,
        sandbox,
        ...(definition.approvals ? { approvals: definition.approvals } : {}),
        personalCredentials: personal.allowed,
      },
    };
  }

  /** Resolve the image, containers and egress one Allocation's sandbox gets. */
  private async sandboxFor(args: {
    identity: Identity;
    projectId: string;
    definition: ProjectEnvironmentDefinition;
  }): Promise<EnvironmentSandbox | { reason: string }> {
    const { definition } = args;
    const egress = resolveEgress({
      policy: definition.network,
      gatewayHosts: this.options.gatewayHosts ?? [],
    });
    const common: EnvironmentSandbox = {
      ...(definition.requirements?.containers ? { containers: true } : {}),
      ...(egress.mode === "open" ? {} : { egress }),
    };
    const image = definition.image;
    if (!image) return common;
    if (image.kind === "oci")
      return { ...common, image: { kind: "oci", reference: image.reference } };
    const content = await this.projects.readProgramFile({
      identity: args.identity,
      projectId: args.projectId,
      path: image.path,
    });
    if (content === null)
      return { reason: `Image Dockerfile ${image.path} does not exist` };
    if (Buffer.byteLength(content) > MAX_DOCKERFILE_BYTES)
      return { reason: `Image Dockerfile ${image.path} exceeds 64 KiB` };
    return {
      ...common,
      image: {
        kind: "dockerfile",
        path: image.path,
        content,
        digest: dockerfileDigest(content),
      },
    };
  }
}

function mergeRequirements(
  workload: EnvironmentRequirements,
  project: Omit<EnvironmentRequirements, "workload" | "topology"> | undefined,
): EnvironmentRequirements {
  return {
    workload: workload.workload,
    ...(workload.topology ? { topology: workload.topology } : {}),
    ...maxTrust(workload.trust, project?.trust),
    ...maxIsolation(workload.isolation, project?.isolation),
    capabilities: [
      ...new Set([
        ...(workload.capabilities ?? []),
        ...(project?.capabilities ?? []),
      ]),
    ],
    resources: mergeResources(workload.resources, project?.resources),
  };
}

function maxTrust(
  left: EnvironmentTrust | undefined,
  right: EnvironmentTrust | undefined,
): Pick<EnvironmentRequirements, "trust"> {
  if (left === "managed" || right === "managed") return { trust: "managed" };
  return left || right ? { trust: "local" } : {};
}

function maxIsolation(
  left: EnvironmentIsolation | undefined,
  right: EnvironmentIsolation | undefined,
): Pick<EnvironmentRequirements, "isolation"> {
  const order: EnvironmentIsolation[] = ["none", "process", "sandbox"];
  const values = [left, right].filter(
    (value): value is EnvironmentIsolation => value !== undefined,
  );
  const isolation = values.sort(
    (a, b) => order.indexOf(b) - order.indexOf(a),
  )[0];
  return isolation ? { isolation } : {};
}

function mergeResources(
  left: EnvironmentResourcePolicy | undefined,
  right: EnvironmentResourcePolicy | undefined,
): EnvironmentResourcePolicy {
  const numeric = (
    key: Exclude<keyof EnvironmentResourcePolicy, "gpu">,
  ): number | undefined => {
    const values = [left?.[key], right?.[key]].filter(
      (value): value is number => value !== undefined,
    );
    return values.length > 0 ? Math.max(...values) : undefined;
  };
  return {
    ...(numeric("cpuMillis") !== undefined
      ? { cpuMillis: numeric("cpuMillis") }
      : {}),
    ...(numeric("memoryMb") !== undefined
      ? { memoryMb: numeric("memoryMb") }
      : {}),
    ...(numeric("storageMb") !== undefined
      ? { storageMb: numeric("storageMb") }
      : {}),
    ...(left?.gpu || right?.gpu ? { gpu: true } : {}),
    ...(numeric("commandTimeoutSeconds") !== undefined
      ? { commandTimeoutSeconds: numeric("commandTimeoutSeconds") }
      : {}),
    ...(numeric("maxConcurrency") !== undefined
      ? { maxConcurrency: numeric("maxConcurrency") }
      : {}),
  };
}
