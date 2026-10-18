import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import {
  type CreateSandboxOpts,
  dockerfileDigest,
  type EnvironmentRuntimeBinding,
  environmentSatisfies,
  type SandboxEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  allocationSandboxProvider,
  withAllocationSandboxPolicy,
} from "../services/allocation-sandbox-provider.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import {
  EnvironmentIncompatibleError,
  EnvironmentPolicyInvalidError,
  ExecutionEnvironmentsService,
} from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};
const DOCKERFILE = "FROM docker:dind\nRUN apk add --no-cache git bash nodejs\n";

/**
 * A machine with the given capabilities, recording what sandboxes get and
 * every switch of their egress.
 */
function machine(capabilities: string[]) {
  const created: CreateSandboxOpts[] = [];
  const switched: Array<{ sandboxId: string; egress: SandboxEgress }> = [];
  const provider = new Proxy({} as SandboxProvider, {
    get(_target, prop) {
      if (prop === "workspaceRoot") return "/workspace";
      if (prop === "setEgress")
        return async (args: { sandboxId: string; egress: SandboxEgress }) => {
          switched.push(args);
        };
      if (prop === "createSandbox")
        return async (opts: CreateSandboxOpts) => {
          created.push(opts);
          return {
            id: "sb-1",
            providerId: "sb-1",
            sandboxType: "execution",
            status: "started",
          };
        };
      return undefined;
    },
  });
  const binding: EnvironmentRuntimeBinding = {
    descriptor: {
      id: `node-${capabilities.join("-") || "plain"}`,
      label: "machine",
      trust: "managed",
      isolation: "sandbox",
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities: ["network.egress", ...capabilities],
      resources: {},
    },
    sandboxProvider: provider,
  };
  return { created, switched, binding };
}

