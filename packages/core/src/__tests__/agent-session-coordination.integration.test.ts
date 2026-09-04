import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { DbSandboxStore } from "../services/db-sandbox-store.js";
import { DevSandboxService } from "../services/dev-sandbox-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

class DeferredProvider implements CodingAgentProvider {
  readonly name = "deferred";
  private releaseSlow: (() => void) | undefined;
  private transientAttempts = 0;
  slowStarted: Promise<void> = Promise.resolve();
  private markSlowStarted: (() => void) | undefined;
  switchCheckout?: (session: ProviderSession) => string;

  constructor() {
    this.resetSlow();
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    if (message.includes("Recover delegated work")) {
      this.transientAttempts += 1;
      if (this.transientAttempts === 1) {
        yield {
          type: "error",
          content: "Temporarily unavailable",
          errorKind: "unavailable",
        };
        yield { type: "done" };
        return;
      }
    }
    if (message.includes("Prepare the Globex renewal deck")) {
      this.markSlowStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseSlow = resolve;
      });
    }
    if (message === "Switch checkout and edit") {
      const checkout = this.switchCheckout?.(session);
      if (checkout) {
        yield {
          type: "file_edit",
          content: "write",
          filePath: path.join(checkout, "result.md"),
        };
      }
    }
    yield { type: "done" };
  }

  release(): void {
    this.releaseSlow?.();
    this.resetSlow();
  }

  interrupt(): void {
    this.release();
  }

  async dispose(): Promise<void> {}

  private resetSlow(): void {
    this.slowStarted = new Promise<void>((resolve) => {
      this.markSlowStarted = resolve;
    });
  }
}

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_coordination";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "builder",
};
const unusedSandbox = new Proxy(
  { workspaceRoot: "/unused" } as SandboxProvider,
  {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {
        throw new Error(`Unexpected sandbox call: ${String(property)}`);
      };
    },
  },
);

