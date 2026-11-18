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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  AgentDelegationSettingsError,
  AgentSessionsService,
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
    const machine = ownedSandboxes.track(
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
    const allocations = new ExecutionAllocationsService(db);
    sessions = new AgentSessionsService(db, {
      hostId: "separated-shapes-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        {
          get: ({ allocationBindingId }) =>
            !allocationBindingId || allocationBindingId === "machine"
              ? binding
              : undefined,
        },
      ),
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
