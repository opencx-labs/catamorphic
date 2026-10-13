import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionMessageAuthor } from "@catamorphic/agent-protocol";
import { EchoAdapter } from "@catamorphic/agent-runner";
import {
  createDatabase,
  type DB,
  migrateToLatest,
  withStorableParameters,
} from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import {
  type SessionActionOperation,
  SessionActionsService,
} from "../services/session-actions-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * A workflow's boundary retries every action it took, the chat it closed
 * included. A run of an enabled workflow sends as its enablement, schedule
 * or watcher; its retried actions answer with what they recorded, though
 * the key no longer names an open chat.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const schema = `catamorphic_action_retries_${randomUUID().replaceAll("-", "")}`;
const identity: Identity = {
  tenantId: randomUUID(),
  externalUserId: "builder",
};

/** PGlite, wrapped as core wraps whatever database a host injects. */
function pglite(): Kysely<DB> {
  return withStorableParameters(
    new Kysely<DB>({
      dialect: new PGliteDialect({
        pglite: new PGlite({ extensions: { pgcrypto } }),
      }),
      plugins: [new WithSchemaPlugin(schema)],
    }),
  );
}

const databases: Array<[string, () => Kysely<DB>]> = [["PGlite", pglite]];
if (connectionString)
  databases.push([
    "Postgres",
    () => createDatabase({ connectionString, schema, poolSize: 4 }),
  ]);

/** Runs of an enabled workflow, as `catamorphic.sessions` names their sender. */
const runs: Array<[string, () => SessionMessageAuthor]> = [
  [
    "a scheduled run",
    () => ({
      kind: "workflow",
      runId: randomUUID(),
      workflowName: "cleanupOnMerge",
      displayName: "Clean up on merge",
      enablementId: randomUUID(),
      scheduledFor: "2026-10-13T09:00:00.000Z",
      firedAt: "2026-10-13T09:00:01.000Z",
    }),
  ],
  [
    "a watcher's run",
    () => ({
      kind: "workflow",
      runId: randomUUID(),
      workflowName: "cleanupOnMerge",
      enablementId: randomUUID(),
      watcher: { id: randomUUID(), sessionId: randomUUID() },
      scheduledFor: "2026-10-13T09:00:00.000Z",
    }),
  ],
];

describe.each(databases)("retried session actions, on %s", (name, open) => {
  const db = open();
  let tmpDir: string | undefined;
  let projects: ProjectsService;
  let sessions: AgentSessionsService;
  let actions: SessionActionsService;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "action-retries-"));
    tmpDir = dir;
    await migrateToLatest({ db, schema });
    const projectManager = new ProjectManager(
      new FsBackend(path.join(dir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const echo: RegisteredCodingAgent = {
      id: "echo",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    sessions = new AgentSessionsService(db, {
      hostId: `action-retries-${name}`,
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider({
          workspaceRoot: "/unused",
        } as SandboxProvider),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "echo",
        get: (id) => (id === echo.id ? echo : undefined),
        list: () => [echo],
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId }) => {
          const checkout = path.join(dir, "checkouts", projectId);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
        head: () => Promise.resolve("initial"),
        restore: () => Promise.resolve("restored"),
      },
    });
    actions = new SessionActionsService(db, sessions, () => undefined);
  });

  afterAll(async () => {
    try {
      // Setup may have failed before the service existed.
      await sessions?.stopLocalTurns();
      if (name === "Postgres")
        await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    } finally {
      await db.destroy();
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function keyedChat(title: string) {
    const project = await projects.create(identity, { name: title });
    const { sessionId } = await sessions.chatForKey(identity, project.id, {
      key: "pr-7",
      workflowName: "reviewOnOpen",
    });
    return { projectId: project.id, sessionId };
  }

  it.each(runs)(
    "answers %s's retries with what they recorded after it closed the chat",
    async (_run, sender) => {
      const author = sender();
      const { projectId, sessionId } = await keyedChat("Retried after close");
      const act = (operation: SessionActionOperation, args: unknown) =>
        actions.execute({ identity, projectId, operation, args, author });
      const complete = () =>
        act("complete", {
          key: "pr-7",
          content: "Reviewed",
          idempotencyKey: "done-7",
        });
      const close = () =>
        act("close", { key: "pr-7", idempotencyKey: "merged-7" });
      const completed = await complete();
      expect(completed).toEqual({ sessionId });
      expect(await close()).toEqual({ sessionId, closed: true });
      expect(
        await sessions.keyedChatId({
          projectId,
          ownerId: identity.externalUserId,
          key: "pr-7",
        }),
      ).toBeUndefined();
      // The boundary runs again: the key names no open chat now.
      expect(await complete()).toEqual(completed);
      expect(await close()).toEqual({ sessionId, closed: true });
      // A new key, though, has nothing recorded to answer with.
      await expect(
        act("complete", {
          key: "pr-7",
          content: "Reviewed",
          idempotencyKey: "done-8",
        }),
      ).rejects.toThrow("No open chat has the key pr-7");
      expect(
        await act("close", { key: "pr-7", idempotencyKey: "merged-8" }),
      ).toEqual({ sessionId: null, closed: false });
    },
  );

  it.each(runs)(
    "finishes %s's close that stopped after closing the chat",
    async (_run, sender) => {
      const author = sender();
      const { projectId, sessionId } = await keyedChat("Interrupted close");
      const close = () =>
        actions.execute({
          identity,
          projectId,
          operation: "close",
          args: { key: "pr-7", idempotencyKey: "merged-7" },
          author,
        });
      expect(await close()).toEqual({ sessionId, closed: true });
      // As if the close stopped after the chat closed, before its record.
      await db
        .updateTable("session_actions")
        .set({ status: "failed", result: null })
        .where("project_id", "=", projectId)
        .where("operation", "=", "close")
        .execute();
      expect(await close()).toEqual({ sessionId, closed: true });
      const recorded = await db
        .selectFrom("session_actions")
        .select(["status", "result", "actor"])
        .where("project_id", "=", projectId)
        .where("operation", "=", "close")
        .execute();
      // One action, recorded with the sender as it acted.
      expect(recorded).toEqual([
        {
          status: "completed",
          result: { sessionId, closed: true },
          actor: { ...author, causation: [] },
        },
      ]);
    },
  );
});
