import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentSessionsService,
  type NativeAgentCheckout,
} from "../services/agent-sessions-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import type { WorkspaceSetupOutcome } from "../services/workspace-setup.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * A native chat's own checkout (ADR 0215): set up like a new workspace
 * before its turn, never the person's own folder, and given back to the
 * host when the chat is archived or closed.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_native_checkouts";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "ada",
};

describe("native checkouts a chat owns (ADR 0215)", () => {
  let tmpDir: string;
  let projectId: string;
  let sessions: AgentSessionsService;
  const adapter = new RecordingAdapter();
  /** Whether each session's checkout is its own. */
  const owned = new Map<string, boolean>();
  const setups: Array<{
    sessionId: string;
    workingDirectory: string;
    environment?: string;
  }> = [];
  let nextSetup: WorkspaceSetupOutcome = { status: "succeeded" };
  const released: string[] = [];

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-checkouts-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    projectId = (await projects.create(identity, { name: "Native" })).id;
    const repo = await projectManager.open(identity.tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            dev: { workloads: ["agent"], setup: "bun install" },
          },
          defaultEnvironment: "dev",
        }),
      );
      await repo.commit("Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
    const agent = {
      id: "worker",
      harness: { placement: "host" as const, adapter },
      topology: "native" as const,
    };
    const checkout: NativeAgentCheckout = {
      resolve: ({ sessionId }) => ({
        path: path.join(tmpDir, owned.get(sessionId) ? sessionId : "folder"),
        owned: owned.get(sessionId) ?? false,
      }),
      setup: async (input) => {
        setups.push({
          sessionId: input.sessionId,
          workingDirectory: input.workingDirectory,
          ...(input.environment ? { environment: input.environment } : {}),
        });
        await input.onRun();
        return {
          outcome: nextSetup,
          logPath: path.join(tmpDir, "work-setup.log"),
        };
      },
      release: async ({ sessionId }) => {
        released.push(sessionId);
      },
    };
    sessions = new AgentSessionsService(db, {
      hostId: "native-checkouts-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      nativeAgentCheckout: checkout,
    });
  }, 60_000);

  afterAll(async () => {
    await sessions?.stopLocalTurns();
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sets up a checkout the chat owns with its Environment's setup, and tells the agent when it failed", async () => {
    const chat = await sessions.create(identity, projectId);
    owned.set(chat.id, true);
    const first = await sessions.sendMessage(
      identity,
      projectId,
      chat.id,
      "first",
    );
    expect(first.turn.status).toBe("completed");
    expect(setups.at(-1)).toEqual({
      sessionId: chat.id,
      workingDirectory: path.join(tmpDir, chat.id),
      environment: "bun install",
    });
    expect(adapter.lastInput()).not.toContain("[Workspace]");

    nextSetup = {
      status: "failed",
      exitCode: 1,
      timedOut: false,
      log: "error: lockfile had changes",
      parts: ["environment"],
    };
    await sessions.sendMessage(identity, projectId, chat.id, "second");
    nextSetup = { status: "succeeded" };
    expect(adapter.lastInput()).toContain(
      "[Workspace] Setting up this workspace failed with exit code 1",
    );
    expect(adapter.lastInput()).toContain("error: lockfile had changes");
    expect(adapter.lastInput()).toContain(path.join(tmpDir, "work-setup.log"));
  }, 30_000);

  it("never sets up the person's own folder", async () => {
    const chat = await sessions.create(identity, projectId);
    owned.set(chat.id, false);
    const before = setups.length;
    await sessions.sendMessage(identity, projectId, chat.id, "hello");
    expect(setups).toHaveLength(before);
  }, 30_000);

  it("gives back the checkout of a chat that is archived or closed", async () => {
    const archived = await sessions.create(identity, projectId);
    owned.set(archived.id, true);
    await sessions.sendMessage(identity, projectId, archived.id, "work");
    await sessions.archive(identity, projectId, archived.id);
    expect(released).toContain(archived.id);

    const closed = await sessions.create(identity, projectId);
    owned.set(closed.id, true);
    await sessions.sendMessage(identity, projectId, closed.id, "work");
    await sessions.close(identity, projectId, closed.id);
    expect(released).toContain(closed.id);
  }, 30_000);
});
