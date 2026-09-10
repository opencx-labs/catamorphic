import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { correlationAttributes, withTelemetryContext } from "@catamorphic/otel";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import { AgentTurnsService } from "../services/agent-turns-service.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { CodingAgentRegistry } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0055: scoped identities may open sessions on the project agents their
 * scope names — and on nothing else — and the harness receives the caller
 * plus the caller's tool-policy layers (workflow allowlist by tool name on
 * the project tools server, the agent ref's own narrowing per connector).
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_scoped_sessions_${crypto.randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

const unusedSandboxProvider = new Proxy({} as SandboxProvider, {
  get(_target, prop) {
    if (prop === "workspaceRoot") return "/unused";
    return () => {
      throw new Error(`SandboxProvider.${String(prop)} must not be called`);
    };
  },
});

/** A host-execution provider that records what core hands it. */
class RecordingProvider implements CodingAgentProvider {
  readonly name: string;
  readonly starts: StartSessionOpts[] = [];
  readonly correlations: ReturnType<typeof correlationAttributes>[] = [];
  readonly turns: Array<TurnOptions | undefined> = [];
  constructor(name: string) {
    this.name = name;
  }
  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    this.starts.push(opts);
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }
  async *sendMessage(
    _session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    this.turns.push(opts);
    this.correlations.push(correlationAttributes());
    if (message === "partial then fail") {
      yield { type: "text", content: "I finished the useful part." };
      yield { type: "error", content: "Provider connection closed" };
      yield { type: "done" };
      return;
    }
    yield { type: "text", content: `echo: ${message}` };
    yield { type: "done" };
  }
  async dispose(): Promise<void> {}
}

