import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  AgentEvent,
  CodingAgentProvider,
  EnvironmentRuntimeBinding,
  ProviderSession,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import {
  createCatamorphic,
  defineStaticEnvironments,
  FsBackend,
  ProjectManager,
  startClientRunner,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { expect, it } from "vitest";

class WorkspaceAgent implements CodingAgentProvider {
  readonly name = "workspace-agent";
  readonly sessions = new Map<string, StartSessionOpts>();
  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    this.sessions.set(opts.sessionId, opts);
    return {
      sessionId: opts.sessionId,
      providerSessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }
  async *sendMessage(session: ProviderSession): AsyncIterable<AgentEvent> {
    const start = this.sessions.get(session.sessionId);
    if (!start?.sandboxProvider) throw new Error("Missing allocated provider");
    const result = await start.sandboxProvider.executeCommand(
      session.sandboxId,
      "pwd",
      { cwd: session.workingDirectory },
    );
    yield { type: "text", content: result.result.trim() };
    yield { type: "done" };
  }
  async dispose(): Promise<void> {}
}

it("an embedded host executes each session on its Allocation and rejects revoked placement", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-placement-"),
  );
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  const a = new LocalProcessSandboxProvider({
    root: path.join(directory, "machine-a"),
  });
  const b = new LocalProcessSandboxProvider({
    root: path.join(directory, "machine-b"),
  });
  const agent = new WorkspaceAgent();
  const runtimes: EnvironmentRuntimeBinding[] = [a, b].map(
    (sandboxProvider, index) => ({
      descriptor: {
        id: index === 0 ? "a" : "b",
        label: index === 0 ? "A" : "B",
        trust: "managed",
        isolation: "process",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [],
        resources: {},
      },
      sandboxProvider,
    }),
  );
  const cat = createCatamorphic({
    hostId: "embedded-authority",
    database: { db },
    storage: {
      projectManager: new ProjectManager(
        new FsBackend(path.join(directory, "projects")),
      ),
    },
    // No global sandbox provider: the Environment owns execution.
    environmentProvider: defineStaticEnvironments(runtimes),
    codingAgent: agent,
    projectSeeds: () => ({}),
    standingAgentPrompt: false,
  });
  try {
    await cat.migrate();
    const identity: Identity = {
      tenantId: randomUUID(),
      externalUserId: "member",
    };
    const project = await cat.core.projects.create(identity, {
      name: "Placement",
    });
    const repo = await cat.core.projectManager.open(
      identity.tenantId,
      project.id,
    );
    await repo.writeFile(
      ".catamorphic/project.json",
      JSON.stringify({
        environments: {
          a: { binding: "a", workloads: ["agent"] },
          b: { binding: "b", workloads: ["agent"] },
        },
        defaultEnvironment: "a",
      }),
    );
    await repo.commit("Configure execution", {
      name: "Member",
      email: "member@example.test",
    });
    await repo.dispose();
    const sessions = cat.core.agentSessions;
    if (!sessions)
      throw new Error("Agent sessions must not require a global provider");
    const onB = await sessions.create(identity, project.id, {
      environment: "b",
    });
    const resultB = await sessions.sendMessage(
      identity,
      project.id,
      onB.id,
      "Where am I?",
    );
    expect(resultB.content).toContain(path.join(directory, "machine-b"));
    expect(await fs.readdir(path.join(directory, "machine-a"))).toEqual([]);
    const onA = await sessions.create(identity, project.id, {
      environment: "a",
    });
    const resultA = await sessions.sendMessage(
      identity,
      project.id,
      onA.id,
      "Where am I?",
    );
    expect(resultA.content).toContain(path.join(directory, "machine-a"));
    expect(agent.sessions.get(onA.id)?.sandboxId).not.toBe(
      agent.sessions.get(onB.id)?.sandboxId,
    );
    // A currently scoped builder no longer has permission to execute on B.
    const revoked: Identity = {
      ...identity,
      scope: [{ kind: "project", projectId: project.id }],
      executionScope: [{ projectId: project.id, name: "a" }],
    };
    const denied = await sessions.sendMessage(
      revoked,
      project.id,
      onB.id,
      "Do not run",
    );
    expect(denied.metadata?.status).toBe("failed");
    expect(denied.content).toContain("may not use Environment");
    // Rebinding policy cannot move an existing session implicitly.
    const changed = await cat.core.projectManager.open(
      identity.tenantId,
      project.id,
    );
    await changed.writeFile(
      ".catamorphic/project.json",
      JSON.stringify({
        environments: { b: { binding: "a", workloads: ["agent"] } },
      }),
    );
    await changed.dispose();
    const rebound = await sessions.sendMessage(
      identity,
      project.id,
      onB.id,
      "Do not move",
    );
    expect(rebound.metadata?.status).toBe("failed");
    expect(rebound.content).toContain("binding changed");
  } finally {
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("an authenticated member executes on this machine and loses execution immediately when permission is revoked", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-client-"),
  );
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  const provider = new LocalProcessSandboxProvider({
    root: path.join(directory, "employee-machine"),
  });
  const agent = new WorkspaceAgent();
  const cat = createCatamorphic({
    hostId: "client-test",
    database: { db },
    storage: {
      projectManager: new ProjectManager(
        new FsBackend(path.join(directory, "projects")),
      ),
    },
    environmentProvider: defineStaticEnvironments([]),
    clientExecution: true,
    codingAgent: agent,
    projectSeeds: () => ({}),
    standingAgentPrompt: false,
  });
  let runner: ReturnType<typeof startClientRunner> | undefined;
  try {
    await cat.migrate();
    const identity: Identity = {
      tenantId: randomUUID(),
      externalUserId: "employee",
      clientRunnerId: randomUUID(),
    };
    const project = await cat.core.projects.create(identity, {
      name: "Company",
    });
    const repo = await cat.core.projectManager.open(
      identity.tenantId,
      project.id,
    );
    await repo.writeFile(
      ".catamorphic/project.json",
      JSON.stringify({
        environments: {
          personal: { binding: "this-machine", workloads: ["agent"] },
        },
        defaultEnvironment: "personal",
      }),
    );
    await repo.commit("Allow personal execution", {
      name: "Admin",
      email: "admin@example.test",
    });
    await repo.dispose();
    const service = cat.core.clientRunners;
    const sessions = cat.core.agentSessions;
    if (!service || !sessions || !identity.clientRunnerId)
      throw new Error("Client execution missing");
    const lease = await service.register({
      identity,
      projectId: project.id,
      id: identity.clientRunnerId,
      environment: "personal",
      label: "Laptop",
      workspaceRoot: provider.workspaceRoot,
    });
    await expect(
      service.poll({
        ...lease,
        identity: { ...identity, externalUserId: "someone-else" },
      }),
    ).rejects.toThrow();
    runner = startClientRunner({
      provider,
      transport: {
        renew: () => service.renew({ ...lease, identity }),
        poll: () => service.poll({ ...lease, identity }),
        complete: async (receipt) => {
          await service.complete({ ...lease, identity, ...receipt });
        },
        disconnect: () => service.disconnect({ ...lease, identity }),
      },
    });
    const session = await sessions.create(identity, project.id, {
      environment: "personal",
    });
    const result = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Where am I?",
    );
    expect(result.content).toContain(path.join(directory, "employee-machine"));
    const oldBinding = (
      await cat.core.executionAllocations.get({
        identity,
        allocationId: session.allocationId!,
      })
    )?.bindingId;
    const revoked: Identity = {
      ...identity,
      scope: [{ kind: "project", projectId: project.id }],
      executionScope: [],
    };
    await expect(
      service.renew({ ...lease, identity: revoked }),
    ).rejects.toThrow();
    await runner.stop();
    runner = undefined;
    const offline = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Do not replay",
    );
    expect(offline.metadata?.status).toBe("failed");
    await service.register({
      identity,
      projectId: project.id,
      id: identity.clientRunnerId,
      environment: "personal",
      label: "Laptop",
      workspaceRoot: provider.workspaceRoot,
    });
    expect(
      await service.binding({
        tenantId: identity.tenantId,
        externalUserId: identity.externalUserId,
        projectId: project.id,
        allocationBindingId: oldBinding,
      }),
    ).toBeUndefined();
  } finally {
    await runner?.stop();
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
