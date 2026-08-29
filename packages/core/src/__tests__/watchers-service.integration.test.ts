import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import type { ProjectEventMonitorsService } from "../services/project-event-monitors-service.js";
import { ProjectEventsService } from "../services/project-events-service.js";
import type { RunsService } from "../services/runs-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { TriggersService } from "../services/triggers-service.js";
import { WatchersService } from "../services/watchers-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_watchers";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const identity: Identity = { tenantId, externalUserId: "builder" };

describe("temporary watchers", () => {
  let tmpDir: string;
  let watchers: WatchersService;
  let events: ProjectEventsService;
  const triggered: Array<Record<string, unknown>> = [];
  const attemptedEventIds: string[] = [];
  let failingEventId: string | null = null;
  const bindingKinds = new Map([
    ["watchIssue", "issue.changed"],
    ["watchRegression", "regression.changed"],
    ["watchScope", "scope.changed"],
  ]);
  const triggerKinds: TriggerKindRuntime[] = [...bindingKinds.values()].map(
    (name) => ({
      name,
      payloadJsonSchema: { type: "object" },
      configJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validatePayload: () => ({ ok: true }),
      validateConfig: (value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? { ok: true }
          : { ok: false, errors: ["Expected an object"] },
    }),
  );

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: "test",
      })
      .execute();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-watchers-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    await projectManager.create(tenantId, projectId, {
      name: "watcher-test",
      externalUserId: identity.externalUserId,
    });

    events = new ProjectEventsService(db);
    const runs = {
      resolveArtifactAtCommit: vi.fn(async (input: { commitSha: string }) => {
        const id = crypto.randomUUID();
        await db
          .insertInto("deployment_artifacts")
          .values({
            id,
            project_id: projectId,
            commit_sha: input.commitSha,
            artifact_digest: crypto.randomUUID(),
            plugin_digest: "none",
            runtime_version: "test",
            transform_version: "test",
          })
          .execute();
        return { id };
      }),
      triggerUnattendedAtCommit: vi.fn(
        async (input: Record<string, unknown>) => {
          triggered.push(input);
          const eventId = String(
            (input.input as { id?: string } | undefined)?.id,
          );
          const workflowName = String(input.workflowName);
          attemptedEventIds.push(eventId);
          if (eventId === failingEventId) throw new Error("temporary failure");
          const id = crypto.randomUUID();
          await db
            .insertInto("workflow_runs")
            .values({
              id,
              project_id: projectId,
              workflow_name: workflowName,
              external_user_id: identity.externalUserId,
              provenance: {},
            })
            .execute();
          return { id };
        },
      ),
    } as unknown as RunsService;
    const executionEnvironments = {
      admit: vi.fn(async (input: { environment?: string }) => ({
        environmentName: input.environment ?? "local",
      })),
    } as unknown as ExecutionEnvironmentsService;
    const triggers = new TriggersService(db, {
      kinds: triggerKinds,
      projectManager,
      runs,
      executionEnvironments,
    });
    const sessions = {
      assertSession: vi.fn(async () => undefined),
    } as unknown as AgentSessionsService;
    const monitors = {} as ProjectEventMonitorsService;
    watchers = new WatchersService(db, {
      projectManager,
      runs,
      triggers,
      events,
      monitors,
      sessions,
    });
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("pins temporary source and dispatches each matching future event once", async () => {
    await events.append({
      projectId,
      source: "test",
      kind: "issue.changed",
      externalId: "before-watcher",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    const watcher = await watchers.create({
      identity,
      projectId,
      sessionId,
      workflowName: "watchIssue",
      environment: "edge",
      source: `
        import { defineWorkflow, trigger } from "@catamorphic/workflow";

        export const watchIssue = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("issue.changed")],
          steps: [
            defineBoundary({
              run: async ({ input }) => input,
            }),
          ],
        }));
      `,
    });

    expect(watcher).toMatchObject({
      sessionId,
      monitorId: null,
      status: "active",
      triggerKinds: ["issue.changed"],
      environment: "edge",
    });
    expect(watcher.remoteBranch).toBe(`catamorphic/watchers/${watcher.id}`);
    expect(watcher.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await watchers.dispatchPending()).toBe(0);

    const appended = await events.append({
      projectId,
      source: "test",
      kind: "issue.changed",
      externalId: "after-watcher",
      occurredAt: new Date().toISOString(),
      payload: { action: "updated" },
    });
    expect(await watchers.dispatchPending()).toBe(1);
    expect(await watchers.dispatchPending()).toBe(0);
    expect(triggered).toEqual([
      expect.objectContaining({
        commitSha: watcher.commitSha,
        remoteBranch: watcher.remoteBranch,
        correlationKey: `watcher:${watcher.id}:event:${appended.event.id}`,
        input: appended.event,
        workflowName: "watchIssue",
        environment: "edge",
      }),
    ]);
  });

  it("rejects a workflow without an ordinary inline trigger binding", async () => {
    await expect(
      watchers.create({
        identity,
        projectId,
        sessionId,
        workflowName: "noTrigger",
        source: `
          import { defineWorkflow } from "@catamorphic/workflow";

          export const noTrigger = defineWorkflow(({ defineBoundary }) => ({
            steps: [defineBoundary({ run: async ({ input }) => input })],
          }));
        `,
      }),
    ).rejects.toThrow(
      "Watcher workflow 'noTrigger' must declare at least one trigger",
    );
  });

  it("never moves its cursor backward when a later event fails", async () => {
    const watcher = await watchers.create({
      identity,
      projectId,
      sessionId,
      workflowName: "watchRegression",
      source: `
        import { defineWorkflow, trigger } from "@catamorphic/workflow";

        export const watchRegression = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("regression.changed")],
          steps: [
            defineBoundary({
              run: async ({ input }) => input,
            }),
          ],
        }));
      `,
    });
    const first = await events.append({
      projectId,
      source: "test",
      kind: "regression.changed",
      externalId: "regression-first",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    const second = await events.append({
      projectId,
      source: "test",
      kind: "regression.changed",
      externalId: "regression-second",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    failingEventId = second.event.id;

    expect(await watchers.dispatchPending()).toBe(1);
    expect(
      (await watchers.list({ identity, projectId, sessionId })).find(
        (entry) => entry.id === watcher.id,
      )?.cursorSequence,
    ).toBe(first.event.sequence);

    failingEventId = null;
    expect(await watchers.dispatchPending()).toBe(1);
    expect(attemptedEventIds.slice(-3)).toEqual([
      first.event.id,
      second.event.id,
      second.event.id,
    ]);
  });

  it("dispatches with the creator's exact scoped identity", async () => {
    const scopedIdentity: Identity = {
      ...identity,
      scope: [{ kind: "agent", projectId, name: "reviewer" }],
      executionScope: [{ projectId, name: "local" }],
    };
    const watcher = await watchers.create({
      identity: scopedIdentity,
      projectId,
      sessionId,
      workflowName: "watchScope",
      source: `
        import { defineWorkflow, trigger } from "@catamorphic/workflow";

        export const watchScope = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("scope.changed")],
          steps: [
            defineBoundary({
              run: async ({ input }) => input,
            }),
          ],
        }));
      `,
    });
    const appended = await events.append({
      projectId,
      source: "test",
      kind: "scope.changed",
      externalId: "scope-event",
      occurredAt: new Date().toISOString(),
      payload: {},
    });

    expect(await watchers.dispatchPending()).toBe(1);
    expect(
      triggered.find(
        (entry) =>
          entry.correlationKey ===
          `watcher:${watcher.id}:event:${appended.event.id}`,
      )?.identity,
    ).toEqual(scopedIdentity);
  });
});
