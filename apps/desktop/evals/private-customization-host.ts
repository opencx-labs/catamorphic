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
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { z } from "zod";
import type { HarnessAdapter } from "../../../packages/agent-protocol/src/runner.js";
import { LocalProcessSandboxProvider } from "../../../packages/local-process/src/index.js";
import { confinedWorkflowEnvironment } from "../../../scripts/customization-eval/confinement.js";
import type { EvalFixture } from "../../../scripts/customization-eval/fixture.js";
import type { Grade } from "../../../scripts/customization-eval/grade.js";
import { sourceFiles } from "../../../scripts/customization-eval/sdk.js";
import { customizationStateKey } from "../src/main/customization-address.js";
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
        bun: process.execPath,
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
  const connect = () => {
    const pglite = new PGlite(database, { extensions: { pgcrypto } });
    const db = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new WithSchemaPlugin(schema)],
    });
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
  let host = connect();
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
        const parsed = stateCall.safeParse(raw);
        if (!parsed.success)
          throw new Error(
            "The sidebar evaluation host supports work.state operations only.",
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
      if (input.scenario === "todo-sidebar") return;
      await writeFile(
        path.join(input.project, "work-host.d.ts"),
        host.core.triggers.typesModuleContent(),
      );
      await writeFile(
        path.join(input.project, "reminder-request.json"),
        JSON.stringify({ title, dueAt, stateKey }, null, 2),
      );
      await writeFile(
        path.join(input.project, "PRIVATE-WORKFLOWS.md"),
        `Private state is versioned JSON, partitioned by the caller. Missing state has version 0.\nPrivate workflow source is retained outside project files, with a member lifetime independent of a chat.\nA source revision becomes active using private_workflow preview and activate with its consent digest.\nThis evaluation supplies staged SDK dependencies; workflow execution has no outbound network or install lifecycle hooks, source and runtime payloads are read-only, and sandbox data directories are writable.\nWorkflows are ordinary @catamorphic/workflow defineWorkflow values, for example:\n\nimport { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";\nexport const reminder = defineWorkflow(({ defineBoundary }) => ({\n  permissions: ["notifications:write"],\n  triggers: [trigger("schedule", { at: "2026-11-06T12:00:00Z" })],\n  steps: [defineBoundary({ run: ({ host }: BoundaryContext<unknown>) =>\n    host["catamorphic.notifications"].publish({ title: "A reminder", idempotencyKey: "stable-event-key" })\n  })]\n}));\n\nHost capability calls return transitions from boundaries; the ordinary run worker executes and journals them.\nNo session, sidebar process, model turn, filesystem lock, or system job is required for schedule delivery.\n`,
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
      if (input.scenario === "todo-sidebar") return [];
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
        host = connect();
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
