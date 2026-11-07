import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CatamorphicCore, type Identity } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type { EnvironmentProvider } from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { z } from "zod";
import type { HarnessAdapter } from "../../../packages/agent-protocol/src/runner.js";
import { LocalProcessSandboxProvider } from "../../../packages/local-process/src/index.js";
import { confinedWorkflowEnvironment } from "../../../scripts/customization-eval/confinement.js";
import type { EvalFixture } from "../../../scripts/customization-eval/fixture.js";
import type { Grade } from "../../../scripts/customization-eval/grade.js";
import { sourceFiles } from "../../../scripts/customization-eval/sdk.js";
import { customizationStateKey } from "../src/main/customization-address.js";
import { customizationWorkflowCall } from "../src/main/customization-workflow.js";
import {
  moduleAccessSubject,
  readModuleAccess,
} from "../src/main/module-access.js";
import { DESKTOP_TRIGGER_KINDS } from "../src/main/server/trigger-kinds.js";

/** An actual durable Work host. No fake workflow executor or notification service. */
export async function createPrivateCustomizationEvalHost(input: {
  project: string;
  directory: string;
  adapter: HarnessAdapter;
  scenario?: "todo-sidebar" | "private-reminder";
  /** Tests may run in Node, while workflow execution always uses Bun. */
  bunPath?: string;
}): Promise<EvalFixture> {
  const schema = "customization_eval";
  const storage = path.join(input.directory, "host-state");
  await mkdir(storage, { recursive: true });
  const database = path.join(storage, "database");
  const identity: Identity = {
    tenantId: randomUUID(),
    externalUserId: "eval-owner",
  };
  const projectId = randomUUID();
  const stateKey = "todos/reminder";
  const title = "Review launch notes";
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const delivered: Array<{ title: string; owner: string }> = [];
  const sandboxes = new TestSandboxes();
  const sandboxRoot = path.join(storage, "sandboxes");
  const provider = sandboxes.track(
    new LocalProcessSandboxProvider({
      root: sandboxRoot,
      env: await confinedWorkflowEnvironment({
        directory: input.directory,
        sandboxRoot,
        bun: input.bunPath ?? process.execPath,
      }),
    }),
  );
  const environmentProvider: EnvironmentProvider = {
    get: ({ allocationBindingId, pool }) =>
      (!allocationBindingId || allocationBindingId === "local") &&
      Object.keys(pool).length === 0
        ? {
            descriptor: {
              id: "local",
              label: "Isolated eval",
              trust: "local",
              isolation: "none",
              workloads: ["workflow", "agent"],
              agentTopologies: [
                "controller",
                "native",
                "contained",
                "external",
              ],
              capabilities: [],
              resources: {},
            },
            sandboxProvider: provider,
          }
        : undefined,
  };
  const manager = new ProjectManager(
    new FsBackend(path.join(storage, "copies"), async () => input.project),
    new FsRemoteBackend(path.join(storage, "origins")),
    async () => input.project,
  );
  const connect = async () => {
    const pglite = new PGlite(database, { extensions: { pgcrypto } });
    const db = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new WithSchemaPlugin(schema)],
    });
    // Match the embedded host: raw worker queries also need the session scope.
    await sql.raw(`SET search_path TO "${schema}", public`).execute(db);
    const core = new CatamorphicCore({
      hostId: "customization-eval-host",
      codingAgent: {
        id: input.adapter.id,
        harness: { placement: "host", adapter: input.adapter },
        topology: "native",
        sandboxing: "publish",
      },
      db,
      projectManager: manager,
      environmentProvider,
      sandboxProvider: provider,
      triggerKinds: DESKTOP_TRIGGER_KINDS,
      notificationTransport: {
        send: async (event) => {
          delivered.push({
            title: event.title,
            owner: event.identity.externalUserId,
          });
        },
      },
    });
    return { db, core };
  };
  let host = await connect();
  await migrateToLatest({ db: host.db, schema });
  await host.db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "Eval" })
    .execute();
  await host.db
    .insertInto("projects")
    .values({
      id: projectId,
      tenant_id: identity.tenantId,
      name: "Customization eval",
    })
    .execute();
  const sessionId = randomUUID();
  const allocation = await host.core.executionAllocations.create({
    identity,
    projectId,
    environmentName: "local",
    workloadKind: "agent",
    rootWorkloadId: sessionId,
    policy: {
      binding: {
        id: "local",
        label: "Isolated eval",
        trust: "local",
        isolation: "none",
        workloads: ["agent", "workflow"],
        agentTopologies: ["native"],
        capabilities: [],
        resources: {},
      },
      requirements: { workload: "agent" },
    },
  });
  await host.db
    .insertInto("agent_sessions")
    .values({
      id: sessionId,
      project_id: projectId,
      external_user_id: identity.externalUserId,
      allocation_id: allocation.id,
      title: "Customization evaluation",
      agent_id: input.adapter.id,
    })
    .execute();
  const gateway = host.core.agentCapabilities.forSession({
    identity,
    projectId,
    sessionId,
    allocationId: allocation.id,
  });
  const page = await gateway.discover({
    query: "private notifications",
    limit: 20,
  });
  const capabilities = page.items.filter(
    (item) =>
      item.name.startsWith("private.") || item.name === "notifications.publish",
  );
  const names = new Map(
    capabilities.map((capability) => [
      capability.name.replaceAll(".", "_"),
      capability,
    ]),
  );
  return {
    context: { sessionId, projectId },
    tools: [...names].map(([name, capability]) => ({
      name,
      description: capability.description,
      inputSchema: z.record(z.string(), z.json()).parse(capability.inputSchema),
    })),
    sourceWork: ({ modulePath }) => {
      const frozen = readModuleAccess({
        projectRoot: input.project,
        modulePath,
      });
      const subject = moduleAccessSubject({
        projectId,
        projectRoot: input.project,
        modulePath,
        declaration: frozen,
      });
      const stateCall = z.discriminatedUnion("op", [
        z.object({
          op: z.literal("state-read"),
          key: z.string().min(1).max(200),
        }),
        z.object({
          op: z.literal("state-write"),
          key: z.string().min(1).max(200),
          value: z.json(),
          ifVersion: z.number().int().nonnegative(),
        }),
        z.object({
          op: z.literal("state-delete"),
          key: z.string().min(1).max(200),
          ifVersion: z.number().int().nonnegative(),
        }),
      ]);
      return async (_requestId, raw) => {
        const workflowCall = z
          .union([
            z.object({
              op: z.enum(["call", "start"]),
              workflow: z.string().max(500),
              input: z.json().optional(),
            }),
            z.object({ op: z.literal("poll-run"), runId: z.string().max(200) }),
          ])
          .safeParse(raw);
        const parsed = stateCall.safeParse(raw);
        if (!parsed.success && !workflowCall.success)
          throw new Error(
            "The sidebar evaluation host supports work.state operations only, plus declared workflow calls.",
          );
        const current = readModuleAccess({
          projectRoot: input.project,
          modulePath,
        });
        if (
          moduleAccessSubject({
            projectId,
            projectRoot: input.project,
            modulePath,
            declaration: current,
          }) !== subject
        )
          throw new Error(
            "This source's package changed. Reload it to review its access.",
          );
        if (workflowCall.success)
          return customizationWorkflowCall({
            core: host.core,
            identity,
            projectId,
            workflows: (frozen.access.workflows ?? []).filter((w) =>
              current.access.workflows?.includes(w),
            ),
            call: workflowCall.data,
          });
        if (!parsed.success) throw Error("Invalid source call.");
        if (
          !frozen.access.permissions?.includes("state") ||
          !current.access.permissions?.includes("state")
        )
          throw new Error(
            "This package needs state in catamorphic.access.permissions at process start and at the time of the call.",
          );
        const call = parsed.data;
        const address = customizationStateKey({ subject, key: call.key });
        if (call.op === "state-delete")
          return host.core.privateState.delete({
            identity,
            projectId,
            key: address,
            ifVersion: call.ifVersion,
          });
        const snapshot =
          call.op === "state-read"
            ? await host.core.privateState.read({
                identity,
                projectId,
                key: address,
              })
            : await host.core.privateState.write({
                identity,
                projectId,
                key: address,
                value: call.value,
                ifVersion: call.ifVersion,
              });
        return { ...snapshot, key: call.key, address };
      };
    },
    seed: async () => {
      await writeFile(
        path.join(input.project, "work-host.d.ts"),
        host.core.triggers.typesModuleContent(),
      );
      if (input.scenario !== "todo-sidebar")
        await writeFile(
          path.join(input.project, "reminder-request.json"),
          JSON.stringify({ title, dueAt, stateKey }, null, 2),
        );
      await writeFile(
        path.join(input.project, "PRIVATE-WORKFLOWS.md"),
        `Private state is versioned JSON, partitioned by the caller. Missing state has version 0.\nPrivate workflow source is retained outside project files, with a member lifetime independent of a chat.\nA source revision becomes active using private_workflow preview and activate with its consent digest.\nThis evaluation supplies staged SDK dependencies; workflow execution has no outbound network or install lifecycle hooks, source and runtime payloads are read-only, and sandbox data directories are writable.\nWorkflows are ordinary @catamorphic/workflow defineWorkflow values, for example:\n\nimport { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";\nexport const reminder = defineWorkflow(({ defineBoundary }) => ({\n  permissions: ["notifications:write"],\n  triggers: [trigger("schedule", { at: "2026-11-06T12:00:00Z" })],\n  steps: [defineBoundary({ run: ({ host }: BoundaryContext<unknown>) =>\n    host["catamorphic.notifications"].publish({ title: "A reminder", idempotencyKey: "stable-event-key" })\n  })]\n}));\n\nHost capability calls return transitions from boundaries; the ordinary run worker executes and journals them.\nNo session, sidebar process, model turn, filesystem lock, or system job is required for schedule delivery.\nNotifications publish accepts {title,body?,route?,idempotencyKey}. route is optional; when present it must be a local path starting with /, never a file:/app: resource address. Omit it if no destination is needed.\n`,
      );
    },
    invoke: async (call) => {
      const capability = names.get(call.name);
      if (!capability)
        throw new Error(`Unknown private capability ${call.name}`);
      return z.json().parse(
        await gateway.invoke({
          name: capability.name,
          input: z.record(z.string(), z.json()).parse(call.input),
        }),
      );
    },
    grade: async () => {
      if (input.scenario === "todo-sidebar") {
        const grades: Grade[] = [];
        try {
          const artifacts = await host.core.sessionArtifacts.list({
            identity,
            projectId,
            lifetime: "member",
          });
          const active = artifacts.filter(
            (a) => a.kind === "workflow" && a.workflowEnablementId,
          );
          if (!active.length)
            throw Error("No member-owned reminder workflow is active.");
          await writeFile(
            path.join(input.directory, "private-source.json"),
            JSON.stringify(
              await Promise.all(
                active.map(async (artifact) => ({
                  artifact,
                  files: await host.core.sessionArtifacts.files({
                    identity,
                    projectId,
                    artifactId: artifact.id,
                  }),
                })),
              ),
              null,
              2,
            ),
          );
          const runs = await host.db
            .selectFrom("workflow_runs")
            .select("id")
            .where("project_id", "=", projectId)
            .where(
              "session_artifact_id",
              "in",
              active.map((a) => a.id),
            )
            .orderBy("created_at", "desc")
            .limit(3)
            .execute();
          if (runs.length < 3)
            throw Error(
              "Manual reminders did not enroll ordinary private workflow runs.",
            );
          if (!host.core.agentSessions)
            throw Error("Session service is unavailable.");
          await host.core.agentSessions.archive(
            identity,
            projectId,
            sessionId,
            { confirmStop: true },
          );
          await host.core.runs.stopWorkers();
          await host.db.destroy();
          host = await connect();
          // Inline calls yield at durable waits; the ordinary timeout handler
          // advances them when due, without simulating time or bypassing consent.
          host.core.runs.startWorker({
            name: "eval-reminder-timeouts",
            kinds: ["durable_pause_timeout"],
            pollIntervalMs: 50,
            idlePollIntervalMs: 200,
          });
          const deadline = Date.now() + 90000;
          while (
            Date.now() < deadline &&
            !delivered.some((e) => e.title === "Manually added custom reminder")
          ) {
            const failed = await host.db
              .selectFrom("workflow_runs")
              .select(["id", "error"])
              .where(
                "id",
                "in",
                runs.map((r) => r.id),
              )
              .where("status", "=", "failed")
              .execute();
            if (failed.length)
              throw Error(`Manual reminder failed: ${JSON.stringify(failed)}`);
            for (const run of runs)
              await host.core.runs.driveInline({
                tenantId: identity.tenantId,
                runId: run.id,
                deadline: Date.now() + 5000,
              });
            await host.core.notifications.drain("eval-manual");
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          await host.core.notifications.drain("eval-manual-replay");
          const matches = delivered.filter(
            (e) =>
              e.title === "Manually added custom reminder" &&
              e.owner === identity.externalUserId,
          );
          if (matches.length !== 1 || delivered.length !== 1)
            throw Error(
              `Expected only one custom-reminder notification after restart and no early preset alerts, got ${JSON.stringify(delivered)}.`,
            );
          if (
            (await host.db.selectFrom("agent_turns").select("id").execute())
              .length
          )
            throw Error("Reminder delivery created an agent turn.");
          grades.push({
            id: "manual-reminder-after-host-restart",
            passed: true,
            detail:
              "Manual Add enrolled ordinary private runs; after chat archive and full DB/Core reopen, the custom reminder notifies its owner once without an agent turn",
          });
        } catch (error) {
          grades.push({
            id: "manual-reminder-after-host-restart",
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await host.core.runs.stopWorkers();
        }
        return grades;
      }
      const grades: Grade[] = [];
      const check = async (id: string, test: () => Promise<string>) => {
        try {
          grades.push({ id, passed: true, detail: await test() });
        } catch (error) {
          grades.push({
            id,
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const assert = (condition: unknown, message: string) => {
        if (!condition) throw new Error(message);
      };
      await check("private-state", async () => {
        const state = await host.core.privateState.read({
          identity,
          projectId,
          key: stateKey,
        });
        const text = JSON.stringify(state.value);
        assert(
          state.version > 0 && text.includes(title) && text.includes(dueAt),
          "Requested todo was not saved to versioned private state",
        );
        const other = await host.core.privateState.read({
          identity: { ...identity, externalUserId: "other-member" },
          projectId,
          key: stateKey,
        });
        assert(other.value === null, "Another member can see the private todo");
        return "Only the requesting member can read the saved todo";
      });
      await check("private-active-workflow", async () => {
        const artifacts = await host.core.sessionArtifacts.list({
          identity,
          projectId,
          lifetime: "member",
        });
        assert(artifacts.length > 0, "Agent created no member-owned workflow");
        assert(
          artifacts.some(
            (artifact) =>
              artifact.kind === "workflow" &&
              artifact.sessionId === null &&
              artifact.workflowEnablementId,
          ),
          "No private workflow is active independently of its chat",
        );
        const sources = await Promise.all(
          artifacts.map(async (artifact) => ({
            artifact,
            files: await host.core.sessionArtifacts.files({
              identity,
              projectId,
              artifactId: artifact.id,
            }),
          })),
        );
        await writeFile(
          path.join(input.directory, "private-source.json"),
          JSON.stringify(sources, null, 2),
        );
        const other = await host.core.sessionArtifacts.list({
          identity: { ...identity, externalUserId: "other-member" },
          projectId,
          lifetime: "member",
        });
        assert(
          other.length === 0,
          "Another member can list private workflow source",
        );
        try {
          await access(path.join(input.project, ".git"));
          throw new Error(
            "Private workflow initialized Git in the user's plain folder",
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
        return "Private source is active, caller-owned, and leaves the plain folder inert";
      });
      await check("no-early-notification", async () => {
        await host.core.schedules.tick({
          identity,
          projectId,
          now: new Date(new Date(dueAt).getTime() - 1_000),
        });
        assert(
          (await host.core.notifications.drain("eval-before-due")) === 0 &&
            delivered.length === 0,
          "Reminder was published before its due time",
        );
        return "The durable schedule stays quiet before its due time";
      });
      await check("private-source-location", async () => {
        for (const file of await sourceFiles(input.project)) {
          if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
          if ((await readFile(file, "utf8")).includes("defineWorkflow("))
            throw new Error(
              `Private workflow source remains in project file ${path.relative(input.project, file)}`,
            );
        }
        return "Workflow source is retained by the private host, outside shared project files";
      });
      await check("restart-due-delivery-once", async () => {
        const sessions = host.core.agentSessions;
        if (!sessions)
          throw new Error("The eval host's session service is unavailable");
        await sessions.archive(identity, projectId, sessionId, {
          confirmStop: true,
        });
        await host.core.runs.stopWorkers();
        await host.db.destroy();
        host = await connect();
        const state = await host.core.privateState.read({
          identity,
          projectId,
          key: stateKey,
        });
        assert(
          state.version > 0,
          "Private state disappeared after reopening the database",
        );
        const now = new Date(new Date(dueAt).getTime() + 1_000);
        await host.core.schedules.tick({ identity, projectId, now });
        const runs = await host.db
          .selectFrom("workflow_runs")
          .select(["id", "status"])
          .where("project_id", "=", projectId)
          .execute();
        assert(
          runs.length > 0,
          "Scheduler did not enroll a due private workflow after restart",
        );
        for (const run of runs) {
          const result = await host.core.runs.driveInline({
            tenantId: identity.tenantId,
            runId: run.id,
            deadline: Date.now() + 60_000,
          });
          assert(
            result.status === "completed",
            `Reminder run ended ${result.status}${result.status === "failed" ? `: ${result.error}` : ""}`,
          );
        }
        await host.core.notifications.drain("eval-after-restart");
        await host.core.schedules.tick({ identity, projectId, now });
        await host.core.notifications.drain("eval-after-replay");
        assert(
          delivered.length === 1 &&
            delivered[0]?.title === title &&
            delivered[0]?.owner === identity.externalUserId,
          `Expected one caller-bound notification, got ${JSON.stringify(delivered)}`,
        );
        const turns = await host.db
          .selectFrom("agent_turns")
          .select("id")
          .execute();
        assert(turns.length === 0, "Reminder delivery created an agent turn");
        return "Real scheduler and run worker deliver once after a full host/database reopen, without an agent turn";
      });
      return grades;
    },
    close: async () => {
      await cleanupTestResources([
        () => host.core.runs.stopWorkers(),
        () => sandboxes.cleanup(),
        () => host.db.destroy(),
      ]);
    },
  };
}
