import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EchoAdapter } from "@catamorphic/agent-runner";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  CreateSandboxOpts,
  EnvironmentRuntimeBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentDelegationSettingsError,
  AgentSessionsService,
  AgentTurnUnsettledError,
} from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ConnectionAdmissionService } from "../services/connection-admission.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import type { ResolvedConnectionBinding } from "../services/connection-types.js";
import type { ConnectionsService } from "../services/connections-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";

/**
 * A separated sandbox's shape follows where its chat's harness runs (ADR
 * 0332), end to end through the service: a built-in agent's workspace is
 * one container with no agent share; an agent whose harness runs in the
 * sandbox cannot share it (its spawn is refused, saying to take a
 * workspace of its own), and a chat whose agent now runs in the sandbox
 * gets a workspace with an agent container at its next turn, rather than
 * failing every turn.
 */

const execFileAsync = promisify(execFile);
const ownedSandboxes = new TestSandboxes();
const SCHEMA = "catamorphic_separated_shapes";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(SCHEMA)],
});
const identity: Identity = {
  tenantId: "55555555-5555-4555-8555-555555555555",
  externalUserId: "ada",
};
const MODEL_CONNECTION = "66666666-6666-4666-8666-666666666666";

/** The sandboxed agent's model connection, as its Environment binds it. */
class ModelAdmission extends ConnectionAdmissionService {
  override async admit(): Promise<ResolvedConnectionBinding[]> {
    return [
      {
        connectionId: MODEL_CONNECTION,
        alias: "model",
        providerKind: "anthropic",
        principalKind: "project_service",
        capabilities: ["model"],
      },
    ];
  }
}

