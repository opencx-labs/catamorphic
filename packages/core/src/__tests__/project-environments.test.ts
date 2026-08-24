import { describe, expect, it } from "vitest";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";

describe("project Environment policy", () => {
  it("parses a default and preserves per-Environment policy", () => {
    expect(
      parseProjectEnvironmentPolicy({
        environments: {
          local: {
            binding: "local",
            description: "Run on this desktop",
            workloads: ["agent", "workflow"],
          },
          company: {
            binding: "managed-standard",
            workloads: ["agent", "workflow"],
            requirements: {
              trust: "managed",
              isolation: "sandbox",
              capabilities: ["network.egress"],
              resources: { memoryMb: 8192 },
            },
          },
        },
        defaultEnvironment: "local",
      }),
    ).toMatchObject({
      defaultEnvironment: "local",
      environments: {
        local: { binding: "local" },
        company: {
          binding: "managed-standard",
          requirements: {
            trust: "managed",
            isolation: "sandbox",
            resources: { memoryMb: 8192 },
          },
        },
      },
    });
  });

  it.each([
    [
      "invalid name",
      {
        environments: {
          "not allowed": { binding: "local", workloads: ["agent"] },
        },
      },
      "Invalid Environment name",
    ],
    [
      "missing binding",
      { environments: { local: { workloads: ["agent"] } } },
      "binding",
    ],
    [
      "unsupported workload",
      {
        environments: {
          local: { binding: "local", workloads: ["container"] },
        },
      },
      "expected one of",
    ],
  ])("reports %s without hiding other entries", (_name, manifest, message) => {
    const parsed = parseProjectEnvironmentPolicy(manifest);
    expect(parsed.entries[0]?.invalid?.error).toContain(message);
  });

  it("rejects an unknown default Environment", () => {
    const parsed = parseProjectEnvironmentPolicy({
      environments: {
        local: { binding: "local", workloads: ["agent"] },
      },
      defaultEnvironment: "company",
    });
    expect(parsed.invalid?.error).toContain("defaultEnvironment");
  });
});
