import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  EnvironmentBinding,
  EnvironmentIsolation,
  EnvironmentProvider,
  EnvironmentRequirements,
  EnvironmentResourcePolicy,
  EnvironmentRuntimeBinding,
  EnvironmentTrust,
  SandboxCapability,
  SignInHarness,
} from "@catamorphic/sandbox";
import {
  dockerfileDigest,
  environmentSatisfies,
  harnessCapability,
  MACHINE_CAPABILITIES,
  resolveEgress,
  resolveSetupEgress,
  SANDBOX_CAPABILITIES,
  SEPARATE_AGENT_DEFAULT_RESOURCES,
  SIGN_IN_SPECS,
  signInCapability,
  volumeKey,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import type { Identity } from "../identity.js";
import {
  hasProjectPermission,
  identityMayUseEnvironment,
  isProjectPrincipal,
  mayUseProject,
  PROJECT_PRINCIPAL_ID,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import type {
  EnvironmentAllocationPolicy,
  EnvironmentSandbox,
  EnvironmentSandboxVolume,
} from "./execution-allocations-service.js";
import type {
  PlacementWaitReason,
  PlacementWaitTarget,
} from "./placement-waits.js";
import {
  DEFAULT_CHECKOUT_TIMEOUT_MINUTES,
  DEFAULT_IDLE_RELEASE_MINUTES,
  DEFAULT_SETUP_TIMEOUT_MINUTES,
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
  /** What the sandbox is given: image, containers, egress (ADR 0176), volumes (ADR 0208). */
  sandbox: EnvironmentSandbox;
  /**
   * What runs in each new workspace's project folder before its first turn
   * (ADR 0208), as the Environment says now: a changed command runs again.
   * `network` asks for the setup's own network while it runs (ADR 0257);
   * the Allocation fixed what that is when it was admitted.
   */
  setup?: AdmittedSetup;
  /**
   * How a new workspace fetches its base (ADR 0353), as the Environment
   * says now; absent, Work's own command fetches it whole.
   */
  checkout?: AdmittedCheckout;
  /** How long unattended escalations wait for a person (ADR 0176). */
  approvals?: { waitMinutes: number };
  /**
   * This placement may hold the owner's personal credentials (ADR 0184):
   * the Environment allows them, the work is a member's own, and the
   * machine isolates it.
   */
  personalCredentials: boolean;
  /**
   * The placement isolates the work's owner (see
   * {@link placementIsolatesOwner}): what lets an Environment's secrets
   * reach its sandboxes (ADR 0206).
   */
  isolated: boolean;
  /**
   * How the work would wait for a machine of this Environment (ADR 0258),
   * should the machine admitted be full by the time its Allocation is made.
   */
  wait: Omit<PlacementWaitTarget, "reason">;
}

/** Arguments of {@link ExecutionEnvironmentsService.admit}. */
export interface EnvironmentAdmitArgs {
  identity: Identity;
  projectId: string;
  owner?: PlacementOwner;
  /**
   * The chat key of a project's own chat (ADR 0173): a machine that is for
   * one key takes only that chat (ADR 0349).
   */
  chatKey?: string;
  environment?: string;
  workerNodeId?: string;
  allocationBindingId?: string;
  allowed?: readonly string[];
  preferred?: readonly string[];
  requirements: EnvironmentRequirements;
  /** The agent runs on the owner's own sign-in on the machine (ADR 0199). */
  signIn?: SignInHarness;
  /**
   * The work's harness runs in its sandbox, so a sandbox whose commands run
   * apart has an agent container for it (ADR 0332). Otherwise (the built-in
   * agent on the control plane, workflows) its command container is the
   * whole sandbox and no agent share is reserved.
   */
  harnessInSandbox?: boolean;
  /**
   * Admit as the program declares it at this published commit, Dockerfile
   * included, instead of the newest `main` (ADR 0334): a cache fill builds
   * its sandbox from the revision that went live.
   */
  commit?: string;
  /**
   * A cache fill of this size (ADR 0334, 0336): placed only where it fits
   * above the machine's full disk floor. Not a requirement, so a machine
   * that reports no disk still takes it.
   */
  fill?: { storageMb: number };
}

/** An Environment's checkout as admission reads it (ADR 0353). */
export interface AdmittedCheckout {
  command: string;
  timeoutMinutes: number;
}

/** An Environment's setup as admission reads it (ADRs 0208, 0257). */
export interface AdmittedSetup {
  command?: string;
  /** A project workflow run after the command (ADR 0324). */
  workflow?: string;
  timeoutMinutes: number;
  network?: { allow: readonly string[] };
  /** The secrets a setup with its own network runs with, and no others. */
  secrets?: readonly string[];
}

/**
 * Whether a placement keeps one owner's work apart from everyone else's
 * (ADRs 0184, 0206). A member's work: their own device, a sandbox (a VM or
 * gVisor), a machine only they use, or a machine whose operator accepted
 * personal credentials on shared processes. The project's own work
 * (`owner` null): a sandbox, or a machine only that project's work
 * reaches.
 */
export function placementIsolatesOwner(input: {
  definition: Pick<ProjectEnvironmentDefinition, "device">;
  owner: string | null;
  runtime: Pick<EnvironmentRuntimeBinding, "descriptor" | "servesOnlyOwner">;
}): boolean {
  const { descriptor } = input.runtime;
  if (descriptor.isolation === "sandbox" || input.runtime.servesOnlyOwner)
    return true;
  if (!input.owner) return false;
  return (
    input.definition.device === "member" ||
    descriptor.capabilities.includes(MACHINE_CAPABILITIES.personalCredentials)
  );
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
  if (placementIsolatesOwner(input)) return { allowed: true };
  return {
    allowed: false,
    reason: `The machine for Environment '${input.environment}' runs other people's work as plain processes, so your own sign-in may not run there. Use isolated sandboxes there (microsandbox, or gVisor containers), a machine only you use, or set WORK_PERSONAL_CREDENTIALS=accept on that machine`,
  };
}

/**
 * Whether a member's own sign-in may run on one placement (ADR 0213): only
 * where the host says the machine may hold it, a machine of that member's
 * alone or a single person's server. A machine signed in to several
 * people's accounts would show the provider several accounts from one
 * address, which reads as a shared or resold account however well the
 * sandboxes are isolated.
 */
export function signInPlacementDecision(input: {
  harness: SignInHarness;
  runtime: Pick<EnvironmentRuntimeBinding, "ownSignIns">;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.runtime.ownSignIns) return { allowed: true };
  return {
    allowed: false,
    reason: `Your ${SIGN_IN_SPECS[input.harness].name} sign-in runs only on a machine of your own, so the provider never sees several people's accounts from one machine. Ask an administrator for a machine of your own, or run the chat on This machine`,
  };
}

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
    // A setup with its own network needs a machine that switches a running
    // sandbox's egress (ADR 0257).
    ...(definition.setup?.network ? [SANDBOX_CAPABILITIES.setupNetwork] : []),
    // An agent's commands apart from it (ADR 0332).
    ...(definition.commands?.separate
      ? [SANDBOX_CAPABILITIES.separateCommands]
      : []),
    ...(Object.keys(definition.volumes ?? {}).length > 0
      ? [SANDBOX_CAPABILITIES.volumes]
      : []),
    // Read-only mounts the sandbox cannot remount, filled apart (ADR 0334).
    ...(Object.keys(definition.caches ?? {}).length > 0
      ? [SANDBOX_CAPABILITIES.caches]
      : []),
  ];
}

