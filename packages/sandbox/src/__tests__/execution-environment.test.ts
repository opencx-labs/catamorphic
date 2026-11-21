import { describe, expect, it } from "vitest";
import {
  accessTier,
  type EnvironmentBinding,
  environmentSatisfies,
  type NodeAccess,
  placementOrder,
  poolMatches,
  servesOnlyThisOwner,
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
    commandTimeoutSeconds: 3600,
    maxConcurrency: 8,
  },
};

describe("environmentSatisfies", () => {
  it("takes storageMb where the machine enforces it or reports its disk (ADR 0336)", () => {
    const container = {
      ...binding,
      resourceLimits: ["cpuMillis", "memoryMb"] as const,
      resources: { cpuMillis: 4000, memoryMb: 8192 },
    };
    const requirements = {
      workload: "agent" as const,
      resources: { storageMb: 10_000 },
    };
    expect(environmentSatisfies(binding, requirements)).toEqual({
      compatible: true,
    });
    expect(environmentSatisfies(container, requirements)).toEqual({
      compatible: false,
      reasons: ["Binding can neither enforce nor reserve 'storageMb'"],
    });
    const reporting = {
      ...container,
      capabilities: [...container.capabilities, "disk"],
      resources: { ...container.resources, storageMb: 90_000 },
    };
    expect(environmentSatisfies(reporting, requirements)).toEqual({
      compatible: true,
    });
    // More than the machine's whole disk less its floor never fits.
    expect(
      environmentSatisfies(reporting, {
        workload: "agent",
        resources: { storageMb: 100_000 },
      }),
    ).toEqual({
      compatible: false,
      reasons: ["Storage requirement 100000 MB exceeds the 90000 MB ceiling"],
    });
  });

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

describe("placement (ADRs 0167, 0347)", () => {
  const alice = { userId: "alice" };
  const only = (access: {
    users?: string[];
    projects?: string[];
    keys?: { project: string; key: string }[];
  }): NodeAccess => ({
    users: access.users ?? [],
    projects: access.projects ?? [],
    keys: access.keys ?? [],
  });

  it("matches every pool label", () => {
    expect(poolMatches({ class: "gpu", plane: "worker" }, {})).toBe(true);
    expect(poolMatches({ class: "gpu" }, { class: "gpu" })).toBe(true);
    expect(poolMatches({ class: "gpu" }, { class: "gpu", zone: "a" })).toBe(
      false,
    );
    expect(poolMatches(undefined, { class: "gpu" })).toBe(false);
  });

  it("ranks a person's own node before a shared one before anyone's", () => {
    const tier = (access: NodeAccess, owner = alice) =>
      accessTier({ access, owner });
    expect(tier(only({ users: ["alice"] }))).toBe(1);
    expect(tier(only({ users: ["alice", "bob"] }))).toBe(2);
    expect(tier(only({ users: ["alice"], projects: ["p1"] }))).toBe(2);
    expect(tier({ everyone: true })).toBe(3);
    expect(tier(only({ users: ["bob"] }))).toBeUndefined();
    // A node for nobody takes nothing.
    expect(tier(only({}))).toBeUndefined();
    expect(accessTier({ access: { everyone: true }, owner: undefined })).toBe(
      3,
    );
  });

  it("opens a node to one project's own work without opening it to its members", () => {
    const reviewPool = only({ projects: ["p1"] });
    expect(
      accessTier({ access: reviewPool, owner: undefined, projectId: "p1" }),
    ).toBe(1);
    expect(
      accessTier({ access: reviewPool, owner: undefined, projectId: "p2" }),
    ).toBeUndefined();
    expect(
      accessTier({
        access: only({ projects: ["p1", "p2"] }),
        owner: undefined,
        projectId: "p1",
      }),
    ).toBe(2);
    // A member's own chat in that project does not reach the pool.
    expect(
      accessTier({ access: reviewPool, owner: alice, projectId: "p1" }),
    ).toBeUndefined();
  });

  it("gives one chat key a node of its own, narrower than its project's", () => {
    const keyed = only({ keys: [{ project: "p1", key: "pr-7" }] });
    const work = { owner: undefined, projectId: "p1" };
    expect(accessTier({ access: keyed, ...work, chatKey: "pr-7" })).toBe(0);
    // Another key, a chat with no key, another project and a member's own
    // chat never land there.
    expect(
      accessTier({ access: keyed, ...work, chatKey: "pr-8" }),
    ).toBeUndefined();
    expect(accessTier({ access: keyed, ...work })).toBeUndefined();
    expect(
      accessTier({
        access: keyed,
        owner: undefined,
        projectId: "p2",
        chatKey: "pr-7",
      }),
    ).toBeUndefined();
    expect(
      accessTier({
        access: keyed,
        owner: alice,
        projectId: "p1",
        chatKey: "pr-7",
      }),
    ).toBeUndefined();
    // A node for two keys is shared between them.
    expect(
      accessTier({
        access: only({
          keys: [
            { project: "p1", key: "pr-7" },
            { project: "p1", key: "pr-8" },
          ],
        }),
        ...work,
        chatKey: "pr-7",
      }),
    ).toBe(2);
    expect(servesOnlyThisOwner(0)).toBe(true);
    expect(servesOnlyThisOwner(1)).toBe(true);
    expect(servesOnlyThisOwner(2)).toBe(false);
    expect(servesOnlyThisOwner(undefined)).toBe(false);
  });

  it("orders narrowest first and stays there when strict", () => {
    const tiers: Record<string, 0 | 1 | 2 | 3 | undefined> = {
      shared: 3,
      team: 2,
      desk: 1,
      keyed: 0,
      bobs: undefined,
    };
    const nodes = ["shared", "bobs", "team", "desk", "keyed"];
    expect(placementOrder(nodes, (node) => tiers[node])).toEqual([
      "keyed",
      "desk",
      "team",
      "shared",
    ]);
    expect(
      placementOrder(nodes, (node) => tiers[node], { strict: true }),
    ).toEqual(["keyed"]);
  });
});
