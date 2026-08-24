import type {
  EnvironmentProvider,
  EnvironmentRuntimeBinding,
} from "@catamorphic/sandbox";

const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A deterministic Environment provider for one-node hosts. The same logical
 * contract can later be backed by a scheduler without changing project files.
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
  return {
    get: ({ bindingId }) => {
      const binding = byId.get(bindingId);
      return binding;
    },
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
    resources: Object.freeze({ ...runtime.descriptor.resources }),
  });
  return Object.freeze({
    descriptor,
    ...(runtime.sandboxProvider
      ? { sandboxProvider: runtime.sandboxProvider }
      : {}),
  });
}