describeIf("scoped agent sessions (ADR 0055)", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projectId: string;
  let csm: RecordingProvider;
  let sales: RecordingProvider;
  let personal: RecordingProvider;
  let viewer: Identity;
  let admin: Identity;
  let csmAgentId: string;
  let salesAgentId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-scoped-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    const rootPath = path.join(tmpDir, "brain");
    await fs.mkdir(rootPath, { recursive: true });
    const project = await projects.create(root, { name: "brain" });
    projectId = project.id;
    csmAgentId = `project:${projectId}:csm`;
    salesAgentId = `project:${projectId}:sales`;

    csm = new RecordingProvider("csm-harness");
    sales = new RecordingProvider("sales-harness");
    personal = new RecordingProvider("personal-harness");
    const registered = new Map([
      [
        csmAgentId,
        { id: csmAgentId, provider: csm, topology: "native" as const },
      ],
      [
        salesAgentId,
        { id: salesAgentId, provider: sales, topology: "native" as const },
      ],
      [
        "personal",
        { id: "personal", provider: personal, topology: "native" as const },
      ],
    ]);
    const registry: CodingAgentRegistry = {
      defaultAgentId: () => "personal",
      get: (id) => registered.get(id),
      list: () => [...registered.values()],
    };
    const executionEnvironments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      testEnvironmentProvider(unusedSandboxProvider),
    );
    sessions = new AgentSessionsService(db, {
      hostId: "scope-test-host",
      projectManager,
      codingAgents: registry,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      nativeAgentCheckout: { resolve: () => rootPath },
      // The project's tool roster: two tools, one renamed via its trigger.
      mcpToolNames: async () =>
        new Map([
          ["crm_lookup", "crm.lookup"],
          ["docs_search", "docs.search"],
          ["crm_update", "crm.update"],
        ]),
    });

    viewer = {
      ...root,
      externalUserId: "csm-alice",
      executionScope: [{ projectId, name: "local" }],
      scope: [
        {
          kind: "agent",
          projectId,
          name: "csm",
          toolPolicies: { Slack: { default: "ask", tools: { post: "deny" } } },
        },
        { kind: "workflow", projectId, name: "crm.lookup" },
        { kind: "workflow", projectId, name: "docs.search" },
      ],
    };
    admin = {
      ...root,
      externalUserId: "admin-bob",
      executionScope: [{ projectId, name: "local" }],
      scope: [{ kind: "project", projectId }],
    };
  });

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads transcript and execution from one snapshot while another connection settles", async () => {
    if (!db) throw new Error("unreachable");
    const database = db;
    const session = await sessions.create(root, projectId);
    const receipt = await sessions.turns.deliver({
      sessionId: session.id,
      content: "Work",
      author: { kind: "user", externalUserId: root.externalUserId },
      mode: "next_turn",
    });
    await sessions.turns.claimNextForSession({
      sessionId: session.id,
      workerId: "snapshot-test",
    });
    const reply = await database
      .insertInto("agent_messages")
      .values({
        session_id: session.id,
        role: "assistant",
        content: "Working",
        author_kind: "agent",
        author_payload: { kind: "agent", sessionId: session.id, agentId: null },
        metadata: { status: "in_progress" },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const execution = AgentTurnsService.prototype.execution;
    const spy = vi
      .spyOn(AgentTurnsService.prototype, "execution")
      .mockImplementationOnce(async function (this: AgentTurnsService, input) {
        await database.transaction().execute(async (trx) => {
          await trx
            .updateTable("agent_messages")
            .set({ content: "Finished", metadata: { status: "completed" } })
            .where("id", "=", reply.id)
            .execute();
          await trx
            .updateTable("agent_turns")
            .set({
              status: "completed",
              result_message_id: reply.id,
              lease_token: null,
              lease_owner: null,
              lease_expires_at: null,
            })
            .where("id", "=", receipt.turnId)
            .execute();
        });
        return execution.call(this, input);
      });
    try {
      const snapshot = await sessions.get(root, projectId, session.id);
      expect(snapshot.execution?.status).toBe("running");
      expect(snapshot.messages.at(-1)?.content).toBe("Working");
      const fresh = await sessions.get(root, projectId, session.id);
      expect(fresh.execution?.status).toBe("completed");
      expect(fresh.messages.at(-1)?.content).toBe("Finished");
    } finally {
      spy.mockRestore();
    }
  });

  it("a viewer opens sessions only on the agents its scope names", async () => {
    await expect(
      sessions.create(viewer, projectId, { agentId: salesAgentId }),
    ).rejects.toThrow(AccessDeniedError);
    // A bare create resolves a permitted catalog default, never a personal agent.
    expect((await sessions.create(viewer, projectId)).agentId).toBe(csmAgentId);
    await expect(
      sessions.create(viewer, projectId, { agentId: "personal" }),
    ).rejects.toThrow(AccessDeniedError);
    const session = await sessions.create(viewer, projectId, {
      agentId: csmAgentId,
      source: "slack",
    });
    expect(session.agentId).toBe(csmAgentId);
    expect(session.source).toBe("slack");
    // ...and cannot switch it to an agent outside the scope.
    await expect(
      sessions.update(viewer, projectId, session.id, { agentId: salesAgentId }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("a scope without agents has no session surface at all", async () => {
    const noAgents: Identity = {
      ...root,
      externalUserId: "nobody",
      scope: [{ kind: "workflow", projectId, name: "crm.lookup" }],
    };
    await expect(sessions.list(noAgents, projectId)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it("a builder (project ref) uses any agent, and sees every session", async () => {
    await sessions.create(admin, projectId, { agentId: salesAgentId });
    await sessions.create(admin, projectId);
    const all = await sessions.list(admin, projectId);
    expect(all.total).toBeGreaterThanOrEqual(3);
  });

  it("a viewer lists and reads only its own sessions", async () => {
    const mine = await sessions.list(viewer, projectId);
    expect(mine.items.every((s) => s.externalUserId === "csm-alice")).toBe(
      true,
    );
    expect(mine.items.every((s) => s.agentId === csmAgentId)).toBe(true);
    const admins = await sessions.list(admin, projectId);
    const foreign = admins.items.find((s) => s.externalUserId === "admin-bob");
    if (!foreign) throw new Error("expected an admin session");
    // Uniform denial — no existence oracle for foreign session ids.
    await expect(sessions.get(viewer, projectId, foreign.id)).rejects.toThrow(
      AccessDeniedError,
    );
    // Another CSM with the same role sees none of Alice's conversations.
    const other: Identity = { ...viewer, externalUserId: "csm-carol" };
    expect((await sessions.list(other, projectId)).total).toBe(0);
  });

  it("persists an agent-owned todo snapshot with stable item ids", async () => {
    const session = await sessions.create(viewer, projectId, {
      agentId: csmAgentId,
    });
    const created = await sessions.replaceTodos(viewer, projectId, session.id, [
      {
        title: "Inspect the project",
        description: "Find the existing implementation and its tests.",
        status: "completed",
      },
      {
        title: "Implement the change",
        description: "Keep the public API and generated client in sync.",
        status: "in_progress",
      },
    ]);
    expect(created).toMatchObject([
      { title: "Inspect the project", status: "completed" },
      { title: "Implement the change", status: "in_progress" },
    ]);
    expect(created.every((todo) => todo.id.length > 0)).toBe(true);

    const updated = await sessions.replaceTodos(viewer, projectId, session.id, [
      {
        ...created[1]!,
        description: "Implementation is ready; run focused verification.",
        status: "completed",
      },
    ]);
    expect(updated).toEqual([
      {
        ...created[1],
        description: "Implementation is ready; run focused verification.",
        status: "completed",
      },
    ]);
    expect((await sessions.get(viewer, projectId, session.id)).todos).toEqual(
      updated,
    );

    const foreign = { ...viewer, externalUserId: "csm-carol" };
    await expect(
      sessions.replaceTodos(foreign, projectId, session.id, []),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("uses the same session gate for ownership and exact project-agent scope", async () => {
    const own = await sessions.create(viewer, projectId, {
      agentId: csmAgentId,
    });
    const foreign = { ...viewer, externalUserId: "csm-carol" };
    const wrongAgent = {
      ...viewer,
      scope: [{ kind: "agent" as const, projectId, name: "sales" }],
    };
    const documentOnly = {
      ...viewer,
      scope: [{ kind: "document" as const, projectId, path: "notes.md" }],
    };
    const workflowOnly = {
      ...viewer,
      scope: [{ kind: "workflow" as const, projectId, name: "crm.lookup" }],
    };

    await sessions.assertSession(viewer, projectId, own.id);
    for (const caller of [foreign, wrongAgent, documentOnly, workflowOnly]) {
      await expect(
        sessions.assertSession(caller, projectId, own.id),
      ).rejects.toThrow(AccessDeniedError);
    }
  });

  it("the harness receives the caller and the caller's tool-policy layers", async () => {
    const session = await sessions.create(viewer, projectId, {
      agentId: csmAgentId,
    });
    await sessions.sendMessage(viewer, projectId, session.id, "hello");
    const start = csm.starts.at(-1);
    if (!start) throw new Error("provider never started");
    expect(start.caller).toEqual(viewer);
    // Project tools server: only the WORKFLOW tools outside the scope are
    // denied (by TOOL name); the documents/skills/ask surface and the poll
    // tool authorize themselves at the endpoint and stay reachable.
    expect(start.toolPolicies?.catamorphic).toEqual([
      { default: "allow", tools: { crm_update: "deny" } },
    ]);
    // The agent ref's own narrowing, keyed by normalized server key, with
    // narrowing-layer semantics (explicit default kept).
    expect(start.toolPolicies?.slack).toEqual([
      { default: "ask", tools: { post: "deny" } },
    ]);
    // Refreshed per turn, so a later grant change reaches the next call.
    expect(csm.turns.at(-1)?.toolPolicies).toEqual(start.toolPolicies);
  });

  it("builders get no caller layers (nothing to narrow)", async () => {
    const session = await sessions.create(admin, projectId, {
      agentId: salesAgentId,
    });
    await sessions.sendMessage(admin, projectId, session.id, "hi");
    const start = sales.starts.at(-1);
    expect(start?.caller).toEqual(admin);
    // An EMPTY map, not none: it replaces whatever a previous caller left.
    expect(start?.toolPolicies).toEqual({});
    expect(sales.turns.at(-1)?.toolPolicies).toEqual({});
  });

  it("applies per-session model and effort overrides to the harness", async () => {
    const created = await sessions.create(admin, projectId, {
      agentId: salesAgentId,
    });
    const configured = await sessions.update(admin, projectId, created.id, {
      model: "test/model-v2",
      effort: "high",
    });
    expect(configured.model).toBe("test/model-v2");
    expect(configured.modelEffort).toBe("high");

    await sessions.sendMessage(admin, projectId, created.id, "configured");
    expect(sales.turns.at(-1)?.model).toBe("test/model-v2");
    expect(sales.turns.at(-1)?.effort).toBe("high");

    const switched = await sessions.update(admin, projectId, created.id, {
      agentId: csmAgentId,
    });
    expect(switched.model).toBeNull();
  });

  it("reconstructs each durable turn scope without the drainer caller's workflow or job IDs", async () => {
    if (!db) throw new Error("unreachable");
    const provider = new NodeTracerProvider();
    provider.register();
    try {
      const session = await sessions.create(admin, projectId, {
        agentId: salesAgentId,
      });
      const offset = sales.correlations.length;
      await withTelemetryContext(
        {
          attributes: {
            "catamorphic.run.id": "unrelated-run",
            "catamorphic.queue.job.id": "unrelated-job",
            "catamorphic.agent.turn.id": "unrelated-turn",
          },
        },
        async () => {
          await sessions.sendMessage(admin, projectId, session.id, "one");
          await sessions.sendMessage(admin, projectId, session.id, "two");
        },
      );
      const turns = await db
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", session.id)
        .execute();
      const observed = sales.correlations.slice(offset);
      expect(observed).toHaveLength(2);
      expect(
        new Set(
          observed.map((attributes) => attributes["catamorphic.agent.turn.id"]),
        ),
      ).toEqual(new Set(turns.map((turn) => turn.id)));
      for (const attributes of observed) {
        expect(attributes).toMatchObject({
          "catamorphic.tenant.id": admin.tenantId,
          "user.id": admin.externalUserId,
          "catamorphic.project.id": projectId,
          "catamorphic.agent.session.id": session.id,
        });
        expect(attributes["catamorphic.run.id"]).toBeUndefined();
        expect(attributes["catamorphic.queue.job.id"]).toBeUndefined();
      }
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
    }
  });

  it("keeps partial assistant prose separate from a fatal provider error", async () => {
    const session = await sessions.create(admin, projectId, {
      agentId: salesAgentId,
    });

    const failed = await sessions.sendMessage(
      admin,
      projectId,
      session.id,
      "partial then fail",
    );

    expect(failed.content).toBe("Provider connection closed");
    expect(failed.metadata).toEqual(
      expect.objectContaining({
        status: "failed",
        partialContent: "I finished the useful part.",
      }),
    );
  });

  it("revoking the agent from the scope closes the door mid-conversation", async () => {
    const session = await sessions.create(viewer, projectId, {
      agentId: csmAgentId,
    });
    const revoked: Identity = {
      ...viewer,
      scope: viewer.scope?.filter((ref) => ref.kind !== "agent"),
    };
    await expect(
      sessions.sendMessage(revoked, projectId, session.id, "still there?"),
    ).rejects.toThrow(AccessDeniedError);
  });
});