describe("Environment sandboxes from admission to creation (ADR 0176)", () => {
  let projectsPath: string;
  let projectId: string;
  let projectManager: ProjectManager;

  beforeAll(async () => {
    projectsPath = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-img-"));
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    projectManager = new ProjectManager(new FsBackend(projectsPath));
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(identity, { name: "Review" })).id;
    const repo = await projectManager.open(identity.tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            review: {
              workloads: ["agent"],
              image: ".work/images/review.Dockerfile",
              requirements: { containers: true },
              network: { egress: "allowlist", allow: ["github.com"] },
              approvals: { waitMinutes: 45 },
            },
            missing: {
              workloads: ["agent"],
              image: ".work/images/missing.Dockerfile",
            },
            install: {
              workloads: ["agent"],
              network: { egress: "gateway" },
              setup: {
                command: "pnpm install --frozen-lockfile",
                network: { allow: ["registry.npmjs.org"] },
              },
            },
          },
          defaultEnvironment: "review",
        }),
      );
      await repo.writeFile(".work/images/review.Dockerfile", DOCKERFILE);
      await repo.commit("Review Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await fs.rm(projectsPath, { recursive: true, force: true });
  });

  const environments = (bindings: EnvironmentRuntimeBinding[]) =>
    new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      {
        get: ({ requirements }) =>
          bindings.find(
            (binding) =>
              !requirements ||
              environmentSatisfies(binding.descriptor, requirements).compatible,
          ),
      },
      undefined,
      { gatewayHosts: ["work.acme.com"] },
    );

  it("admits only onto a machine that builds images, runs containers and enforces egress", async () => {
    const plain = machine([]);
    await expect(
      environments([plain.binding]).admit({
        identity,
        projectId,
        environment: "review",
        requirements: { workload: "agent", topology: "controller" },
      }),
    ).rejects.toThrow(/No machine|incompatible/);

    const capable = machine([
      "images",
      "images.build",
      "containers",
      "network.policy",
    ]);
    const admission = await environments([
      plain.binding,
      capable.binding,
    ]).admit({
      identity,
      projectId,
      environment: "review",
      requirements: { workload: "agent", topology: "controller" },
    });
    expect(admission.binding.id).toBe(capable.binding.descriptor.id);
    expect(admission.sandbox).toEqual({
      containers: true,
      egress: { mode: "allowlist", allow: ["work.acme.com", "github.com"] },
      image: {
        kind: "dockerfile",
        path: ".work/images/review.Dockerfile",
        content: DOCKERFILE,
        digest: dockerfileDigest(DOCKERFILE),
      },
    });
    expect(admission.approvals).toEqual({ waitMinutes: 45 });

    // The Allocation fixes what its sandbox gets; the caller cannot widen it.
    const allocation = await new ExecutionAllocationsService(db).create({
      identity,
      projectId,
      environmentName: admission.environmentName,
      workloadKind: "agent",
      rootWorkloadId: crypto.randomUUID(),
      policy: {
        binding: admission.binding,
        requirements: admission.effectiveRequirements,
        sandbox: admission.sandbox,
      },
    });
    const provider = allocationSandboxProvider({
      db,
      allocation,
      provider: capable.binding.sandboxProvider!,
    });
    await provider.createSandbox({
      egress: { mode: "open" },
      containers: false,
      image: { kind: "oci", reference: "attacker/image" },
    });
    expect(capable.created[0]).toMatchObject({
      image: { kind: "dockerfile", digest: dockerfileDigest(DOCKERFILE) },
      containers: true,
      egress: { mode: "allowlist", allow: ["work.acme.com", "github.com"] },
    });
  });

  it("admits a setup with its own network only where egress switches, fixing both policies (ADR 0257)", async () => {
    const fixed = machine(["network.policy"]);
    await expect(
      environments([fixed.binding]).admit({
        identity,
        projectId,
        environment: "install",
        requirements: { workload: "agent", topology: "controller" },
      }),
    ).rejects.toThrow(/No machine|incompatible/);
    expect(
      environmentSatisfies(fixed.binding.descriptor, {
        workload: "agent",
        capabilities: ["network.policy", "network.setup"],
      }),
    ).toEqual({
      compatible: false,
      reasons: ["Capability 'network.setup' is not available"],
    });

    const switching = machine(["network.policy", "network.setup"]);
    const admission = await environments([
      fixed.binding,
      switching.binding,
    ]).admit({
      identity,
      projectId,
      environment: "install",
      requirements: { workload: "agent", topology: "controller" },
    });
    expect(admission.binding.id).toBe(switching.binding.descriptor.id);
    const own: SandboxEgress = { mode: "allowlist", allow: ["work.acme.com"] };
    const setup: SandboxEgress = {
      mode: "allowlist",
      allow: ["work.acme.com", "registry.npmjs.org"],
    };
    expect(admission.sandbox).toEqual({ egress: own, setupEgress: setup });
    expect(admission.setup).toEqual({
      command: "pnpm install --frozen-lockfile",
      timeoutMinutes: 30,
      network: { allow: ["registry.npmjs.org"] },
    });

    // A switch goes only to what the Allocation fixed, compared by value.
    const allocation = await new ExecutionAllocationsService(db).create({
      identity,
      projectId,
      environmentName: admission.environmentName,
      workloadKind: "agent",
      rootWorkloadId: crypto.randomUUID(),
      policy: {
        binding: admission.binding,
        requirements: admission.effectiveRequirements,
        sandbox: admission.sandbox,
      },
    });
    const sandboxProvider = switching.binding.sandboxProvider;
    if (!sandboxProvider) throw new Error("unreachable");
    for (const provider of [
      allocationSandboxProvider({ db, allocation, provider: sandboxProvider }),
      withAllocationSandboxPolicy({
        db,
        allocation,
        provider: sandboxProvider,
      }),
    ]) {
      switching.switched.length = 0;
      const { providerId } = await provider.createSandbox({});
      expect(switching.created.at(-1)?.egress).toEqual(own);
      await provider.setEgress?.({
        sandboxId: providerId,
        egress: { mode: "allowlist", allow: [...setup.allow].reverse() },
      });
      await provider.setEgress?.({ sandboxId: providerId, egress: own });
      for (const wider of [
        { mode: "open" as const },
        {
          mode: "allowlist" as const,
          allow: [...setup.allow, "attacker.example"],
        },
      ])
        await expect(
          provider.setEgress?.({ sandboxId: providerId, egress: wider }),
        ).rejects.toThrow("fixed at admission");
      expect(switching.switched.map((entry) => entry.egress)).toEqual([
        { mode: "allowlist", allow: [...setup.allow].reverse() },
        own,
      ]);
    }
  });

  it("explains a missing Dockerfile", async () => {
    const capable = machine(["images", "images.build"]);
    await expect(
      environments([capable.binding]).admit({
        identity,
        projectId,
        environment: "missing",
        requirements: { workload: "agent", topology: "controller" },
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof EnvironmentIncompatibleError &&
        error.message.includes(
          ".work/images/missing.Dockerfile does not exist",
        ),
    );
  });

  it("refuses work in a project whose policy names an undeclared default, as the project's error", async () => {
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    const broken = (await projects.create(identity, { name: "Broken" })).id;
    const repo = await projectManager.open(identity.tenantId, broken);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: { laptop: { device: "member", workloads: ["agent"] } },
          defaultEnvironment: "default",
        }),
      );
      await repo.commit("Name a missing default", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
    await expect(
      environments([machine([]).binding]).admit({
        identity,
        projectId: broken,
        requirements: { workload: "agent", topology: "controller" },
      }),
    ).rejects.toBeInstanceOf(EnvironmentPolicyInvalidError);
  });
});
