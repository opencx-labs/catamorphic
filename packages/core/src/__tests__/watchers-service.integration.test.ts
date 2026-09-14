import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import {
  FsBackend,
  FsRemoteBackend,
  fetchRemote,
  ProjectManager,
  push,
} from "@catamorphic/git";
import { resolveWorkflowPackageFallback } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { ProjectEventMonitorsService } from "../services/project-event-monitors-service.js";
import { ProjectEventsService } from "../services/project-events-service.js";
import type { RunsService } from "../services/runs-service.js";
import { SchedulesService } from "../services/schedules-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { TriggersService } from "../services/triggers-service.js";
import { WatchersService } from "../services/watchers-service.js";
import type { WorkflowEnablementsService } from "../services/workflow-enablements-service.js";

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
  let triggers: TriggersService;
  let projectManager: ProjectManager;
  const disableEnablement = vi.fn(async (input: { enablementId: string }) => {
    await db
      .updateTable("workflow_enablements")
      .set({ status: "disabled" })
      .where("id", "=", input.enablementId)
      .execute();
  });
  const triggered: Array<Record<string, unknown>> = [];
  const attemptedEventIds: string[] = [];
  let failingEventId: string | null = null;
  let beforeEnablementCreate: (() => Promise<void>) | undefined;
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
        agent_id: `project:${projectId}:reviewer`,
      })
      .execute();

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-watchers-"));
    projectManager = new ProjectManager(
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
      triggerWithEnablement: vi.fn(async (input: Record<string, unknown>) => {
        triggered.push(input);
        const eventId = String(
          (input.input as { id?: string } | undefined)?.id,
        );
        attemptedEventIds.push(eventId);
        if (eventId === failingEventId) throw new Error("temporary failure");
        const id = crypto.randomUUID();
        await db
          .insertInto("workflow_runs")
          .values({
            id,
            project_id: projectId,
            workflow_name: String(input.workflowName),
            external_user_id: identity.externalUserId,
            workflow_enablement_id: String(input.enablementId),
            provenance: {},
            correlation_key: String(input.correlationKey),
          })
          .execute();
        return { id };
      }),
    } as unknown as RunsService;
    triggers = new TriggersService(db, {
      kinds: [
        ...triggerKinds,
        {
          name: "schedule",
          configJsonSchema: { type: "object" },
          payloadJsonSchema: { type: "object" },
          validateConfig: () => ({ ok: true }),
          validatePayload: () => ({ ok: true }),
        },
      ],
      projectManager,
      runs,
    });
    const sessions = {
      hostId: "local-host",
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
      workflowEnablements: {
        preview: vi.fn(async () => ({ consentDigest: "d".repeat(64) })),
        create: vi.fn(
          async (
            input: Parameters<WorkflowEnablementsService["create"]>[0],
          ) => {
            await beforeEnablementCreate?.();
            return db.transaction().execute(async (transaction) => {
              const id = crypto.randomUUID();
              const artifact = await transaction
                .selectFrom("deployment_artifacts")
                .selectAll()
                .where("project_id", "=", projectId)
                .where("commit_sha", "=", String(input.commitSha))
                .executeTakeFirstOrThrow();
              const enablement = await transaction
                .insertInto("workflow_enablements")
                .values({
                  id,
                  tenant_id: tenantId,
                  project_id: projectId,
                  workflow_name: String(input.workflowName),
                  deployment_artifact_id: artifact.id,
                  commit_sha: String(input.commitSha),
                  remote_branch: String(input.remoteBranch),
                  environment_name: String(input.environment ?? "local"),
                  owner_kind: "member",
                  owner_external_user_id: identity.externalUserId,
                  owner_identity: JSON.parse(JSON.stringify(input.identity)),
                  capabilities: [],
                  consent_digest: "d".repeat(64),
                  temporary: true,
                  expires_at:
                    input.expiresAt instanceof Date ? input.expiresAt : null,
                  created_by_external_user_id: identity.externalUserId,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
              await transaction
                .insertInto("workflow_enablement_triggers")
                .columns(["enablement_id", "trigger_definition_id"])
                .expression((eb) =>
                  eb
                    .selectFrom("trigger_definitions")
                    .select([
                      eb.val(id).as("enablement_id"),
                      "id as trigger_definition_id",
                    ])
                    .where("project_id", "=", projectId)
                    .where("commit_sha", "=", String(input.commitSha))
                    .where("workflow_name", "=", String(input.workflowName)),
                )
                .execute();
              await input.onCreate?.({ transaction, enablement });
              return { id, environment: String(input.environment ?? "local") };
            });
          },
        ),
        revalidate: vi.fn(
          async ({ enablementId }: { enablementId: string }) => {
            const row = await db
              .selectFrom("workflow_enablements")
              .selectAll()
              .where("id", "=", enablementId)
              .executeTakeFirstOrThrow();
            if (row.status !== "active") throw new Error("Enablement disabled");
            return { ownerIdentity: row.owner_identity };
          },
        ),
        disable: disableEnablement,
      } as unknown as WorkflowEnablementsService,
    });
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("requires the selected workflow to be exported by the supplied source", async () => {
    const repo = await projectManager.openDev(
      tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      await repo.writeFile(
        "workflows/src/existing.ts",
        `
        import { defineWorkflow, trigger } from "@catamorphic/workflow";
        export const existingWorkflow = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("issue.changed")],
          steps: [defineBoundary({ run: async ({ input }) => input })],
        }));`,
      );
      await repo.commit("Existing shared workflow", {
        name: "Test",
        email: "test@example.com",
      });
      const remote = projectManager.remoteBackend;
      if (!remote) throw new Error("Missing test origin");
      await push({
        dev: repo,
        remote,
        tenantId,
        projectId,
        remoteBranch: "main",
      });
    } finally {
      await repo.dispose();
    }
    await expect(
      watchers.create({
        identity,
        projectId,
        sessionId,
        workflowName: "existingWorkflow",
        source: "export const unrelated = true;",
      }),
    ).rejects.toThrow("source must export existingWorkflow");
    await expect(
      watchers.create({
        identity,
        projectId,
        sessionId,
        workflowName: "existingWorkflow",
        source: `import { defineWorkflow, trigger } from "@catamorphic/workflow";
        export const existingWorkflow = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("issue.changed")],
          steps: [defineBoundary({ run: async ({ input }) => input })],
        }));`,
      }),
    ).rejects.toThrow(
      "Workflow name 'existingWorkflow' already exists in committed project source",
    );
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
    expect(watcher.remoteBranch).toMatch(
      new RegExp(`^catamorphic/artifacts/${watcher.id}-[0-9a-f-]{36}$`),
    );
    expect(watcher.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const repo = await projectManager.openDev(
      tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      const remote = projectManager.remoteBackend;
      if (!remote) throw new Error("Missing test origin");
      await fetchRemote({
        dev: repo,
        remote,
        tenantId,
        projectId,
        remoteBranch: watcher.remoteBranch,
      });
      const files = await repo.readAllFilesAtRef(watcher.commitSha);
      const payload = await resolveWorkflowPackageFallback({
        packageJson: files["package.json"],
      });
      if (!payload) throw new Error("Watcher runtime dependency is missing");
      // Load the committed source with only its resolved runtime payload,
      // outside the repository's node_modules; no registry or model needed.
      const runtimeDir = path.join(tmpDir, "watcher-runtime");
      for (const [filePath, contents] of Object.entries({
        ...files,
        ...Object.fromEntries(
          Object.entries(payload.files).map(([name, content]) => [
            `node_modules/${payload.packageName}/${name}`,
            content,
          ]),
        ),
      })) {
        const target = path.join(runtimeDir, filePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents);
      }
      const result = await promisify(execFile)(
        "bun",
        [
          "-e",
          `const { watchIssue } = await import(${JSON.stringify(`./${watcher.sourcePath}`)}); console.log(typeof watchIssue);`,
        ],
        { cwd: runtimeDir, timeout: 10_000 },
      );
      expect(result.stdout.trim()).toBe("object");
      expect(await repo.listFiles()).not.toContain("package.json");
      expect(await repo.listFiles()).not.toContain(watcher.sourcePath);
    } finally {
      await repo.dispose();
    }
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
        enablementId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        correlationKey: expect.stringMatching(
          new RegExp(`^event:[0-9a-f-]{36}:${appended.event.id}$`),
        ),
        input: appended.event,
        workflowName: "watchIssue",
        environment: "edge",
      }),
    ]);
  });

  it("suppresses causal cycles and recovers a receipt after its run has already completed", async () => {
    const watcher = (
      await watchers.list({ identity, projectId, sessionId })
    ).find((item) => item.workflowName === "watchIssue");
    if (!watcher) throw new Error("Fixture watcher missing");
    const enablement = await db
      .selectFrom("watchers")
      .select("workflow_enablement_id")
      .where("id", "=", watcher.id)
      .executeTakeFirstOrThrow();
    const cycle = await events.append({
      projectId,
      source: "test",
      kind: "issue.changed",
      externalId: "cycle",
      occurredAt: new Date().toISOString(),
      payload: { causation: [enablement.workflow_enablement_id] },
    });
    expect(await watchers.dispatchPending()).toBe(0);
    expect(
      await db
        .selectFrom("project_event_deliveries")
        .select(["status", "error"])
        .where("event_id", "=", cycle.event.id)
        .executeTakeFirst(),
    ).toMatchObject({ status: "completed", error: "Causal cycle suppressed" });
    const event = await events.append({
      projectId,
      source: "test",
      kind: "issue.changed",
      externalId: "crash-after-run",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    expect(await watchers.dispatchPending()).toBe(1);
    const admissions = triggered.length;
    await db
      .updateTable("workflow_runs")
      .set({ status: "completed", completed_at: new Date() })
      .where("correlation_key", "like", `%:${event.event.id}`)
      .execute();
    await db
      .updateTable("project_event_deliveries")
      .set({
        status: "leased",
        lease_owner: "dead-worker",
        lease_expires_at: new Date(0),
      })
      .where("event_id", "=", event.event.id)
      .execute();
    await watchers.dispatchPending();
    expect(triggered).toHaveLength(admissions);
    expect(
      await db
        .selectFrom("project_event_deliveries")
        .select("status")
        .where("event_id", "=", event.event.id)
        .executeTakeFirst(),
    ).toEqual({ status: "completed" });
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
    await db
      .updateTable("project_event_deliveries")
      .set({ next_attempt_at: new Date(0) })
      .where("event_id", "=", second.event.id)
      .execute();
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
    await watchers.create({
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
      triggered.find((entry) =>
        String(entry.correlationKey).endsWith(`:${appended.event.id}`),
      )?.identity,
    ).toEqual(scopedIdentity);
  });
  it("does no workflow lookup while idle or for unrelated events", async () => {
    await watchers.dispatchPending();
    const lookup = vi.spyOn(triggers, "listAtCommit");
    await watchers.dispatchPending();
    expect(lookup).not.toHaveBeenCalled();
    await events.append({
      projectId,
      source: "test",
      kind: "unrelated",
      externalId: "unrelated-idle",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    expect(await watchers.dispatchPending()).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockClear();
    expect(await watchers.dispatchPending()).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it("does not disable a watcher belonging to another session", async () => {
    const watcher = await db
      .selectFrom("watchers")
      .selectAll()
      .executeTakeFirstOrThrow();
    disableEnablement.mockClear();
    expect(
      await watchers.stop({
        identity,
        projectId,
        sessionId: crypto.randomUUID(),
        watcherId: watcher.id,
      }),
    ).toBe(false);
    expect(disableEnablement).not.toHaveBeenCalled();
  });

  it("runs a session-owned periodic workflow through normal scheduling and stops it", async () => {
    const watcher = await watchers.create({
      identity,
      projectId,
      sessionId,
      workflowName: "periodicCheck",
      source: `
        import { defineWorkflow, trigger } from "@catamorphic/workflow";
        export const periodicCheck = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("schedule", { cron: "* * * * *", timezone: "UTC" })],
          steps: [defineBoundary({ run: async ({ input }) => input })],
        }));`,
    });
    const schedules = new SchedulesService(db, triggers);
    const now = new Date();
    await schedules.tick({ identity, projectId, now });
    const next = new Date(now.getTime() + 61_000);
    expect(await schedules.tick({ identity, projectId, now: next })).toEqual({
      enrolled: 1,
    });
    expect(triggered.at(-1)).toMatchObject({
      workflowName: "periodicCheck",
      environment: "local",
    });
    await watchers.stop({
      identity,
      projectId,
      sessionId,
      watcherId: watcher.id,
    });
    expect(
      await schedules.tick({
        identity,
        projectId,
        now: new Date(next.getTime() + 61_000),
      }),
    ).toEqual({ enrolled: 0 });
  });

  it("rejects new watchers after the owning session closes", async () => {
    await db
      .updateTable("agent_sessions")
      .set({ status: "closed" })
      .where("id", "=", sessionId)
      .execute();
    try {
      await expect(
        watchers.create({
          identity,
          projectId,
          sessionId,
          workflowName: "neverCreated",
          source: "",
        }),
      ).rejects.toThrow("closed session");
    } finally {
      await db
        .updateTable("agent_sessions")
        .set({ status: "active" })
        .where("id", "=", sessionId)
        .execute();
    }
  });

  it.each(["active", "paused"] as const)(
    "retires the temporary enablement when a %s watcher expires",
    async (status) => {
      const watcher = await db
        .selectFrom("watchers")
        .selectAll()
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("watchers")
        .set({ expires_at: new Date(0), status })
        .where("id", "=", watcher.id)
        .execute();
      disableEnablement.mockClear();
      await watchers.dispatchPending();
      expect(disableEnablement).toHaveBeenCalledWith({
        identity,
        enablementId: watcher.workflow_enablement_id,
      });
      expect(
        await db
          .selectFrom("watchers")
          .select("status")
          .where("id", "=", watcher.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "expired" });
      // Already-enrolled runs keep their immutable source until they settle.
      await db
        .updateTable("workflow_runs")
        .set({ status: "completed", completed_at: new Date() })
        .where("project_id", "=", projectId)
        .execute();
      await watchers.dispatchPending();
      expect(
        await projectManager.remoteBackend?.withOrigin(
          tenantId,
          projectId,
          (origin) => origin.resolveRef(`refs/heads/${watcher.remote_branch}`),
        ),
      ).toBe(watcher.commit_sha);
      expect(
        (await watchers.list({ identity, projectId, sessionId })).find(
          (item) => item.id === watcher.id,
        )?.triggerKinds.length,
      ).toBeGreaterThan(0);
    },
  );
  it.each([
    {
      archived: true,
      host: "local-host",
      environment: "local",
      error: "Restore the session",
    },
    {
      archived: false,
      host: "remote-host",
      environment: "local",
      error: "authoritative host",
    },
    {
      archived: false,
      host: "local-host",
      environment: "remote",
      error: "session's Environment",
    },
  ])(
    "rejects invalid reminder ownership before creating artifacts: $error",
    async ({ archived, host, environment, error }) => {
      const targetId = crypto.randomUUID();
      await db
        .insertInto("agent_sessions")
        .values({
          id: targetId,
          project_id: projectId,
          external_user_id: identity.externalUserId,
          provider: "test",
          authority_host_id: host,
          environment_name: "local",
        })
        .execute();
      if (archived)
        await db
          .insertInto("agent_session_views")
          .values({
            session_id: targetId,
            tenant_id: tenantId,
            external_user_id: identity.externalUserId,
            visibility: "archived",
            archived_at: new Date(),
          })
          .execute();
      await expect(
        watchers.create({
          identity,
          projectId,
          sessionId: targetId,
          workflowName: "invalidReminder",
          source: "export const invalidReminder = true;",
          environment,
        }),
      ).rejects.toThrow(error);
      expect(
        await db
          .selectFrom("session_artifacts")
          .select("id")
          .where("session_id", "=", targetId)
          .execute(),
      ).toEqual([]);
    },
  );

  it.each(["archived", "closed"])(
    "rolls back activation when a session is %s during watcher preparation",
    async (lifecycle) => {
      const targetId = crypto.randomUUID();
      await db
        .insertInto("agent_sessions")
        .values({
          id: targetId,
          project_id: projectId,
          external_user_id: identity.externalUserId,
          provider: "test",
        })
        .execute();
      beforeEnablementCreate = async () => {
        if (lifecycle === "closed") {
          await db
            .updateTable("agent_sessions")
            .set({ status: "closed" })
            .where("id", "=", targetId)
            .execute();
          return;
        }
        await db
          .insertInto("agent_session_views")
          .values({
            session_id: targetId,
            tenant_id: tenantId,
            external_user_id: identity.externalUserId,
            visibility: "archived",
            archived_at: new Date(),
          })
          .execute();
      };
      try {
        await expect(
          watchers.create({
            identity,
            projectId,
            sessionId: targetId,
            workflowName: `archiveRace${lifecycle}`,
            source: `import { defineWorkflow, trigger } from "@catamorphic/workflow";
        export const archiveRace${lifecycle} = defineWorkflow(({ defineBoundary }) => ({
          triggers: [trigger("schedule", { at: "2020-01-01T00:00:00Z" })],
          steps: [defineBoundary({ run: async ({ input }) => input })],
        }));`,
          }),
        ).rejects.toThrow(
          lifecycle === "closed" ? "closed session" : "Restore the session",
        );
      } finally {
        beforeEnablementCreate = undefined;
      }
      expect(
        await db
          .selectFrom("workflow_enablements")
          .select("id")
          .where("workflow_name", "=", `archiveRace${lifecycle}`)
          .execute(),
      ).toEqual([]);
      expect(
        await watchers.list({ identity, projectId, sessionId: targetId }),
      ).toEqual([]);
    },
  );

  it("keeps a seven-day reminder enabled across months offline without an implicit expiry", async () => {
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const reminder = await watchers.create({
      identity,
      projectId,
      sessionId,
      workflowName: "longReminder",
      source: `import { defineWorkflow, trigger } from "@catamorphic/workflow";
      export const longReminder = defineWorkflow(({ defineBoundary }) => ({
        triggers: [trigger("schedule", { at: ${JSON.stringify(at)} })],
        steps: [defineBoundary({ run: async ({ input }) => input })],
      }));`,
    });
    expect(reminder.expiresAt).toBeNull();
    expect(
      (
        await db
          .selectFrom("workflow_enablements")
          .select("expires_at")
          .where("workflow_name", "=", "longReminder")
          .executeTakeFirstOrThrow()
      ).expires_at,
    ).toBeNull();
    const before = triggered.filter(
      (run) => run.workflowName === "longReminder",
    ).length;
    const late = new Date(Date.now() + 100 * 86_400_000);
    await new SchedulesService(db, triggers).tick({
      identity,
      projectId,
      now: late,
    });
    await new SchedulesService(db, triggers).tick({
      identity,
      projectId,
      now: late,
    });
    const runs = triggered.filter((run) => run.workflowName === "longReminder");
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)?.input).toMatchObject({ scheduledFor: at });
    await watchers.stopForSessions({
      identity,
      projectId,
      sessionIds: [sessionId],
    });
    expect(
      (await watchers.list({ identity, projectId, sessionId })).find(
        (item) => item.id === reminder.id,
      )?.status,
    ).toBe("stopped");
  });
});
