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
  it("validates ids and places by pool labels", async () => {
    expect(() => defineStaticEnvironments([binding, binding])).toThrow(
      "Duplicate",
    );
    const gpu = {
      descriptor: {
        ...binding.descriptor,
        id: "gpu",
        labels: { class: "gpu" },
      },
    };
    const provider = defineStaticEnvironments([binding, gpu]);
    expect(
      (await provider.get({ tenantId: "a", pool: {} }))?.descriptor.id,
    ).toBe("local");
    expect(
      (await provider.get({ tenantId: "a", pool: { class: "gpu" } }))
        ?.descriptor.id,
    ).toBe("gpu");
    expect(
      await provider.get({ tenantId: "a", pool: { class: "tpu" } }),
    ).toBeUndefined();
    expect(
      (
        await provider.get({
          tenantId: "a",
          pool: {},
          allocationBindingId: "gpu",
        })
      )?.descriptor.id,
    ).toBe("gpu");
  });
});
