import { describe, expect, it } from "vitest";
import {
  type EnvironmentBinding,
  environmentSatisfies,
} from "../execution-environment.js";

const binding: EnvironmentBinding = {
  id: "managed-standard",
  label: "Managed standard",
  trust: "managed",
  isolation: "sandbox",
  workloads: ["agent", "workflow"],
  agentTopologies: ["controller", "contained"],
  capabilities: ["network.egress", "browser"],
  resources: {
    cpuMillis: 4000,
    memoryMb: 8192,
    storageMb: 20_000,
    gpu: false,
    timeoutSeconds: 3600,
    maxConcurrency: 8,
  },
};

describe("environmentSatisfies", () => {
  it("accepts requirements inside a binding ceiling", () => {
    expect(
      environmentSatisfies(binding, {
        workload: "agent",
        topology: "contained",
        trust: "managed",
        isolation: "process",
        capabilities: ["network.egress", "browser"],
        resources: { memoryMb: 8192 },
      }),
    ).toEqual({ compatible: true });
  });

  it("reports every incompatible requirement", () => {
    expect(
      environmentSatisfies(binding, {
        workload: "agent",
        topology: "native",
        capabilities: ["private-network"],
        resources: { memoryMb: 16_384, gpu: true },
      }),
    ).toEqual({
      compatible: false,
      reasons: [
        "Agent topology 'native' is not supported",
        "Capability 'private-network' is not available",
        "Memory requirement 16384 MB exceeds the 8192 MB ceiling",
        "A GPU is required but unavailable",
      ],
    });
  });

  it("requires the requested workload, trust, and isolation", () => {
    expect(
      environmentSatisfies(
        { ...binding, trust: "local", isolation: "process" },
        {
          workload: "workflow",
          trust: "managed",
          isolation: "sandbox",
        },
      ),
    ).toEqual({
      compatible: false,
      reasons: [
        "Trust level 'managed' is required",
        "Isolation level 'sandbox' is required",
      ],
    });
  });
});
