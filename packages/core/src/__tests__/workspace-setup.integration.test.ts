import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import {
  type CreateSandboxOpts,
  type EnvironmentProvider,
  type EnvironmentRuntimeBinding,
  SANDBOX_CAPABILITIES,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { PersonalEnvironmentService } from "../services/personal-environment-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { RecordingAdapter } from "./recording-adapter.js";

/**
 * Workspace setup in chats (ADR 0208): an Environment's `setup` runs once
 * per workspace before its first turn, again when the command changes or
 * the workspace is rebuilt, with the session's secrets and after it the
 * owner's own setup; a failure is told to the agent and runs again next
 * turn. A new workspace that got an empty exclusive volume says so.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_setup_${randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const tenantId = randomUUID();
const ada: Identity = { tenantId, externalUserId: "ada" };
const bob: Identity = { tenantId, externalUserId: "bob" };
const cy: Identity = { tenantId, externalUserId: "cy" };

describeIf("workspace setup in chats (ADR 0208)", () => {
  let tmpDir: string;
  let runs: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let personal: PersonalEnvironmentService;
  let machine: LocalProcessSandboxProvider;
  const allocations = () => new ExecutionAllocationsService(db!);
  const adapter = new RecordingAdapter();
  /** What each sandbox was created with; volumes stop here. */
  const created: CreateSandboxOpts[] = [];

  const writeManifest = async (dev: Record<string, unknown>) => {
    const repo = await projectManager.open(tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            dev: {
              workloads: ["agent"],
              personalCredentials: true,
              volumes: {
                cache: "~/.cache/tools",
                data: { path: "~/.local/share/db", exclusive: true },
              },
              ...dev,
            },
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
  };

  /** One line per setup part that ran, in order. */
  const ranLines = async () =>
    (await fs.readFile(runs, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

  const send = async (identity: Identity, sessionId: string, text: string) => {
    const result = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      text,
    );
    expect(result.turn.status).toBe("completed");
    return {
      turn: result.turn,
      input: adapter.attempts.at(-1)?.input?.text ?? "",
    };
  };

  const sandboxOf = async (sessionId: string) =>
    (
      await db!
        .selectFrom("agent_sessions")
        .innerJoin(
          "project_sandboxes",
          "project_sandboxes.id",
          "agent_sessions.sandbox_id",
        )
        .select("project_sandboxes.provider_id")
        .where("agent_sessions.id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).provider_id;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-setup-"));
    runs = path.join(tmpDir, "runs.log");
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(ada, { name: "Setup" })).id;
    await writeManifest({ setup: `echo "environment v1" >> '${runs}'` });
    machine = new LocalProcessSandboxProvider({
      root: path.join(tmpDir, "machine"),
    });
    // The machine keeps volumes; mounting them is the provider's own work,
    // so this one records them and boots a plain sandbox.
    const keeping = new Proxy(machine, {
      get(target, property) {
        if (property === "createSandbox")
          return async (opts: CreateSandboxOpts) => {
            created.push(opts);
            const { volumes: _volumes, ...rest } = opts;
            return target.createSandbox(rest);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) satisfies SandboxProvider;
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [SANDBOX_CAPABILITIES.volumes],
        resources: {},
      },
      sandboxProvider: keeping,
    };
    const environmentProvider: EnvironmentProvider = {
      get: ({ allocationBindingId }) =>
        !allocationBindingId || allocationBindingId === "machine"
          ? binding
          : undefined,
    };
    const projectEnvironments = new ProjectEnvironmentsService(
      db,
      projectManager,
    );
    personal = new PersonalEnvironmentService({
      db,
      vault: new MemoryCredentialVault(),
      environments: projectEnvironments,
    });
    const agent: RegisteredCodingAgent = {
      id: "worker",
      harness: { placement: "host", adapter },
      topology: "controller",
    };
    sessions = new AgentSessionsService(db, {
      hostId: "setup-test-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        projectEnvironments,
        environmentProvider,
      ),
      executionAllocations: allocations(),
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      personalEnvironments: personal,
    });
  }, 120_000);

  afterAll(async () => {
    await sessions?.stopLocalTurns();
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    if (tmpDir)
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("runs once per workspace, again when it changes or the workspace is rebuilt, and shows it in the chat", async () => {
    const chat = await sessions.create(ada, projectId);
    const first = await send(ada, chat.id, "first");
    expect(await ranLines()).toEqual(["environment v1"]);
    expect(first.input).not.toContain("[Workspace] Setting up");
    // The chat showed the setup while the turn prepared.
    const shown = await db!
      .selectFrom("agent_session_events")
      .select("payload")
      .where("session_id", "=", chat.id)
      .where("type", "=", "turn.changed")
      .where(
        sql<boolean>`payload->'turn'->>'activity' = 'Setting up the workspace'`,
      )
      .where(sql<boolean>`payload->'turn'->>'id' = ${first.turn.id}`)
      .execute();
    expect(shown.length).toBeGreaterThan(0);
    const sandbox = await sandboxOf(chat.id);
    expect(
      (
        await machine.executeCommand(
          sandbox,
          "cat ../.work-session/setup.log",
          { cwd: "/workspace/project" },
        )
      ).result,
    ).toContain("Workspace setup finished");

    await send(ada, chat.id, "second");
    expect(await ranLines()).toEqual(["environment v1"]);

    await writeManifest({ setup: `echo "environment v2" >> '${runs}'` });
    await send(ada, chat.id, "third");
    expect(await ranLines()).toEqual(["environment v1", "environment v2"]);

    // A workspace given back while idle is rebuilt, and set up again.
    const allocationId = (
      await db!
        .selectFrom("agent_sessions")
        .select("allocation_id")
        .where("id", "=", chat.id)
        .executeTakeFirstOrThrow()
    ).allocation_id;
    await allocations().release({
      identity: ada,
      allocationId: allocationId ?? "",
      reason: "idle",
    });
    await send(ada, chat.id, "fourth");
    expect(await sandboxOf(chat.id)).not.toBe(sandbox);
    expect(await ranLines()).toEqual([
      "environment v1",
      "environment v2",
      "environment v2",
    ]);
  }, 120_000);

  it("loads the chat's secrets and runs the owner's own setup only for the owner", async () => {
    await fs.rm(runs, { force: true });
    await writeManifest({
      setup: `echo "environment \${DEMO_TOKEN:-none}" >> '${runs}'`,
    });
    await personal.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: `echo "personal ada" >> '${runs}'` },
    });
    await personal.replace({
      identity: bob,
      projectId,
      input: { files: [], setup: `echo "personal bob" >> '${runs}'` },
    });
    const chat = await sessions.create(ada, projectId);
    await send(ada, chat.id, "first");
    expect(await ranLines()).toEqual(["environment none", "personal ada"]);
    // Secrets are written before setup (ADR 0206); setup loads them.
    await machine.uploadFiles(
      await sandboxOf(chat.id),
      { "secrets.sh": "export DEMO_TOKEN=from-secrets\n" },
      "/workspace/.work-session/env",
    );
    await writeManifest({
      setup: `echo "environment \${DEMO_TOKEN:-none} v2" >> '${runs}'`,
    });
    await send(ada, chat.id, "second");
    expect((await ranLines()).slice(2)).toEqual([
      "environment from-secrets v2",
      "personal ada",
    ]);
    // Bob's chat runs only the Environment's setup: his own setup reaches
    // only his chats, and Ada's never reaches his.
    const bobs = await sessions.create(bob, projectId);
    await send(bob, bobs.id, "mine");
    expect((await ranLines()).slice(4)).toEqual([
      "environment none v2",
      "personal bob",
    ]);
  }, 120_000);

  it("tells the agent when setup fails and runs it again before the next turn", async () => {
    await fs.rm(runs, { force: true });
    await personal.remove({ identity: ada, projectId });
    const flag = path.join(tmpDir, "fail");
    await fs.writeFile(flag, "");
    await writeManifest({
      setup: `echo "attempt" >> '${runs}'\nif [ -f '${flag}' ]; then echo "boom: the registry is down"; exit 3; fi\necho "installed" >> '${runs}'`,
    });
    const chat = await sessions.create(ada, projectId);
    const failed = await send(ada, chat.id, "first");
    expect(failed.input).toContain(
      "[Workspace] Setting up this workspace failed with exit code 3",
    );
    expect(failed.input).toContain("boom: the registry is down");
    expect(failed.input).toContain("runs again before the next turn");
    const again = await send(ada, chat.id, "second");
    expect(again.input).toContain("failed with exit code 3");
    expect(await ranLines()).toEqual(["attempt", "attempt"]);
    await fs.rm(flag);
    const fixed = await send(ada, chat.id, "third");
    expect(fixed.input).not.toContain("[Workspace] Setting up");
    expect(await ranLines()).toEqual([
      "attempt",
      "attempt",
      "attempt",
      "installed",
    ]);
    await send(ada, chat.id, "fourth");
    expect(await ranLines()).toHaveLength(4);
  }, 120_000);

  it("mounts the owner's volumes and says when an exclusive one is held by another workspace", async () => {
    await writeManifest({});
    const before = created.length;
    const first = await sessions.create(cy, projectId);
    const opened = await send(cy, first.id, "first");
    expect(opened.input).not.toContain("holds the data volume");
    expect(created.at(-1)?.volumes).toEqual([
      expect.objectContaining({ path: "~/.cache/tools" }),
      expect.objectContaining({ path: "~/.local/share/db", exclusive: true }),
    ]);
    const second = await sessions.create(cy, projectId);
    const held = await send(cy, second.id, "second");
    expect(created.length).toBe(before + 2);
    expect(
      created.at(-1)?.volumes?.find((volume) => volume.exclusive)?.temporary,
    ).toBe(true);
    expect(held.input).toContain(
      "[Workspace] Another chat of yours on this machine holds the data volume",
    );
    // Told once, when the workspace was made.
    const later = await send(cy, second.id, "later");
    expect(later.input).not.toContain("holds the data volume");
  }, 120_000);
});