async function until(
  what: string,
  check: () => Promise<boolean>,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a separated sandbox's shape follows its chat's harness (ADR 0332)", () => {
  let tmpDir: string;
  let projectId: string;
  let sessions: AgentSessionsService;
  let environments: ExecutionEnvironmentsService;
  let machine: LocalProcessSandboxProvider;
  /** What each sandbox was asked to separate: undefined for one container. */
  const asked: Array<CreateSandboxOpts["separateCommands"]> = [];
  /** The registry, whose agents a project can redefine under the same id. */
  const agents = new Map<string, RegisteredCodingAgent>();

  /** As the built-in agent: its harness on this host, driving the sandbox. */
  const builtin = (id: string): RegisteredCodingAgent => ({
    id,
    harness: { placement: "host", adapter: new EchoAdapter() },
    topology: "controller",
    // The same bindings as the sandboxed agent, so only the shape differs.
    connectionRequirements: ["model"],
    delegation: {
      enabled: true,
      maxConcurrentChildren: 2,
      agents: [
        { agent: "coder", model: "any", effort: "any", delegate: false },
        { agent: "helper", model: "any", effort: "any", delegate: false },
      ],
    },
  });
  /** As Claude Code on a server: its harness in the chat's sandbox. */
  const sandboxed = (id: string): RegisteredCodingAgent => ({
    id,
    harness: { placement: "sandbox", id: "echo" },
    topology: "controller",
    connectionRequirements: ["model"],
    modelConnection: "model",
  });

  const allocationOf = async (sessionId: string) => {
    const row = await db
      .selectFrom("agent_sessions")
      .innerJoin(
        "execution_allocations",
        "execution_allocations.id",
        "agent_sessions.allocation_id",
      )
      .select([
        "execution_allocations.id",
        "execution_allocations.policy_snapshot",
        "execution_allocations.reserved_memory_mb",
      ])
      .where("agent_sessions.id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const policy = row.policy_snapshot as {
      sandbox?: { separateCommands?: { agentResources?: unknown } };
    };
    return { id: row.id, separate: policy.sandbox?.separateCommands };
  };

  beforeAll(async () => {
    await migrateToLatest({ db, schema: SCHEMA });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "separated-shapes-"));
    const seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    const git = (args: string[]) =>
      execFileAsync("git", [
        "-C",
        seed,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ]);
    await git(["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(seed, "README.md"), "main\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "main"]);
    const remote = path.join(tmpDir, "remote.git");
    await execFileAsync("git", ["clone", "-q", "--bare", seed, remote]);

    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(identity, { name: "Reviews" })).id;
    await db
      .updateTable("projects")
      .set({ remote_url: remote, remote_ownership: "attached" })
      .where("id", "=", projectId)
      .execute();
    const repo = await projectManager.open(identity.tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            review: {
              workloads: ["agent"],
              commands: { separate: true },
            },
            // Its machines all busy: chats wait for one (ADR 0258).
            busy: {
              workloads: ["agent"],
              commands: { separate: true },
              pool: { lane: "busy" },
              waitMinutes: 30,
              requirements: { resources: { cpuMillis: 2000, memoryMb: 4096 } },
            },
          },
          defaultEnvironment: "review",
        }),
      );
      await repo.commit("Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
    await db
      .insertInto("connections")
      .values({
        id: MODEL_CONNECTION,
        tenant_id: identity.tenantId,
        project_id: projectId,
        provider_kind: "anthropic",
        principal_kind: "project_service",
        label: "Model",
        name: "model",
      })
      .execute();

    // A machine that runs commands apart: here one process sandbox, which
    // records what it was asked to separate.
    machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
    const separating = new Proxy(machine, {
      get(target, property, receiver) {
        if (property === "createSandbox")
          return (opts: CreateSandboxOpts) => {
            asked.push(opts.separateCommands);
            const { separateCommands: _separate, ...rest } = opts;
            return target.createSandbox(rest);
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SandboxProvider;
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: ["commands.separate"],
        resources: {},
      },
      sandboxProvider: separating,
    };
    agents.set("reviewer", builtin("reviewer"));
    agents.set("coder", sandboxed("coder"));
    agents.set("helper", builtin("helper"));
    const allocations = new ExecutionAllocationsService(db);
    environments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      {
        get: ({ allocationBindingId, pool }) =>
          pool.lane === "busy"
            ? undefined
            : !allocationBindingId || allocationBindingId === "machine"
              ? binding
              : undefined,
      },
    );
    sessions = new AgentSessionsService(db, {
      hostId: "separated-shapes-host",
      projectManager,
      executionEnvironments: environments,
      executionAllocations: allocations,
      codingAgents: {
        defaultAgentId: () => "reviewer",
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      },
      workspaces: new SessionWorkspaces({
        projectManager,
        origin: async () => ({ url: remote }),
      }),
      connectionAdmission: new ModelAdmission(
        undefined as unknown as ConnectionsService,
      ),
      connectionGrants: new ConnectionCapabilityGrantsService(db, allocations),
      sandboxGateway: {
        url: () => "http://work.acme.test/gateway",
        remoteBaseUrls: () => undefined,
        modelApi: () => "anthropic",
        servesHttp: () => false,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await cleanupTestResources(
      [
        () => sessions?.stopLocalTurns(),
        () => ownedSandboxes.cleanup(),
        () => db.destroy(),
      ],
      () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
    );
  });

  /** The machine's id of a chat's sandbox. */
  const sandboxOf = async (sessionId: string) =>
    (
      await db
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
  const latestTurn = async (sessionId: string) =>
    (await db
      .selectFrom("agent_turns")
      .select(["id", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal", "desc")
      .executeTakeFirst()) ?? { id: "", status: "none" };
  /** Sends without waiting for the turn, which may wait for a workspace. */
  const send = (sessionId: string, text: string) =>
    sessions
      .sendMessage(identity, projectId, sessionId, text)
      .catch((error: unknown) => {
        if (!(error instanceof AgentTurnUnsettledError)) throw error;
      });
  /** The chat's agent becomes one whose harness runs in the sandbox. */
  const redefine = () => agents.set("reviewer", sandboxed("reviewer"));
  /** Its workspace is given back as replaced and admitted again, a pair. */
  const reshaped = async (sessionId: string, before: string) => {
    await until(
      "the chat's next turn runs in a reshaped workspace",
      async () =>
        (await latestTurn(sessionId)).status === "completed" &&
        (await allocationOf(sessionId)).id !== before,
      60_000,
    );
    expect(
      (await allocationOf(sessionId)).separate?.agentResources,
    ).toBeDefined();
    expect(
      await db
        .selectFrom("execution_allocations")
        .select(["status", "release_reason"])
        .where("id", "=", before)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "released", release_reason: "replaced" });
  };

  it("keeps a turn's edits when its agent is redefined while it runs, and runs the next turn in a pair", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const chat = await sessions.create(identity, projectId, {});
    const before = (await allocationOf(chat.id)).id;
    const working = sessions.sendMessage(
      identity,
      projectId,
      chat.id,
      "[[wait 6000]] working",
    );
    await until(
      "the turn runs",
      async () => (await latestTurn(chat.id)).status === "running",
    );
    // What the turn changed in its workspace; then its agent is
    // redefined. The turn ends as it began, its edits saved.
    await machine.executeCommand(
      await sandboxOf(chat.id),
      "echo edited > edited.txt",
      { cwd: "/workspace/project" },
    );
    redefine();
    expect((await working).turn.status).toBe("completed");
    await send(chat.id, "hello");
    await reshaped(chat.id, before);
    const read = await machine.executeCommand(
      await sandboxOf(chat.id),
      "cat edited.txt",
      { cwd: "/workspace/project" },
    );
    expect(read.result.trim()).toBe("edited");
  }, 120_000);

  it("keeps a workspace while a shared subsession's turn runs in it, then reshapes it", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const parent = await sessions.create(identity, projectId, {});
    const before = (await allocationOf(parent.id)).id;
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { agentId: "helper", task: "[[wait 12000]] helping" },
    );
    await until(
      "the child works",
      async () => (await latestTurn(child.session.id)).status === "running",
    );
    redefine();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 50,
    });
    try {
      await send(parent.id, "hello");
      // The child is still working: the workspace stays.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect((await latestTurn(child.session.id)).status).toBe("running");
      expect((await allocationOf(parent.id)).id).toBe(before);
      await reshaped(parent.id, before);
      expect((await latestTurn(child.session.id)).status).toBe("completed");
    } finally {
      await worker.stop();
    }
  }, 120_000);

  it("keeps a workspace a person uses now, then reshapes it", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const chat = await sessions.create(identity, projectId, {});
    const before = (await allocationOf(chat.id)).id;
    // A person at its terminal (ADR 0209).
    await db
      .insertInto("session_workspace_use")
      .values({ session_id: chat.id })
      .execute();
    redefine();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 50,
    });
    try {
      await send(chat.id, "hello");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await allocationOf(chat.id)).id).toBe(before);
      expect((await latestTurn(chat.id)).status).toBe("queued");
      // They left a while ago.
      await db
        .updateTable("session_workspace_use")
        .set({ used_at: new Date(Date.now() - 10 * 60_000) })
        .where("session_id", "=", chat.id)
        .execute();
      await reshaped(chat.id, before);
    } finally {
      await worker.stop();
    }
  }, 120_000);

  it("refuses to share a built-in chat's workspace with an agent that runs in the sandbox, saying to take its own", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const parent = await sessions.create(identity, projectId, {});
    // The built-in agent's workspace: commands apart, no agent container.
    expect((await allocationOf(parent.id)).separate).toEqual({
      connections: [],
    });
    const spawn = sessions.createSubsession(identity, projectId, parent.id, {
      agentId: "coder",
      task: "Run the tests",
    });
    await expect(spawn).rejects.toBeInstanceOf(AgentDelegationSettingsError);
    await expect(spawn).rejects.toThrow(/runs in its sandbox/);
    await expect(spawn).rejects.toThrow(/workspace: "own"/);
    // With a workspace of its own it gets one with an agent container.
    const own = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      {
        agentId: "coder",
        task: "Run the tests",
        workspace: "own",
      },
    );
    expect(
      (await allocationOf(own.session.id)).separate?.agentResources,
    ).toBeDefined();
  });

  it("admits a chat's workspace for where its harness runs at creation, at an agent switch and in discovery", async () => {
    agents.set("reviewer", builtin("reviewer"));
    // Created for each agent.
    const chat = await sessions.create(identity, projectId, {});
    expect(
      (await allocationOf(chat.id)).separate?.agentResources,
    ).toBeUndefined();
    const coder = await sessions.create(identity, projectId, {
      agentId: "coder",
    });
    expect(
      (await allocationOf(coder.id)).separate?.agentResources,
    ).toBeDefined();
    // Switched to the agent whose harness runs in the sandbox, and back.
    await sessions.update(identity, projectId, chat.id, { agentId: "coder" });
    expect(
      (await allocationOf(chat.id)).separate?.agentResources,
    ).toBeDefined();
    await sessions.update(identity, projectId, chat.id, {
      agentId: "reviewer",
    });
    expect(
      (await allocationOf(chat.id)).separate?.agentResources,
    ).toBeUndefined();
    // Discovery asks for each agent (the built-in one and the sandboxed
    // one) where its harness runs.
    const discover = vi.spyOn(environments, "discover");
    try {
      await sessions.catalog({ identity, projectId });
      expect(
        new Set(discover.mock.calls.map(([args]) => args.harnessInSandbox)),
      ).toEqual(new Set([false, true]));
    } finally {
      discover.mockRestore();
    }
  }, 120_000);

  it("issues no model grant for a built-in chat's turns, which nothing in its sandbox would read", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const chat = await sessions.create(identity, projectId, {});
    const sent = await sessions.sendMessage(
      identity,
      projectId,
      chat.id,
      "hello",
    );
    expect(sent.turn.status).toBe("completed");
    const grants = await db
      .selectFrom("connection_capability_grants")
      .select(["alias", "model_attempt_id"])
      .where("agent_session_id", "=", chat.id)
      .execute();
    expect(grants.filter((grant) => grant.alias === "model")).toEqual([]);
  }, 120_000);

  it("waits for a machine sized for the agent container only when the chat's harness runs in the sandbox", async () => {
    const waitOf = async (agentId: string) => {
      const chat = await sessions.create(identity, projectId, {
        agentId,
        environment: "busy",
      });
      expect(chat.allocationId).toBeNull();
      // Its message waits for a machine, which sending says.
      await sessions
        .sendMessage(identity, projectId, chat.id, "hello")
        .catch((error: unknown) => {
          if (!(error instanceof AgentTurnUnsettledError)) throw error;
        });
      const recorded = () =>
        db
          .selectFrom("placement_waits")
          .select("requirements")
          .where("root_workload_id", "=", chat.id)
          .executeTakeFirst();
      await until("its wait is recorded", async () =>
        Boolean(await recorded()),
      );
      const row = await recorded();
      return (row?.requirements as { resources?: unknown } | undefined)
        ?.resources;
    };
    agents.set("reviewer", builtin("reviewer"));
    // The built-in agent's workspace is the command container alone.
    expect(await waitOf("reviewer")).toEqual({
      cpuMillis: 2000,
      memoryMb: 4096,
    });
    // A harness in the sandbox adds its container's share (1 CPU, 2 GiB).
    expect(await waitOf("coder")).toEqual({
      cpuMillis: 3000,
      memoryMb: 6144,
    });
  }, 120_000);

  it("gives a chat whose agent now runs in the sandbox a workspace with an agent container at its next turn", async () => {
    agents.set("reviewer", builtin("reviewer"));
    const chat = await sessions.create(identity, projectId, {});
    const before = await allocationOf(chat.id);
    expect(before.separate?.agentResources).toBeUndefined();
    // The project redefines its reviewer under the same id: Claude Code,
    // whose harness runs in the sandbox.
    agents.set("reviewer", sandboxed("reviewer"));
    asked.length = 0;
    const sent = await sessions.sendMessage(
      identity,
      projectId,
      chat.id,
      "hello",
    );
    const statusOf = async () =>
      (
        await db
          .selectFrom("agent_turns")
          .select("status")
          .where("id", "=", sent.turn.id)
          .executeTakeFirstOrThrow()
      ).status;
    await until(
      "the turn settles",
      async () =>
        ["completed", "failed", "interrupted"].includes(await statusOf()),
      60_000,
    );
    const turn = await db
      .selectFrom("agent_turns")
      .select(["status", "error"])
      .where("id", "=", sent.turn.id)
      .executeTakeFirstOrThrow();
    expect(turn, JSON.stringify(turn)).toMatchObject({ status: "completed" });
    // A new workspace, admitted with an agent container and asked for as
    // a pair; the old one given back as replaced.
    const after = await allocationOf(chat.id);
    expect(after.id).not.toBe(before.id);
    expect(after.separate?.agentResources).toBeDefined();
    expect(asked.some((separate) => separate?.agentResources)).toBe(true);
    const old = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("id", "=", before.id)
      .executeTakeFirstOrThrow();
    expect(old).toEqual({ status: "released", release_reason: "replaced" });
  }, 120_000);
});