/**
 * An Environment's volumes as one owner's sandboxes mount them (ADR 0208):
 * each keyed by project, owner and name, so every sandbox of that owner on
 * a machine sees the same directory and nobody else's does. `owner` is a
 * member, or null for the project's own work.
 */
export function environmentSandboxVolumes(input: {
  projectId: string;
  owner: string | null;
  volumes: ProjectEnvironmentDefinition["volumes"];
}): EnvironmentSandboxVolume[] {
  return Object.entries(input.volumes ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, volume]) => ({
      name,
      key: volumeKey({
        projectId: input.projectId,
        owner: input.owner ?? PROJECT_PRINCIPAL_ID,
        name,
      }),
      path: volume.path,
      ...(volume.exclusive ? { exclusive: true } : {}),
      ...(volume.sizeMb ? { sizeMb: volume.sizeMb } : {}),
    }));
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
export class EnvironmentPolicyInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid ${PROJECT_MANIFEST_PATH}: ${reason}`);
    this.name = "EnvironmentPolicyInvalidError";
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
      /**
       * Minutes work waits for a machine in an Environment that names no
       * `waitMinutes` of its own (ADR 0349): set by a host that makes
       * machines for waiting work, so a new chat waits for its machine
       * instead of failing at once. Unset, such work does not wait.
       */
      defaultWaitMinutes?: number;
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
    /** The agent runs on the owner's own sign-in on the machine (ADR 0199). */
    signIn?: SignInHarness;
    /** See {@link EnvironmentAdmitArgs.harnessInSandbox}. */
    harnessInSandbox?: boolean;
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
          throw new EnvironmentPolicyInvalidError(policy.invalid.error);
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
      throw new EnvironmentPolicyInvalidError(policy.invalid.error);
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

  async admit(args: EnvironmentAdmitArgs): Promise<EnvironmentAdmission> {
    const placed = await this.place(args);
    if ("admission" in placed) return placed.admission;
    throw placed.error;
  }

  /**
   * Admit work that may wait for a machine (ADR 0258). When no Environment
   * could take it because no machine open to it had room or was online, it
   * answers that the work waits in the first of those, in admission order,
   * whose `waitMinutes` lets work wait, or with `always` (a chat already
   * open, whose next turn waits as long as it is queued) the first of them.
   * Any other failure throws as {@link admit} does.
   */
  async admitOrWait(
    args: EnvironmentAdmitArgs & { always?: boolean },
  ): Promise<
    | { admission: EnvironmentAdmission }
    | { wait: PlacementWaitTarget; error: Error }
  > {
    const placed = await this.place(args);
    if ("admission" in placed) return placed;
    const wait = placed.waits.find(
      (candidate) => args.always || candidate.waitMinutes > 0,
    );
    if (wait) return { wait, error: placed.error };
    throw placed.error;
  }

  /**
   * Admission, or why it failed and where the work could wait: each
   * Environment, in admission order, that had no machine with room or
   * none online.
   */
  private async place(
    args: EnvironmentAdmitArgs,
  ): Promise<
    | { admission: EnvironmentAdmission }
    | { error: Error; waits: PlacementWaitTarget[] }
  > {
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
          throw new EnvironmentPolicyInvalidError(policy.invalid.error);
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
          const waitFor = (reason: PlacementWaitReason) =>
            waitTargetOf({
              ...args,
              name: args.environment ?? "",
              definition,
              reason,
              defaultWaitMinutes: this.options.defaultWaitMinutes,
            });
          const evaluated = await this.evaluate({
            ...args,
            name: args.environment,
            reason: "requested",
          }).catch((error) => {
            if (error instanceof EnvironmentCapacityError)
              return { capacity: error };
            throw error;
          });
          if ("capacity" in evaluated)
            return {
              error: evaluated.capacity,
              waits: waitFor("capacity"),
            };
          if ("admission" in evaluated) return evaluated;
          if (evaluated.bindingUnavailable) {
            return {
              error: new EnvironmentBindingUnavailableError(args.environment),
              waits: waitFor("unavailable"),
            };
          }
          return {
            error: new EnvironmentIncompatibleError(
              args.environment,
              evaluated.reasons,
            ),
            waits: [],
          };
        }

        const ordered = [
          ...(args.preferred ?? []),
          ...(policy.defaultEnvironment ? [policy.defaultEnvironment] : []),
          ...Object.keys(policy.environments).sort(),
        ].filter((name, index, all) => all.indexOf(name) === index);
        const reasons: Record<string, readonly string[]> = {};
        const waits: PlacementWaitTarget[] = [];
        for (const name of ordered) {
          const definition = policy.environments[name];
          if (!definition) continue;
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
            if (error instanceof EnvironmentCapacityError) {
              waits.push(
                ...waitTargetOf({
                  ...args,
                  name,
                  definition,
                  reason: "capacity",
                  defaultWaitMinutes: this.options.defaultWaitMinutes,
                }),
              );
              return {
                bindingUnavailable: false as const,
                reasons: [error.message],
              };
            }
            throw error;
          });
          if ("admission" in evaluated) return evaluated;
          if (evaluated.bindingUnavailable)
            waits.push(
              ...waitTargetOf({
                ...args,
                name,
                definition,
                reason: "unavailable",
                defaultWaitMinutes: this.options.defaultWaitMinutes,
              }),
            );
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
        return { error: new NoCompatibleEnvironmentError(reasons), waits };
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

  /** Whether an Environment runs its agents' commands apart (ADR 0332). */
  async separatesCommands(args: {
    identity: Identity;
    projectId: string;
    environment: string;
  }): Promise<boolean> {
    const definition = await this.projects.get({
      identity: args.identity,
      projectId: args.projectId,
      name: args.environment,
    });
    return Boolean(definition?.commands?.separate);
  }

  private async evaluate(args: {
    identity: Identity;
    projectId: string;
    owner?: PlacementOwner;
    chatKey?: string;
    name: string;
    reason?: PlacementReason;
    workerNodeId?: string;
    allocationBindingId?: string;
    requirements: EnvironmentRequirements;
    signIn?: SignInHarness;
    harnessInSandbox?: boolean;
    commit?: string;
    fill?: { storageMb: number };
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
    const source =
      definition.device === "member" ? this.memberDevices : this.provider;
    const owner = ownerOf(args);
    const effectiveRequirements = effectiveRequirementsOf({
      ...args,
      definition,
      owner,
    });
    const runtime = await source?.get({
      tenantId: args.identity.tenantId,
      pool: definition.pool ?? {},
      ...(definition.strict ? { strict: true } : {}),
      requirements: effectiveRequirements,
      projectId: args.projectId,
      ...(owner ? { ownerUserId: owner } : {}),
      ...(args.chatKey ? { chatKey: args.chatKey } : {}),
      clientRunnerId: args.identity.clientRunnerId,
      allocationBindingId: args.allocationBindingId,
      workerNodeId: args.workerNodeId,
      ...(args.fill ? { fill: args.fill } : {}),
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
    if (args.signIn) {
      if (!personal.allowed)
        return { bindingUnavailable: false, reasons: [personal.reason] };
      const own = signInPlacementDecision({ harness: args.signIn, runtime });
      if (!own.allowed)
        return { bindingUnavailable: false, reasons: [own.reason] };
      // An Environment image supplies the CLI; otherwise the machine must.
      if (
        !definition.image &&
        !runtime.descriptor.capabilities.includes(
          harnessCapability(args.signIn),
        )
      )
        return {
          bindingUnavailable: false,
          reasons: [
            `${SIGN_IN_SPECS[args.signIn].name} is not installed on this Environment's machine. Name an image that has it, or install it on the machine's PATH`,
          ],
        };
    }
    const sandbox = await this.sandboxFor({ ...args, definition, owner });
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
        ...(definition.setup
          ? {
              setup: {
                ...(definition.setup.command !== undefined
                  ? { command: definition.setup.command }
                  : {}),
                ...(definition.setup.workflow
                  ? { workflow: definition.setup.workflow }
                  : {}),
                timeoutMinutes:
                  definition.setup.timeoutMinutes ??
                  DEFAULT_SETUP_TIMEOUT_MINUTES,
                ...(definition.setup.network
                  ? { network: definition.setup.network }
                  : {}),
                ...(definition.setup.secrets
                  ? { secrets: definition.setup.secrets }
                  : {}),
              },
            }
          : {}),
        ...(definition.checkout
          ? {
              checkout: {
                command: definition.checkout.command,
                timeoutMinutes:
                  definition.checkout.timeoutMinutes ??
                  DEFAULT_CHECKOUT_TIMEOUT_MINUTES,
              },
            }
          : {}),
        ...(definition.approvals ? { approvals: definition.approvals } : {}),
        personalCredentials: personal.allowed,
        isolated: placementIsolatesOwner({ definition, owner, runtime }),
        wait: {
          environmentName: args.name,
          pool: definition.pool ?? {},
          owner,
          key: args.chatKey ?? null,
          requirements: waitRequirements({
            requirements: effectiveRequirements,
            definition,
            ...(args.harnessInSandbox ? { harnessInSandbox: true } : {}),
          }),
          waitMinutes:
            definition.waitMinutes ?? this.options.defaultWaitMinutes ?? 0,
        },
      },
    };
  }

  /**
   * Resolve the image, containers, egress and volumes one Allocation's
   * sandbox gets; volumes are the placement owner's. A setup with its own
   * network also fixes the only policy the sandbox widens to for that
   * setup (ADR 0257).
   */
  private async sandboxFor(args: {
    identity: Identity;
    projectId: string;
    definition: ProjectEnvironmentDefinition;
    owner: string | null;
    /** See {@link EnvironmentAdmitArgs.harnessInSandbox}. */
    harnessInSandbox?: boolean;
    /** The published commit the definition was read at, if not `main`. */
    commit?: string;
  }): Promise<EnvironmentSandbox | { reason: string }> {
    const { definition } = args;
    const egress = resolveEgress({
      policy: definition.network,
      gatewayHosts: this.options.gatewayHosts ?? [],
    });
    // The setup's hosts alone: not the gateway, nor the Environment's own.
    const setupEgress = definition.setup?.network
      ? resolveSetupEgress({ allow: definition.setup.network.allow })
      : undefined;
    const volumes = environmentSandboxVolumes({
      projectId: args.projectId,
      owner: args.owner,
      volumes: definition.volumes,
    });
    // The project's caches, whoever owns the work (ADR 0334): which
    // generation each sandbox mounts is read when it is made.
    const caches = Object.entries(definition.caches ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, cache]) => ({ name, path: cache.path }));
    const common: EnvironmentSandbox = {
      ...(definition.requirements?.containers ? { containers: true } : {}),
      ...(egress.mode === "open" ? {} : { egress }),
      ...(setupEgress ? { setupEgress } : {}),
      ...(volumes.length > 0 ? { volumes } : {}),
      ...(caches.length > 0 ? { caches } : {}),
      ...(definition.commands?.separate
        ? {
            separateCommands: {
              connections: [...(definition.commands.connections ?? [])],
              // An agent container only for a harness that runs in the
              // sandbox, its share fixed at admission, so the reservation
              // and the container agree (ADR 0332).
              ...(args.harnessInSandbox
                ? { agentResources: separateAgentResources(definition) }
                : {}),
            },
          }
        : {}),
    };
    const image = definition.image;
    if (!image) return common;
    if (image.kind === "oci")
      return { ...common, image: { kind: "oci", reference: image.reference } };
    const content = await this.projects.readProgramFile({
      identity: args.identity,
      projectId: args.projectId,
      path: image.path,
      ...(args.commit !== undefined ? { commit: args.commit } : {}),
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

/** Whose work is placed: the caller's unless named (ADR 0167). */
function ownerOf(args: {
  identity: Identity;
  owner?: PlacementOwner;
}): string | null {
  return args.owner === undefined
    ? placementOwner(args.identity.externalUserId)
    : args.owner;
}

/** What a machine must offer the work in this Environment. */
function effectiveRequirementsOf(args: {
  requirements: EnvironmentRequirements;
  definition: ProjectEnvironmentDefinition;
  owner: string | null;
  signIn?: SignInHarness;
}): EnvironmentRequirements {
  const { definition } = args;
  return mergeRequirements(args.requirements, {
    ...definition.requirements,
    capabilities: [
      ...(definition.requirements?.capabilities ?? []),
      ...sandboxCapabilitiesFor(definition),
      // A subscription runs only where its owner signed in (ADR 0199):
      // placement takes a machine that reports that sign-in.
      ...(args.signIn && args.owner
        ? [signInCapability({ harness: args.signIn, member: args.owner })]
        : []),
    ],
  });
}

/**
 * The agent container's limits where an Environment runs commands apart
 * (ADR 0332): its own, or 1 CPU and 2 GiB.
 */
export function separateAgentResources(
  definition: ProjectEnvironmentDefinition,
): { cpuMillis: number; memoryMb: number } {
  return {
    cpuMillis:
      definition.commands?.agentResources?.cpuMillis ??
      SEPARATE_AGENT_DEFAULT_RESOURCES.cpuMillis,
    memoryMb:
      definition.commands?.agentResources?.memoryMb ??
      SEPARATE_AGENT_DEFAULT_RESOURCES.memoryMb,
  };
}

/**
 * The part of a workload's needs that sizes a machine: with commands apart
 * and a harness in the sandbox, the agent container's share on top (ADR
 * 0332). A harness outside it (the built-in agent) has no agent container.
 */
function waitRequirements(input: {
  requirements: EnvironmentRequirements;
  definition: ProjectEnvironmentDefinition;
  harnessInSandbox?: boolean;
}): PlacementWaitTarget["requirements"] {
  const { requirements } = input;
  const agent =
    input.definition.commands?.separate && input.harnessInSandbox
      ? separateAgentResources(input.definition)
      : undefined;
  const own = requirements.resources ?? {};
  const cpuMillis = agent
    ? (own.cpuMillis ?? 0) + agent.cpuMillis
    : own.cpuMillis;
  const memoryMb = agent ? (own.memoryMb ?? 0) + agent.memoryMb : own.memoryMb;
  const { storageMb, gpu } = own;
  return {
    resources: {
      ...(cpuMillis !== undefined ? { cpuMillis } : {}),
      ...(memoryMb !== undefined ? { memoryMb } : {}),
      ...(storageMb !== undefined ? { storageMb } : {}),
      ...(gpu ? { gpu } : {}),
    },
    capabilities: requirements.capabilities ?? [],
    ...(requirements.trust ? { trust: requirements.trust } : {}),
    ...(requirements.isolation ? { isolation: requirements.isolation } : {}),
    ...(requirements.topology ? { topology: requirements.topology } : {}),
  };
}

/**
 * Where work waits for a machine of one Environment (ADR 0258); none for
 * a member's own computer, which no host makes.
 */
function waitTargetOf(args: {
  identity: Identity;
  owner?: PlacementOwner;
  chatKey?: string;
  /** See {@link ExecutionEnvironmentsService}'s `defaultWaitMinutes`. */
  defaultWaitMinutes: number | undefined;
  requirements: EnvironmentRequirements;
  signIn?: SignInHarness;
  harnessInSandbox?: boolean;
  name: string;
  definition: ProjectEnvironmentDefinition;
  reason: PlacementWaitReason;
}): PlacementWaitTarget[] {
  if (args.definition.device === "member") return [];
  const owner = ownerOf(args);
  return [
    {
      environmentName: args.name,
      reason: args.reason,
      pool: args.definition.pool ?? {},
      owner,
      key: args.chatKey ?? null,
      requirements: waitRequirements({
        requirements: effectiveRequirementsOf({ ...args, owner }),
        definition: args.definition,
        ...(args.harnessInSandbox ? { harnessInSandbox: true } : {}),
      }),
      waitMinutes: args.definition.waitMinutes ?? args.defaultWaitMinutes ?? 0,
    },
  ];
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
