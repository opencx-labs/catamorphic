import type { DB } from "@catamorphic/db";
import type { CreateSandboxOpts, SandboxProvider } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { withAllocationSandboxPolicy } from "../services/allocation-sandbox-provider.js";
import type { ExecutionAllocation } from "../services/execution-allocations-service.js";

/** No volumes here, so the policy never asks the database for holds. */
const db = new Proxy({} as Kysely<DB>, {
  get() {
    throw new Error("The database must not be used");
  },
});

class MemberMachine {
  readonly workspaceRoot = "/workspace";
  readonly created: CreateSandboxOpts[] = [];
  async createSandbox(opts: CreateSandboxOpts) {
    this.created.push(opts);
    return {
      id: "vm-1",
      providerId: "vm-1",
      sandboxType: "execution" as const,
      status: "started" as const,
    };
  }
  async stopSandbox(id: string) {
    return this.workspaceRoot + id;
  }
}

function allocation(
  sandbox: ExecutionAllocation["policy"]["sandbox"],
): ExecutionAllocation {
  return {
    id: "allocation-1",
    projectId: "project-1",
    environmentName: "laptop",
    bindingId: "client:runner",
    workloadKind: "agent",
    rootWorkloadId: "session-1",
    workerNodeId: null,
    policy: {
      binding: {
        id: "client:runner",
        label: "This machine",
        trust: "local",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: ["network.egress", "images", "images.build"],
        resources: {},
      },
      requirements: { workload: "agent" },
      ...(sandbox ? { sandbox } : {}),
    },
    status: "active",
    releaseReason: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    releasedAt: null,
  };
}

describe("withAllocationSandboxPolicy", () => {
  it("boots the Environment's image on a member's machine, whatever the caller asks", async () => {
    const machine = new MemberMachine();
    const image = {
      kind: "dockerfile" as const,
      path: ".work/images/harness.Dockerfile",
      content: "FROM node:22\n",
      digest: "abc",
    };
    const provider = withAllocationSandboxPolicy({
      db,
      allocation: allocation({ image, egress: { mode: "open" } }),
      provider: machine as unknown as SandboxProvider,
    });
    await provider.createSandbox({ image: { kind: "oci", reference: "x" } });
    expect(machine.created).toEqual([{ image, egress: { mode: "open" } }]);
    // Everything else is the machine's own, bound to it.
    expect(provider.workspaceRoot).toBe("/workspace");
    await expect(provider.stopSandbox("vm-1")).resolves.toBe("/workspacevm-1");
  });

  it("returns the provider itself when the Environment sets nothing", () => {
    const machine = new MemberMachine() as unknown as SandboxProvider;
    expect(
      withAllocationSandboxPolicy({
        db,
        allocation: allocation(undefined),
        provider: machine,
      }),
    ).toBe(machine);
  });
});
