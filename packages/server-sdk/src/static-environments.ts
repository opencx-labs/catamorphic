import {
  type EnvironmentProvider,
  type EnvironmentRuntimeBinding,
  environmentSatisfies,
  poolMatches,
} from "@catamorphic/sandbox";

const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A deterministic Environment provider for one-person hosts: the first
 * binding whose labels match the Environment's pool and that meets its
 * requirements (ADR 0167). Every binding takes the host's one person's work,
 * so there is no access to check.
 */
export function defineStaticEnvironments(
  bindings: readonly EnvironmentRuntimeBinding[],
): EnvironmentProvider {
  const byId = new Map<string, EnvironmentRuntimeBinding>();
  for (const binding of bindings) {
    const id = binding.descriptor.id;
    if (!BINDING_ID.test(id)) {
      throw new Error(`Invalid Environment binding id '${id}'`);
    }
    if (byId.has(id)) {
      throw new Error(`Duplicate Environment binding '${id}'`);
    }
    if (binding.descriptor.workloads.length === 0) {
      throw new Error(`Environment binding '${id}' supports no workloads`);
    }
    byId.set(id, normalize(binding));
  }
  const ordered = [...byId.values()];
  return {
    get: ({ allocationBindingId, pool, requirements }) =>
      allocationBindingId
        ? [byId.get(allocationBindingId)].find(
            (binding) =>
              binding !== undefined &&
              poolMatches(binding.descriptor.labels, pool),
          )
        : ordered.find(
            (binding) =>
              poolMatches(binding.descriptor.labels, pool) &&
              (!requirements ||
                environmentSatisfies(binding.descriptor, requirements)
                  .compatible),
          ),
  };
}

function normalize(
  runtime: EnvironmentRuntimeBinding,
): EnvironmentRuntimeBinding {
  const descriptor = Object.freeze({
    ...runtime.descriptor,
    workloads: Object.freeze([...runtime.descriptor.workloads]),
    agentTopologies: Object.freeze([...runtime.descriptor.agentTopologies]),
    capabilities: Object.freeze([...runtime.descriptor.capabilities]),
    resourceLimits:
      runtime.descriptor.resourceLimits ??
      runtime.sandboxProvider?.resourceLimits,
    resources: Object.freeze({ ...runtime.descriptor.resources }),
    labels: Object.freeze({ ...runtime.descriptor.labels }),
  });
  return Object.freeze({
    descriptor,
    ...(runtime.workerNodeId ? { workerNodeId: runtime.workerNodeId } : {}),
    ...(runtime.sandboxProvider
      ? { sandboxProvider: runtime.sandboxProvider }
      : {}),
  });
}
