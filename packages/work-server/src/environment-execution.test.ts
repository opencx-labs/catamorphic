import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import {
  AgentTurnUnsettledError,
  type Identity,
  type RegisteredCodingAgent,
} from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type EnvironmentRuntimeBinding,
  followProcess,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import {
  createCatamorphic,
  defineStaticEnvironments,
  FsBackend,
  ProjectManager,
  ResultRejectedError,
  startClientRunner,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { expect, it } from "vitest";
import { replyOf } from "./test-support.js";

/**
 * A host harness that answers with where it runs: `pwd` in the session's
 * sandbox, through the provider core hands it (ADR 0198).
 */
class WorkspaceAgent {
  /** The sandbox each session ran in, by session id. */
  readonly sandboxes = new Map<string, string>();
  readonly agent: RegisteredCodingAgent = {
    id: "workspace-agent",
    topology: "controller",
    harness: { placement: "host", adapter: this.adapter() },
  };

  private adapter(): HarnessAdapter {
    return {
      id: "workspace-agent",
      capabilities: () => ({
        steer: false,
        interrupt: true,
        retry: false,
        fork: false,
        rollback: false,
        questions: false,
        approvals: false,
        elicitations: false,
        subagents: false,
        streamsText: false,
        streamsReasoning: false,
        nativeState: "none",
        ids: { thread: "strong", turn: "none", item: "none" },
      }),
      start: (attempt, host, local) => {
        const run = async () => {
          host.emit({
            type: "thread",
            ref: { id: attempt.sessionId, strength: "strong" },
          });
          const sandbox = local?.sandbox;
          if (!isSandbox(sandbox))
            throw new Error("Missing allocated provider");
          this.sandboxes.set(attempt.sessionId, sandbox.sandboxId);
          const result = await sandbox.provider.executeCommand(
            sandbox.sandboxId,
            "pwd",
            { cwd: sandbox.workingDirectory },
          );
          host.emit({
            type: "item.started",
            key: "reply",
            status: "completed",
            item: {
              kind: "assistant_message",
              text: result.result.trim(),
              agentId: null,
            },
          });
          host.emit({ type: "turn.completed", status: "completed" });
        };
        const finished = run().catch((error: unknown) =>
          host.emit({
            type: "turn.completed",
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
        return { steer: async () => false, interrupt: () => {}, finished };
      },
    };
  }
}

function isSandbox(value: unknown): value is {
  provider: Pick<SandboxProvider, "executeCommand">;
  sandboxId: string;
  workingDirectory: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "sandboxId" in value &&
    typeof value.sandboxId === "string" &&
    "workingDirectory" in value &&
    typeof value.workingDirectory === "string"
  );
}

/** The queued and running turns of a session. */
async function pendingTurns(db: Kysely<DB>, sessionId: string) {
  return db
    .selectFrom("agent_turns")
    .select("status")
    .where("session_id", "=", sessionId)
    .where("status", "not in", [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ])
    .orderBy("ordinal")
    .execute();
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
        labels: { machine: index === 0 ? "a" : "b" },
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
    codingAgent: agent.agent,
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
      ".work/project.json",
      JSON.stringify({
        environments: {
          a: { pool: { machine: "a" }, workloads: ["agent"] },
          b: { pool: { machine: "b" }, workloads: ["agent"] },
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
    const resultB = replyOf(
      await sessions.sendMessage(identity, project.id, onB.id, "Where am I?"),
    );
    expect(resultB.content).toContain(path.join(directory, "machine-b"));
    expect(await fs.readdir(path.join(directory, "machine-a"))).toEqual([]);
    const onA = await sessions.create(identity, project.id, {
      environment: "a",
    });
    const resultA = replyOf(
      await sessions.sendMessage(identity, project.id, onA.id, "Where am I?"),
    );
    expect(resultA.content).toContain(path.join(directory, "machine-a"));
    expect(agent.sandboxes.get(onA.id)).not.toBe(agent.sandboxes.get(onB.id));
    // A currently scoped admin no longer has permission to execute on B.
    const revoked: Identity = {
      ...identity,
      scope: [{ kind: "agent", projectId: project.id, name: "*" }],
      projectPermissions: [{ projectId: project.id, permission: "*" }],
      executionScope: [{ projectId: project.id, name: "a" }],
    };
    const denied = replyOf(
      await sessions.sendMessage(revoked, project.id, onB.id, "Do not run"),
    );
    expect(denied.turn.status).toBe("failed");
    expect(denied.content).toContain("may not use Environment");
    // Changing the Environment's pool cannot move an existing session.
    const changed = await cat.core.projectManager.open(
      identity.tenantId,
      project.id,
    );
    await changed.writeFile(
      ".work/project.json",
      JSON.stringify({
        environments: {
          b: { pool: { machine: "a" }, workloads: ["agent"] },
        },
      }),
    );
    await changed.dispose();
    const rebound = replyOf(
      await sessions.sendMessage(identity, project.id, onB.id, "Do not move"),
    );
    expect(rebound.turn.status).toBe("failed");
    expect(rebound.content).toContain("No machine for Environment 'b'");
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
    codingAgent: agent.agent,
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
      ".work/project.json",
      JSON.stringify({
        environments: {
          personal: { device: "member", workloads: ["agent"] },
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
      processes: true,
      capabilities: ["images", "images.build"],
    });
    await expect(
      service.poll({
        ...lease,
        pollId: randomUUID(),
        identity: { ...identity, externalUserId: "someone-else" },
      }),
    ).rejects.toThrow();
    runner = startClientRunner({
      provider,
      transport: {
        renew: () => service.renew({ ...lease, identity }),
        poll: ({ pollId, max }) =>
          service.poll({ ...lease, identity, pollId, max }),
        complete: async (receipt) => {
          // The receipt route's bound on an error message.
          if ((receipt.error?.length ?? 0) > 4000)
            throw new ResultRejectedError("Receipt refused: error too long");
          await service.complete({ ...lease, identity, ...receipt });
        },
        disconnect: () => service.disconnect({ ...lease, identity }),
      },
    });
    const session = await sessions.create(identity, project.id, {
      environment: "personal",
    });
    const result = replyOf(
      await sessions.sendMessage(
        identity,
        project.id,
        session.id,
        "Where am I?",
      ),
    );
    expect(result.content).toContain(path.join(directory, "employee-machine"));
    // Background processes run on the member's machine, followed through
    // short queued operations (ADR 0174).
    const member = await service.binding({
      tenantId: identity.tenantId,
      ownerUserId: identity.externalUserId,
      projectId: project.id,
      clientRunnerId: identity.clientRunnerId,
    });
    // What its sandboxes can be given places image Environments there.
    expect(member?.descriptor.capabilities).toEqual([
      "network.egress",
      "images",
      "images.build",
    ]);
    const processes = member?.sandboxProvider?.processes;
    const sandboxId = agent.sandboxes.get(session.id);
    if (!processes || !sandboxId) throw new Error("Member processes missing");
    const started = await processes.startProcess({
      sandboxId,
      command: "echo from-member; sleep 0.2; exit 4",
    });
    await expect(
      followProcess({
        processes,
        sandboxId,
        processId: started.processId,
        cursor: 0,
        timeoutMs: 20_000,
      }),
    ).resolves.toMatchObject({
      output: "from-member\n",
      status: "exited",
      exitCode: 4,
    });
    // Output Postgres cannot store as is (NUL) still arrives.
    const binary = await processes.startProcess({
      sandboxId,
      command: "printf 'a\\0b'",
    });
    await expect(
      followProcess({
        processes,
        sandboxId,
        processId: binary.processId,
        cursor: 0,
        timeoutMs: 20_000,
      }),
    ).resolves.toMatchObject({ output: "a�b", status: "exited" });
    // A failure with a long message fails that operation, not the runner.
    await expect(
      member.sandboxProvider?.downloadFile(
        sandboxId,
        `/workspace/${"missing-".repeat(700)}`,
      ),
    ).rejects.toThrow();
    // A read waiting for output does not hold up other operations.
    const quiet = await processes.startProcess({
      sandboxId,
      command: "sleep 15",
    });
    const waiting = processes.readProcessOutput({
      sandboxId,
      processId: quiet.processId,
      waitMs: 12_000,
    });
    const listedAt = Date.now();
    await processes.listProcesses({ sandboxId });
    expect(Date.now() - listedAt).toBeLessThan(5_000);
    await processes.signalProcess({
      sandboxId,
      processId: quiet.processId,
      signal: "SIGKILL",
    });
    await waiting;
    const oldBinding = (
      await cat.core.executionAllocations.get({
        identity,
        allocationId: session.allocationId!,
      })
    )?.bindingId;
    const revoked: Identity = {
      ...identity,
      scope: [{ kind: "agent", projectId: project.id, name: "*" }],
      projectPermissions: [{ projectId: project.id, permission: "*" }],
      executionScope: [],
    };
    await expect(
      service.renew({ ...lease, identity: revoked }),
    ).rejects.toThrow();
    await runner.stop();
    runner = undefined;
    // With the runner away its chat's turn waits in the queue (ADR 0192);
    // nothing runs it elsewhere.
    await expect(
      sessions.sendMessage(identity, project.id, session.id, "Do not replay"),
    ).rejects.toMatchObject({
      name: AgentTurnUnsettledError.name,
      state: "queued",
    });
    expect(
      (await pendingTurns(db, session.id)).map((turn) => turn.status),
    ).toEqual(["queued"]);
    const reconnected = await service.register({
      identity,
      projectId: project.id,
      id: identity.clientRunnerId,
      environment: "personal",
      label: "Laptop",
      workspaceRoot: provider.workspaceRoot,
    });
    // A runner that does not say it runs processes is not offered them.
    expect(
      (
        await service.binding({
          tenantId: identity.tenantId,
          ownerUserId: identity.externalUserId,
          projectId: project.id,
          clientRunnerId: identity.clientRunnerId,
        })
      )?.sandboxProvider?.processes,
    ).toBeUndefined();
    expect(
      await service.binding({
        tenantId: identity.tenantId,
        ownerUserId: identity.externalUserId,
        projectId: project.id,
        allocationBindingId: oldBinding,
      }),
    ).toBeUndefined();
    // The machine is back under a new connection: its chat's workspace is
    // rebuilt there from the session branch, and the waiting turn runs.
    runner = startClientRunner({
      provider,
      transport: {
        renew: () => service.renew({ ...reconnected, identity }),
        poll: ({ pollId, max }) =>
          service.poll({ ...reconnected, identity, pollId, max }),
        complete: async (receipt) => {
          await service.complete({ ...reconnected, identity, ...receipt });
        },
        disconnect: () => service.disconnect({ ...reconnected, identity }),
      },
    });
    const back = replyOf(
      await sessions.sendMessage(
        identity,
        project.id,
        session.id,
        "Where am I?",
      ),
    );
    expect(back.content).toContain(path.join(directory, "employee-machine"));
    const ended = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("root_workload_id", "=", session.id)
      .orderBy("created_at")
      .execute();
    expect(ended).toEqual([
      { status: "released", release_reason: "connection_ended" },
      { status: "active", release_reason: null },
    ]);
    expect((await pendingTurns(db, session.id)).length).toBe(0);
  } finally {
    await runner?.stop();
    await cat.close();
    await db.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
