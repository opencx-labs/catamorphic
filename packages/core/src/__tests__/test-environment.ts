import type {
  EnvironmentProvider,
  EnvironmentRuntimeBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";

export function testEnvironmentProvider(
  sandboxProvider?: SandboxProvider,
): EnvironmentProvider {
  const binding: EnvironmentRuntimeBinding = {
    descriptor: {
      id: "local",
      label: "Test Environment",
      trust: "local",
      isolation: sandboxProvider ? "sandbox" : "none",
      workloads: ["agent", "workflow"],
      agentTopologies: ["controller", "native", "contained", "external"],
      capabilities: [],
      resources: {},
    },
    ...(sandboxProvider ? { sandboxProvider } : {}),
  };
  return {
    get: ({ bindingId }) =>
      bindingId === binding.descriptor.id ? binding : undefined,
  };
}
