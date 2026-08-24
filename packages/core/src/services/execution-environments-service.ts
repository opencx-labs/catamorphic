import type {
  EnvironmentBinding,
  EnvironmentIsolation,
  EnvironmentProvider,
  EnvironmentRequirements,
  EnvironmentResourcePolicy,
  EnvironmentRuntimeBinding,
  EnvironmentTrust,
} from "@catamorphic/sandbox";
import { environmentSatisfies } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import {
  identityMayUseEnvironment,
  isBuilder,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ProjectEnvironmentsService } from "./project-environments-service.js";

export interface EnvironmentAdmission {
  environmentName: string;
  runtime: EnvironmentRuntimeBinding;
  binding: EnvironmentBinding;
  effectiveRequirements: EnvironmentRequirements;
}

export interface EnvironmentDiscoveryItem {
  name: string;
  label: string;
  description?: string;
  available: boolean;
  compatible: boolean;
  preferred: boolean;
  allowed: boolean;
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
  constructor(
    readonly environment: string,
    readonly bindingId: string,
  ) {
    super(
      `Environment '${environment}' requires unavailable binding '${bindingId}'`,
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
    super("No accessible project Environment satisfies this workload");
    this.name = "NoCompatibleEnvironmentError";
  }
}

export class ExecutionEnvironmentsService {
  constructor(
    private readonly projects: ProjectEnvironmentsService,
    private readonly provider: EnvironmentProvider,
  ) {}

  /** Resolve the host-only runtime realization recorded by an Allocation. */
  getRuntimeBinding(args: {
    identity: Identity;
    bindingId: string;
  }):
    | Promise<EnvironmentRuntimeBinding | undefined>
    | EnvironmentRuntimeBinding
    | undefined {
    return this.provider.get({
      tenantId: args.identity.tenantId,
      bindingId: args.bindingId,
    });
  }

  async discover(args: {
    identity: Identity;
    projectId: string;
    requirements: EnvironmentRequirements;
    allowed?: readonly string[];
    preferred?: readonly string[];
  }): Promise<EnvironmentDiscovery> {
    if (!mayUseProject(args.identity, args.projectId)) {
      throw new AccessDeniedError();
    }
    const policy = await this.projects.list(args);
    if (policy.invalid) throw new Error(policy.invalid.error);
    const includeDenied = isBuilder(args.identity, args.projectId);
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
      const evaluated = await this.evaluate({ ...args, name });
      const admission =
        "admission" in evaluated ? evaluated.admission : undefined;
      const compatibilityReasons =
        "admission" in evaluated
          ? []
          : evaluated.bindingUnavailable
            ? ["Host binding is unavailable"]
            : evaluated.reasons;
      const reasons = allowed
        ? compatibilityReasons
        : [
            ...(granted ? [] : ["Identity is not granted this Environment"]),
            ...(agentAllowed
              ? []
              : ["Agent policy does not allow this Environment"]),
          ];
      items.push({
        name,
        label: name,
        ...(definition.description
          ? { description: definition.description }
          : {}),
        available: Boolean(admission),
        compatible: Boolean(admission) && allowed,
        preferred: args.preferred?.includes(name) ?? false,
        allowed,
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
    return {
      items,
      ...(policy.defaultEnvironment
        ? { defaultEnvironment: policy.defaultEnvironment }
        : {}),
    };
  }

  async listCompatible(args: {
    identity: Identity;
    projectId: string;
    requirements: EnvironmentRequirements;
  }): Promise<EnvironmentAdmission[]> {
    const policy = await this.projects.list(args);
    if (policy.invalid) {
      throw new Error(policy.invalid.error);
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
    environment?: string;
    allowed?: readonly string[];
    preferred?: readonly string[];
    requirements: EnvironmentRequirements;
  }): Promise<EnvironmentAdmission> {
    const policy = await this.projects.list(args);
    if (policy.invalid) throw new Error(policy.invalid.error);
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
      });
      if ("admission" in evaluated) return evaluated.admission;
      if (evaluated.bindingUnavailable) {
        throw new EnvironmentBindingUnavailableError(
          args.environment,
          definition.binding,
        );
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
      const evaluated = await this.evaluate({ ...args, name });
      if ("admission" in evaluated) return evaluated.admission;
      reasons[name] = evaluated.bindingUnavailable
        ? ["Host binding is unavailable"]
        : evaluated.reasons;
    }
    throw new NoCompatibleEnvironmentError(reasons);
  }

  private async evaluate(args: {
    identity: Identity;
    projectId: string;
    name: string;
    requirements: EnvironmentRequirements;
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
    const runtime = await this.provider.get({
      tenantId: args.identity.tenantId,
      bindingId: definition.binding,
    });
    if (!runtime) return { bindingUnavailable: true, reasons: [] };
    const effectiveRequirements = mergeRequirements(
      args.requirements,
      definition.requirements,
    );
    const compatibility = environmentSatisfies(
      runtime.descriptor,
      effectiveRequirements,
    );
    if (!compatibility.compatible) {
      return { bindingUnavailable: false, reasons: compatibility.reasons };
    }
    return {
      admission: {
        environmentName: args.name,
        runtime,
        binding: runtime.descriptor,
        effectiveRequirements,
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
    ...(numeric("timeoutSeconds") !== undefined
      ? { timeoutSeconds: numeric("timeoutSeconds") }
      : {}),
    ...(numeric("maxConcurrency") !== undefined
      ? { maxConcurrency: numeric("maxConcurrency") }
      : {}),
  };
}
