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
    if (message === "Prepare the Globex renewal deck") {
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
        get: () => ({ id: "worker", provider, topology: "native" }),
        list: () => [],
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

  it("shows active same-project peers with task, activity, and live running state", async () => {
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
    expect(await sessions.listPeers(identity, project.id, first.id)).toEqual(
      [],
    );
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