describe("agent session coordination", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projects: ProjectsService;
  let provider: DeferredProvider;
  const checkpointedSessions: string[] = [];
  const checkpointedTurns: Array<{
    sessionId: string;
    workingDirectory: string;
  }> = [];
  const settledTurns: Array<{
    sessionId: string;
    workingDirectory: string;
    changedFiles: string[];
    notification?: { title?: string; body?: string };
  }> = [];
  const checkoutBySession = new Map<string, string>();

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-core-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    provider = new DeferredProvider();
    const registeredAgent = (
      id: string,
      input: Pick<RegisteredCodingAgent, "privilege" | "delegation"> = {},
    ): RegisteredCodingAgent => ({
      id,
      provider,
      topology: "native",
      ...input,
    });
    const agents = new Map(
      [
        registeredAgent("worker"),
        registeredAgent("small", { privilege: "read-only" }),
        registeredAgent("builder", { privilege: "full-access" }),
        registeredAgent("orchestrator", {
          privilege: "edit",
          delegation: {
            enabled: true,
            maxConcurrentChildren: 1,
            routes: [
              {
                id: "small-only",
                target: "small",
                allowFurtherDelegation: false,
              },
              {
                id: "any-lower",
                target: "*",
                allowFurtherDelegation: true,
              },
              {
                id: "trusted-builder",
                target: "builder",
                allowFurtherDelegation: true,
              },
            ],
          },
        }),
      ].map((agent) => [agent.id, agent]),
    );
    const executionEnvironments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      testEnvironmentProvider(unusedSandbox),
    );
    sessions = new AgentSessionsService(db, {
      hostId: "coordination-test-host",
      projectManager,
      sandboxProvider: unusedSandbox,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "worker",
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      },
      devSandboxes: new DevSandboxService({
        projectManager,
        provider: unusedSandbox,
        store: new DbSandboxStore(db),
      }),
      nativeAgentCheckout: {
        resolve: ({ projectId, sessionId }) =>
          checkoutBySession.get(sessionId) ?? path.join(tmpDir, projectId),
        checkpoint: ({ sessionId, workingDirectory }) => {
          checkpointedSessions.push(sessionId);
          checkpointedTurns.push({ sessionId, workingDirectory });
          return Promise.resolve(null);
        },
      },
      onTurnSettled: (event) => {
        settledTurns.push({
          sessionId: event.sessionId,
          workingDirectory: event.workingDirectory,
          changedFiles: event.changedFiles,
          ...(event.notification ? { notification: event.notification } : {}),
        });
      },
    });
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("shows same-project peers with hierarchy, visibility, and live running state", async () => {
    const project = await projects.create(identity, { name: "Acme" });
    const otherProject = await projects.create(identity, { name: "Other" });
    const first = await sessions.create(identity, project.id);
    const second = await sessions.create(identity, project.id);
    await sessions.create(identity, otherProject.id);
    await sessions.setActivity(
      identity,
      project.id,
      second.id,
      " Editing   presentations/globex-renewal.pptx ",
    );

    const turn = sessions.sendMessage(
      identity,
      project.id,
      second.id,
      "Prepare the Globex renewal deck",
    );
    await provider.slowStarted;
    expect(await sessions.listPeers(identity, project.id, first.id)).toEqual([
      expect.objectContaining({
        id: second.id,
        projectId: project.id,
        running: true,
        task: "Prepare the Globex renewal deck",
        activity: "Editing presentations/globex-renewal.pptx",
      }),
    ]);
    provider.release();
    await turn;
    expect(checkpointedSessions).toContain(second.id);

    await sessions.setActivity(identity, project.id, second.id, null);
    expect(
      (await sessions.listPeers(identity, project.id, first.id))[0]?.activity,
    ).toBeNull();

    await db
      .updateTable("agent_sessions")
      .set({ updated_at: new Date(Date.now() - 31 * 60 * 1000) })
      .where("id", "=", second.id)
      .execute();
    expect(await sessions.listPeers(identity, project.id, first.id)).toEqual([
      expect.objectContaining({ id: second.id, running: false }),
    ]);
  });

  it("creates latent subsessions and promotes them on direct user interaction", async () => {
    const project = await projects.create(identity, { name: "Delegation" });
    const parent = await sessions.create(identity, project.id);

    const delegated = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Check the release notes" },
    );

    expect(delegated.session).toMatchObject({
      parentSessionId: parent.id,
      forkedFromSessionId: null,
      visibility: "latent",
    });
    await vi.waitFor(async () => {
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("completed");
    });
    await vi.waitFor(async () => {
      expect(
        (await sessions.get(identity, project.id, parent.id)).messages,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: expect.objectContaining({
              kind: "agent",
              sessionId: delegated.session.id,
            }),
          }),
        ]),
      );
    });

    await sessions.enqueueMessage(
      identity,
      project.id,
      delegated.session.id,
      "Please expand the conclusion",
    );
    expect(
      await sessions.get(identity, project.id, delegated.session.id),
    ).toMatchObject({ visibility: "promoted" });
  });

  it("inherits the parent agent for a manually created subsession", async () => {
    const project = await projects.create(identity, {
      name: "Manual subsession agent",
    });
    const parent = await sessions.create(identity, project.id, {
      agentId: "small",
    });
    const child = await sessions.create(identity, project.id, {
      parentSessionId: parent.id,
    });

    expect(child.agentId).toBe("small");
  });

  it("enforces delegation routes, concurrency, onward grants, and privilege ceilings", async () => {
    const project = await projects.create(identity, {
      name: "Delegation policy",
    });
    const parent = await sessions.create(identity, project.id, {
      agentId: "orchestrator",
    });
    const attempts = await Promise.allSettled([
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "small-only",
        task: "Prepare the Globex renewal deck A",
      }),
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "small-only",
        task: "Prepare the Globex renewal deck B",
      }),
    ]);
    const accepted = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof sessions.createSubsession>>
      > => result.status === "fulfilled",
    );
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/already has 1 active subsessions/),
      }),
    });
    const child = accepted[0]!.value;
    await provider.slowStarted;
    const parentRow = await db
      .selectFrom("agent_sessions")
      .select("system_prompt")
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(parentRow.system_prompt).toContain("small-only: small");
    await expect(
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "any-lower",
        agentId: "builder",
        task: "Escalate through wildcard",
      }),
    ).rejects.toThrow(/cannot grant a more privileged agent/);

    provider.release();
    await vi.waitFor(async () => {
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("completed");
    });
    await expect(
      sessions.createSubsession(identity, project.id, child.session.id, {
        task: "Delegate again",
      }),
    ).rejects.toThrow(/not allowed to delegate further/);
    const childRow = await db
      .selectFrom("agent_sessions")
      .select("system_prompt")
      .where("id", "=", child.session.id)
      .executeTakeFirstOrThrow();
    expect(childRow.system_prompt).toContain(
      "Delegation is disabled for this subsession",
    );

    const trusted = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        routeId: "trusted-builder",
        task: "Implement the approved fix",
      },
    );
    expect(trusted.session.agentId).toBe("builder");
  });

  it("keeps a delegation active across a transient child failure", async () => {
    const project = await projects.create(identity, {
      name: "Delegation retry",
    });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Recover delegated work" },
    );
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(
          identity,
          project.id,
          child.session.id,
        );
        expect(detail.running).toBe(false);
        expect(detail.messages.at(-1)?.metadata).toMatchObject({
          status: "failed",
          errorKind: "unavailable",
        });
      });
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("running");

      await sessions.retry(identity, project.id, child.session.id);
      await vi.waitFor(async () => {
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed");
        expect(
          (await sessions.get(identity, project.id, parent.id)).running,
        ).toBe(false);
      });
    } finally {
      await sessions.interrupt(identity, project.id, child.session.id, {
        notifyParent: false,
      });
    }
  });

  it("archives a whole session tree and confirms only when live resources stop", async () => {
    const project = await projects.create(identity, { name: "Archive tree" });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.create(identity, project.id, {
      parentSessionId: parent.id,
    });
    const runningChild = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Prepare the Globex renewal deck before archiving" },
    );
    await provider.slowStarted;
    const stop = vi.fn(async () => {});
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 1 }),
      stop,
    });

    await expect(
      sessions.archive(identity, project.id, parent.id),
    ).rejects.toMatchObject({
      impact: expect.objectContaining({
        sessionIds: expect.arrayContaining([
          parent.id,
          child.id,
          runningChild.session.id,
        ]),
        runningSessionIds: [runningChild.session.id],
        activeProcessCount: 1,
        requiresConfirmation: true,
      }),
    });

    const archived = await sessions.archive(identity, project.id, parent.id, {
      confirmStop: true,
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(archived.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.id,
          status: "active",
          visibility: "archived",
        }),
        expect.objectContaining({
          id: child.id,
          status: "active",
          visibility: "archived",
        }),
        expect.objectContaining({
          id: runningChild.session.id,
          status: "active",
          visibility: "archived",
        }),
      ]),
    );
    expect(
      (
        await sessions.get(identity, project.id, runningChild.session.id)
      ).messages.at(-1)?.metadata,
    ).toMatchObject({ status: "failed", interrupted: true });

    const restored = await sessions.unarchive(identity, project.id, parent.id);
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, visibility: "promoted" }),
        expect.objectContaining({ id: child.id, visibility: "promoted" }),
        expect.objectContaining({
          id: runningChild.session.id,
          visibility: "latent",
        }),
      ]),
    );
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 0 }),
      stop: async () => {},
    });
    const artifact = await db
      .insertInto("deployment_artifacts")
      .values({
        project_id: project.id,
        commit_sha: "a".repeat(40),
        artifact_digest: "b".repeat(64),
        plugin_digest: "c".repeat(64),
        transform_version: "test",
        runtime_version: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const pausedWatcher = await db
      .insertInto("watchers")
      .values({
        project_id: project.id,
        session_id: parent.id,
        owner_external_user_id: identity.externalUserId,
        owner_identity: {
          tenantId: identity.tenantId,
          externalUserId: identity.externalUserId,
        },
        workflow_name: "pausedWatcher",
        source_path: "workflows/src/watchers/paused.ts",
        remote_branch: "catamorphic/watchers/paused",
        commit_sha: "a".repeat(40),
        deployment_artifact_id: artifact.id,
        status: "paused",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(
      await sessions.archiveImpact(identity, project.id, parent.id),
    ).toMatchObject({ activeWatcherCount: 0, requiresConfirmation: false });
    await db
      .deleteFrom("watchers")
      .where("id", "=", pausedWatcher.id)
      .execute();
    const idleArchive = await sessions.archive(identity, project.id, parent.id);
    expect(idleArchive.impact.requiresConfirmation).toBe(false);

    const notifyProject = await projects.create(identity, {
      name: "Archive child notification",
    });
    const notifyParent = await sessions.create(identity, notifyProject.id);
    const notifyChild = await sessions.createSubsession(
      identity,
      notifyProject.id,
      notifyParent.id,
      { task: "Prepare the Globex renewal deck until archived" },
    );
    await provider.slowStarted;
    await sessions.archive(identity, notifyProject.id, notifyChild.session.id, {
      confirmStop: true,
    });
    await vi.waitFor(async () => {
      const detail = await sessions.get(
        identity,
        notifyProject.id,
        notifyParent.id,
      );
      expect(detail.running).toBe(false);
      expect(
        detail.messages.some(
          (message) =>
            message.content ===
            `Subsession ${notifyChild.session.id} was archived by the user.`,
        ),
      ).toBe(true);
      expect(detail.messages.at(-1)?.metadata).toMatchObject({
        status: "completed",
      });
    });
  });

  it("settles and checkpoints a checkout selected during the turn", async () => {
    const project = await projects.create(identity, { name: "Switching" });
    const chat = await sessions.create(identity, project.id);
    const worktree = path.join(tmpDir, project.id, "worktrees", chat.id);
    provider.switchCheckout = () => {
      checkoutBySession.set(chat.id, worktree);
      return worktree;
    };

    await sessions.sendMessage(
      identity,
      project.id,
      chat.id,
      "Switch checkout and edit",
    );

    expect(checkpointedTurns).toContainEqual({
      sessionId: chat.id,
      workingDirectory: worktree,
    });
    await vi.waitFor(() => {
      expect(settledTurns).toContainEqual({
        sessionId: chat.id,
        workingDirectory: worktree,
        changedFiles: ["result.md"],
      });
    });
    provider.switchCheckout = undefined;
  });

  it("reuses a workflow wake session and requests attention when its turn settles", async () => {
    const project = await projects.create(identity, { name: "Daily brief" });
    const first = await sessions.wake(identity, project.id, {
      wakeKey: '["gmail-summary","daily"]',
      content: "Summarize my inbox",
      workflowName: "gmail-summary",
      runId: crypto.randomUUID(),
      title: "Daily inbox summary",
      notification: {
        title: "Your inbox summary is ready",
        body: "Open the chat to read it.",
      },
    });
    expect(first.sessionCreated).toBe(true);

    await vi.waitFor(async () => {
      const item = (await sessions.list(identity, project.id)).items[0];
      expect(item).toMatchObject({
        id: first.sessionId,
        title: "Daily inbox summary",
        attentionRevision: 1,
        attentionSeenRevision: 0,
        attentionRequired: true,
      });
    });
    expect(settledTurns.at(-1)?.notification).toEqual({
      title: "Your inbox summary is ready",
      body: "Open the chat to read it.",
    });

    const acknowledged = await sessions.acknowledgeAttention(
      identity,
      project.id,
      first.sessionId,
    );
    expect(acknowledged.attentionRequired).toBe(false);

    const second = await sessions.wake(identity, project.id, {
      wakeKey: '["gmail-summary","daily"]',
      content: "Summarize my inbox again",
      workflowName: "gmail-summary",
      runId: crypto.randomUUID(),
    });
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      sessionCreated: false,
    });
    await vi.waitFor(async () => {
      const item = (await sessions.list(identity, project.id)).items[0];
      expect(item).toMatchObject({
        attentionRevision: 2,
        attentionSeenRevision: 1,
        attentionRequired: true,
      });
    });
  });
});
