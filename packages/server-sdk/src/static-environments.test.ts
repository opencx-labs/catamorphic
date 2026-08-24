import { describe, expect, it } from "vitest";
import { defineStaticEnvironments } from "./static-environments.js";

const binding = {
  descriptor: {
    id: "local",
    label: "Local",
    trust: "local" as const,
    isolation: "sandbox" as const,
    workloads: ["agent", "workflow"] as const,
    agentTopologies: ["controller"] as const,
    capabilities: [] as const,
    resources: {},
  },
};

describe("defineStaticEnvironments", () => {
  it("validates ids and resolves bindings", async () => {
    expect(() => defineStaticEnvironments([binding, binding])).toThrow(
      "Duplicate",
    );
    const provider = defineStaticEnvironments([binding]);
    expect(
      await provider.get({ tenantId: "a", bindingId: "local" }),
    ).toBeDefined();
  });
});
