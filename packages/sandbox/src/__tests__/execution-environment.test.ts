import { describe, expect, it } from "vitest";
import {
  accessTier,
  type EnvironmentBinding,
  environmentSatisfies,
  placementOrder,
  poolMatches,
} from "../execution-environment.js";

const binding: EnvironmentBinding = {
  id: "managed-standard",
  label: "Managed standard",
  trust: "managed",
  isolation: "sandbox",
  workloads: ["agent", "workflow"],
  agentTopologies: ["controller", "contained"],
  capabilities: ["network.egress", "browser"],
  resourceLimits: ["cpuMillis", "memoryMb", "storageMb", "gpu"],
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
        "Native agent execution does not enforce sandbox resource limits; choose a controller agent",
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

describe("placement (ADR 0167)", () => {
  const alice = { userId: "alice@example.com", groups: ["eng@example.com"] };

  it("matches every pool label", () => {
    expect(poolMatches({ class: "gpu", plane: "worker" }, {})).toBe(true);
    expect(poolMatches({ class: "gpu" }, { class: "gpu" })).toBe(true);
    expect(poolMatches({ class: "gpu" }, { class: "gpu", zone: "a" })).toBe(
      false,
    );
    expect(poolMatches(undefined, { class: "gpu" })).toBe(false);
  });

  it("ranks a person's own node before a group's before everyone's", () => {
    expect(
      accessTier({ users: ["alice@example.com"], groups: [] }, alice),
    ).toBe(0);
    expect(
      accessTier(
        { users: ["alice@example.com", "bob@example.com"], groups: [] },
        alice,
      ),
    ).toBe(1);
    expect(accessTier({ users: [], groups: ["eng@example.com"] }, alice)).toBe(
      1,
    );
    expect(accessTier({ everyone: true }, alice)).toBe(2);
    expect(
      accessTier({ users: ["bob@example.com"], groups: [] }, alice),
    ).toBeUndefined();
    // Project-owned work only lands on nodes open to everyone.
    expect(
      accessTier({ users: [], groups: ["eng@example.com"] }, undefined),
    ).toBeUndefined();
    expect(accessTier({ everyone: true }, undefined)).toBe(2);
  });

  it("orders narrowest first and stays there when strict", () => {
    const tiers: Record<string, 0 | 1 | 2 | undefined> = {
      shared: 2,
      team: 1,
      desk: 0,
      bobs: undefined,
    };
    const nodes = ["shared", "bobs", "team", "desk"];
    expect(placementOrder(nodes, (node) => tiers[node])).toEqual([
      "desk",
      "team",
      "shared",
    ]);
    expect(
      placementOrder(nodes, (node) => tiers[node], { strict: true }),
    ).toEqual(["desk"]);
  });
});
