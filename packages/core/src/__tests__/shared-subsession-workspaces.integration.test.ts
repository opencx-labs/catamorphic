import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  orderedTurns,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { EnvironmentRuntimeBinding } from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import {
  AgentDelegationDeniedError,
  AgentDelegationSettingsError,
  AgentSessionsService,
  type SetupRunFact,
} from "../services/agent-sessions-service.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ConnectionAdmissionService } from "../services/connection-admission.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import type { ResolvedConnectionBinding } from "../services/connection-types.js";
import type { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SecretsService } from "../services/secrets-service.js";
import { SessionWorkspaces } from "../services/session-workspaces.js";
import { itemFromRow } from "../services/sessions/session-rows.js";

const ownedSandboxes = new TestSandboxes();

/**
 * Subagents of an agent on a Work server (ADR 0322), end to end: the
 * agent's harness runs in its chat's sandbox through the runner bundle, as
 * Claude Code, Codex and ACP agents do there, and reaches its model through
 * the gateway. It is offered Work's subsession tools; a child shares its
 * workspace (no admission, Allocation, sandbox or setup of its own) unless
 * it asks for its own, which starts at the parent's base; the cap refuses
 * an extra child and makes nothing; and a child that settles, wakes later
 * on its own and settles again reaches its working parent both times.
 */

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await execFileAsync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ])
  ).stdout.trim();

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin("catamorphic_shared_subsessions")],
});
const identity: Identity = {
  tenantId: "33333333-3333-4333-8333-333333333333",
  externalUserId: "ada",
};
const MODEL_CONNECTION = "44444444-4444-4444-8444-444444444444";

/** The agent's model connection, as an Environment binds it. */
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

/** Polls until `check` holds, failing with `what` after `ms`. */
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

describe("subagents of a server agent (ADR 0322)", () => {
  let tmpDir: string;
  let runs: string;
  /** When each setup run began and ended, in seconds. */
  let stamps: string;
  /** Present: the setup fails. */
  let broken: string;
  /** Present: the setup takes a while longer. */
  let slow: string;
  let projectId: string;
  let sessions: AgentSessionsService;
  let machine: LocalProcessSandboxProvider;
  const allocations = new ExecutionAllocationsService(db);

  const session = (id: string) =>
    db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  const idle = async (id: string) =>
    !(await db
      .selectFrom("agent_turns")
      .select("id")
      .where("session_id", "=", id)
      .where("status", "in", [
        "queued",
        "held",
        "preparing",
        "running",
        "waiting",
        "finalizing",
      ])
      .executeTakeFirst());

  /** The agent's replies, oldest first. */
  const replies = async (id: string) =>
    (
      await db
        .selectFrom("agent_items")
        .select("payload")
        .where("session_id", "=", id)
        .where("kind", "=", "assistant_message")
        .orderBy("position")
        .execute()
    ).flatMap((row) => {
      const item = itemFromRow(row);
      return item.kind === "assistant_message" ? [item.text] : [];
    });

  /** The machine's id of a chat's sandbox. */
  const sandboxOf = async (id: string) =>
    (
      await db
        .selectFrom("agent_sessions")
        .innerJoin(
          "project_sandboxes",
          "project_sandboxes.id",
          "agent_sessions.sandbox_id",
        )
        .select("project_sandboxes.provider_id")
        .where("agent_sessions.id", "=", id)
        .executeTakeFirstOrThrow()
    ).provider_id;

  const allocationCount = async () =>
    Number(
      (
        await db
          .selectFrom("execution_allocations")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("project_id", "=", projectId)
          .executeTakeFirstOrThrow()
      ).count,
    );

  const setupRuns = async () =>
    (await fs.readFile(runs, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean).length;

  beforeAll(async () => {
    await migrateToLatest({ db, schema: "catamorphic_shared_subsessions" });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-subsessions-"));
    runs = path.join(tmpDir, "setup.log");
    stamps = path.join(tmpDir, "setup-times.log");
    broken = path.join(tmpDir, "setup-broken");
    slow = path.join(tmpDir, "setup-slow");
    // The project's linked remote, with the pull request's code.
    const seed = path.join(tmpDir, "seed");
    await fs.mkdir(seed);
    await git(seed, ["init", "-q", "-b", "main"]);
    await fs.writeFile(path.join(seed, "README.md"), "main\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-q", "-m", "main"]);
    await git(seed, ["checkout", "-q", "-b", "pr"]);
    await fs.writeFile(path.join(seed, "README.md"), "pull request\n");
    await git(seed, ["commit", "-q", "-am", "change"]);
    await git(seed, ["checkout", "-q", "main"]);
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
          secrets: { REVIEW_TOKEN: {} },
          environments: {
            review: {
              workloads: ["agent"],
              secrets: ["REVIEW_TOKEN"],
              // Slow enough that a turn starting during it would show.
              setup: {
                command: [
                  `echo setup >> '${runs}'`,
                  `echo "start $(date +%s)" >> '${stamps}'`,
                  "sleep 2",
                  `if [ -f '${slow}' ]; then sleep 6; fi`,
                  `echo "end $(date +%s)" >> '${stamps}'`,
                  `if [ -f '${broken}' ]; then echo "lockfile is stale"; exit 3; fi`,
                ].join("\n"),
              },
            },
            // One whose setup is a command and a workflow (ADR 0324).
            prepared: {
              workloads: ["agent"],
              setup: { command: "true", workflow: "prepareReview" },
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

    machine = ownedSandboxes.track(
      new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
    );
    const binding: EnvironmentRuntimeBinding = {
      descriptor: {
        id: "machine",
        label: "Machine",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [],
        resources: {},
      },
      sandboxProvider: machine,
    };
    const projectEnvironments = new ProjectEnvironmentsService(
      db,
      projectManager,
    );
    const secrets = new SecretsService({
      db,
      vault: new MemoryCredentialVault(),
      environments: projectEnvironments,
    });
    await secrets.upsert({
      identity,
      projectId,
      name: "REVIEW_TOKEN",
      value: "review-token-value",
    });
    // As a Work server serves a committed agent: its harness beside the
    // workspace, in the chat's sandbox, its model through the gateway.
    const agent: RegisteredCodingAgent = {
      id: "reviewer",
      harness: { placement: "sandbox", id: "echo" },
      topology: "controller",
      connectionRequirements: ["model"],
      modelConnection: "model",
      delegation: {
        enabled: true,
        maxConcurrentChildren: 2,
        agents: [
          { agent: "self", model: "any", effort: "any", delegate: true },
          { agent: "publisher", model: "any", effort: "any", delegate: false },
        ],
      },
    };
    // Another agent, sandboxed to publish what it changes.
    const publisher: RegisteredCodingAgent = {
      ...agent,
      id: "publisher",
      sandboxing: "publish",
      delegation: undefined,
    };
    // One whose changes never leave its sandbox, which may start it.
    const sealed: RegisteredCodingAgent = {
      ...agent,
      id: "sealed",
      sandboxing: "contained",
      delegation: {
        enabled: true,
        maxConcurrentChildren: 2,
        agents: [
          { agent: "publisher", model: "any", effort: "any", delegate: false },
        ],
      },
    };
    const agents = [agent, publisher, sealed];
    sessions = new AgentSessionsService(db, {
      hostId: "shared-subsessions-host",
      // Short, so a claim another replica takes is noticed at once.
      workspaceClaimSeconds: 3,
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        projectEnvironments,
        {
          get: ({ allocationBindingId }) =>
            !allocationBindingId || allocationBindingId === "machine"
              ? binding
              : undefined,
        },
      ),
      executionAllocations: allocations,
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => agents.find((candidate) => candidate.id === id),
        list: () => agents,
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
      secrets,
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

  it("offers a sandboxed agent Work's subsession tools, and its child works in its workspace", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    // It is told about subagents and where they work.
    expect((await session(parent.id)).system_prompt).toContain(
      "Subsessions are your subagents",
    );
    expect((await session(parent.id)).system_prompt).toContain(
      "workspace: own",
    );
    const first = await sessions.sendMessage(
      identity,
      projectId,
      parent.id,
      '[[tool spawn_subsession {"task":"Check the docs","title":"Docs"}]] Started a reviewer.',
    );
    expect(first.turn.status).toBe("completed");
    const parentRow = await session(parent.id);
    expect(await setupRuns()).toBe(1);
    expect(await allocationCount()).toBe(1);

    const [child] = await sessions.listSubsessions(
      identity,
      projectId,
      parent.id,
    );
    if (!child) throw new Error("The tool started no subsession");
    expect(child.workspace).toBe("shared");
    expect(child.session.workspaceSessionId).toBe(parent.id);
    await until("the child's result reaches its parent", async () =>
      (await replies(parent.id)).some((reply) => reply.includes("Docs")),
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );

    // The parent's Allocation and sandbox: nothing admitted, made or set up.
    const childRow = await session(child.session.id);
    expect(childRow.workspace_session_id).toBe(parent.id);
    expect(childRow.allocation_id).toBe(parentRow.allocation_id);
    expect(childRow.sandbox_id).toBe(parentRow.sandbox_id);
    expect(childRow.workspace).toEqual(parentRow.workspace);
    expect(await allocationCount()).toBe(1);
    expect(await setupRuns()).toBe(1);
    // Its runner ran in that sandbox, its state beside the parent's.
    const parentSandbox = await sandboxOf(parent.id);
    const state = await machine.executeCommand(
      parentSandbox,
      `ls .work-session/subsessions/${child.session.id}`,
      { cwd: "/workspace" },
    );
    expect(state.result).toContain("runner");
    // It reads the parent's checkout, at the pull request's head.
    const readme = await machine.executeCommand(
      parentSandbox,
      "cat README.md",
      { cwd: "/workspace/project" },
    );
    expect(readme.result.trim()).toBe("pull request");
  }, 120_000);

  it("sets a fresh shared workspace up once, before either turn starts, and both hear how it went", async () => {
    await fs.writeFile(broken, "");
    try {
      const before = await setupRuns();
      const parent = await sessions.create(identity, projectId, {
        workspace: { ref: "pr" },
      });
      // A workflow starts the child as the parent's own first turn starts:
      // both reach a workspace nobody has made or set up yet.
      const [child, first] = await Promise.all([
        sessions.createSubsession(identity, projectId, parent.id, {
          task: "Second look",
        }),
        // Still working when the child reports, so its result steers in
        // rather than starting a turn that would set up again.
        sessions.sendMessage(
          identity,
          projectId,
          parent.id,
          "[[wait 4000]] First look",
        ),
      ]);
      expect(first.turn.status).toBe("completed");
      await until(
        "both rest",
        async () => (await idle(parent.id)) && (await idle(child.session.id)),
      );
      // One run of setup for this workspace build, not one per session.
      expect(await setupRuns()).toBe(before + 1);
      const times = (await fs.readFile(stamps, "utf8"))
        .trim()
        .split("\n")
        .slice(-2);
      expect(times[0]).toMatch(/^start /);
      expect(times[1]).toMatch(/^end /);
      const ended = Number(times[1]?.split(" ")[1]) * 1000;
      // Each turn's harness started only once setup had ended.
      const started = await db
        .selectFrom("agent_turn_attempts")
        .select(["session_id", "provider_started_at"])
        .where("session_id", "in", [parent.id, child.session.id])
        .execute();
      expect(new Set(started.map((row) => row.session_id))).toEqual(
        new Set([parent.id, child.session.id]),
      );
      for (const row of started)
        expect(row.provider_started_at?.getTime() ?? 0).toBeGreaterThanOrEqual(
          ended,
        );
      // Both were told it failed, the one that waited from the run it
      // waited on.
      for (const id of [parent.id, child.session.id])
        expect((await replies(id))[0]).toContain("exit code 3");
    } finally {
      await fs.rm(broken, { force: true });
    }
  }, 120_000);

  it("stops a setup whose claim another replica took", async () => {
    await fs.writeFile(slow, "");
    const lastStamp = async () =>
      (await fs.readFile(stamps, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .at(-1) ?? "";
    try {
      const parent = await sessions.create(identity, projectId, {
        workspace: { ref: "pr" },
      });
      const sent = sessions
        .sendMessage(identity, projectId, parent.id, "Set up")
        .catch((error: unknown) => error);
      await until("setup runs", async () =>
        (await lastStamp()).startsWith("start"),
      );
      // Another replica holds the workspace's setup claim now.
      await db
        .updateTable("replica_claims")
        .set({
          holder: "another-replica",
          expires_at: new Date(Date.now() + 3_600_000),
        })
        .where("name", "like", "workspace-setup:%")
        .execute();
      await sent;
      // Longer than the setup would have taken: it never ended.
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      expect(await lastStamp()).toMatch(/^start /);
    } finally {
      await fs.rm(slow, { force: true });
      await db
        .deleteFrom("replica_claims")
        .where("holder", "=", "another-replica")
        .execute();
    }
  }, 120_000);

  it("follows the parent's workspace when it was given back while idle", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    await sessions.sendMessage(identity, projectId, parent.id, "Look around");
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const before = await session(parent.id);
    await allocations.release({
      identity,
      allocationId: before.allocation_id ?? "",
      reason: "idle",
    });
    // The child wakes on its own: the workspace comes back for its parent.
    await sessions.notify(identity, projectId, child.session.id, {
      task: {
        type: "background_command",
        id: "lint",
        title: "Lint",
        status: "completed",
      },
      summary: "Lint finished",
      idempotencyKey: "lint-finished",
    });
    await until(
      "the child's later turn ran",
      async () => (await replies(child.session.id)).length >= 2,
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const parentAfter = await session(parent.id);
    const childAfter = await session(child.session.id);
    expect(parentAfter.allocation_id).not.toBe(before.allocation_id);
    expect(childAfter.allocation_id).toBe(parentAfter.allocation_id);
    expect(childAfter.sandbox_id).toBe(parentAfter.sandbox_id);
    const readme = await machine.executeCommand(
      await sandboxOf(parent.id),
      "cat README.md",
      { cwd: "/workspace/project" },
    );
    expect(readme.result.trim()).toBe("pull request");
  }, 120_000);

  it("sets its workspace session's workspace up when a shared child's turn makes it", async () => {
    const calls: Array<{
      setupFor: SetupRunFact;
      input: Json;
      /** The chats recording a setup run while it ran. */
      recordedOn: string[];
    }> = [];
    sessions.setSetupWorkflowRunner({
      run: async (args) => {
        const recordedOn = (
          await db
            .selectFrom("agent_sessions")
            .select("id")
            .where("project_id", "=", projectId)
            .where("setup_run", "is not", null)
            .execute()
        ).map((row) => row.id);
        calls.push({ setupFor: args.setupFor, input: args.input, recordedOn });
        return { status: "succeeded" };
      },
      end: async () => {},
    });
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
      environment: "prepared",
    });
    await sessions.sendMessage(identity, projectId, parent.id, "Look around");
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    expect(calls).toHaveLength(1);
    const before = await session(parent.id);
    await allocations.release({
      identity,
      allocationId: before.allocation_id ?? "",
      reason: "idle",
    });
    // The child's turn comes first and makes the workspace again.
    await sessions.notify(identity, projectId, child.session.id, {
      task: {
        type: "background_command",
        id: "typecheck",
        title: "Typecheck",
        status: "completed",
      },
      summary: "Typecheck finished",
      idempotencyKey: "typecheck-finished",
    });
    await until(
      "the child's later turn ran",
      async () => (await replies(child.session.id)).length >= 2,
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    // The setup workflow ran for the parent's workspace, not the child.
    expect(calls).toHaveLength(2);
    const again = calls[1];
    expect(again?.setupFor.sessionId).toBe(parent.id);
    expect(again?.input).toMatchObject({
      sessionId: parent.id,
      agentId: "reviewer",
      reason: "rebuilt",
    });
    expect(again?.recordedOn).toEqual([parent.id]);
    // The workspace's changes are the parent's: made, then made again.
    const changes = (
      await db
        .selectFrom("project_events")
        .select("payload")
        .where("project_id", "=", projectId)
        .where("kind", "=", "session.workspace-changed")
        .orderBy("sequence")
        .execute()
    ).map(
      (event) =>
        event.payload as { sessionId: string; detail: { change: string } },
    );
    expect(
      changes.filter((payload) => payload.sessionId === child.session.id),
    ).toEqual([]);
    expect(
      changes
        .filter((payload) => payload.sessionId === parent.id)
        .map((payload) => payload.detail.change),
    ).toEqual(["ready", "rebuilt"]);
    expect((await session(parent.id)).workspace_generation).toBe(2);
  }, 120_000);

  it("runs no setup that takes the sandbox's grants while another session's turn runs in it", async () => {
    let calls = 0;
    sessions.setSetupWorkflowRunner({
      run: async () => {
        calls += 1;
        return { status: "succeeded" };
      },
      end: async () => {},
    });
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
      environment: "prepared",
    });
    await sessions.sendMessage(identity, projectId, parent.id, "Look around");
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    expect(calls).toBe(1);
    const childTurn = sessions.sendMessage(
      identity,
      projectId,
      child.session.id,
      "[[wait 5000]] Keep looking",
    );
    await until("the child's turn runs", async () =>
      Boolean(
        await db
          .selectFrom("agent_turns")
          .select("id")
          .where("session_id", "=", child.session.id)
          .where("status", "=", "running")
          .executeTakeFirst(),
      ),
    );
    // The setup is due again, as after an edit to it, while the child works.
    await machine.executeCommand(
      await sandboxOf(parent.id),
      "rm -f .work-session/setup.done",
      { cwd: "/workspace" },
    );
    // Its grants stay: the parent's turn sets nothing up meanwhile.
    await sessions.sendMessage(identity, projectId, parent.id, "Next");
    expect(calls).toBe(1);
    expect((await childTurn).turn.status).toBe("completed");
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    // With no other turn there, the next one runs it.
    await sessions.sendMessage(identity, projectId, parent.id, "And now");
    expect(calls).toBe(2);
  }, 120_000);

  it("delivers nothing more to a sandbox once its workspace claim could be lost", async () => {
    const service = sessions as unknown as {
      prepareSandboxGit(input: unknown): Promise<unknown>;
      prepareSandboxSecrets(input: unknown): Promise<unknown>;
    };
    const git = vi
      .spyOn(service, "prepareSandboxGit")
      .mockImplementationOnce(async () => {
        // Another replica takes the workspace's claim meanwhile, and this
        // one's renewal finds it gone.
        await db
          .updateTable("replica_claims")
          .set({
            holder: "another-replica",
            expires_at: sql<Date>`now() + interval '1 hour'`,
          })
          .where("name", "like", "workspace-setup:%")
          .execute();
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        // As for an agent on its own sign-in: no turn-bound grant to stop it.
        return [
          {
            alias: "model",
            api: "anthropic",
            baseUrl: "http://work.acme.test/gateway/model/model",
            grantDirectory: "/workspace/.work-session/model-grants/x/model",
          },
        ];
      });
    const secrets = vi.spyOn(service, "prepareSandboxSecrets");
    try {
      const parent = await sessions.create(identity, projectId, {
        workspace: { ref: "pr" },
      });
      await sessions
        .sendMessage(identity, projectId, parent.id, "Look around")
        .catch(() => undefined);
      // The abandoned preparation would go on in the background.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(git).toHaveBeenCalled();
      expect(secrets).not.toHaveBeenCalled();
    } finally {
      git.mockRestore();
      secrets.mockRestore();
      await db
        .deleteFrom("replica_claims")
        .where("holder", "=", "another-replica")
        .execute();
    }
  }, 120_000);

  it("keeps a shared workspace someone uses through a subagent from being given back as idle", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    await sessions.sendMessage(identity, projectId, parent.id, "Look around");
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const allocationId = (await session(parent.id)).allocation_id ?? "";
    // The workspace sits on a remote machine and has idled for two hours,
    // no turn since.
    const nodeId = `node-${randomUUID()}`;
    await db
      .insertInto("worker_nodes")
      .values({
        id: nodeId,
        tenant_id: identity.tenantId,
        authority_id: "test",
        descriptor: JSON.stringify({}),
        lease_token: randomUUID(),
        lease_expires_at: new Date(Date.now() + 3_600_000),
        remote: JSON.stringify({}),
      })
      .execute();
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    await db
      .updateTable("execution_allocations")
      .set({ worker_node_id: nodeId, created_at: longAgo })
      .where("id", "=", allocationId)
      .execute();
    await db
      .updateTable("agent_turns")
      .set({ updated_at: longAgo })
      .where("session_id", "in", [parent.id, child.session.id])
      .execute();
    // A person's terminal, or a workflow's command, in the subagent's chat
    // a moment ago.
    await db
      .insertInto("session_workspace_use")
      .values({ session_id: child.session.id })
      .execute();
    const status = async () =>
      (
        await db
          .selectFrom("execution_allocations")
          .select("status")
          .where("id", "=", allocationId)
          .executeTakeFirstOrThrow()
      ).status;
    expect(await sessions.releaseIdleWorkspaces()).toBe(0);
    expect(await status()).toBe("active");
    // Unused for two hours too: now it goes.
    await db
      .updateTable("session_workspace_use")
      .set({ used_at: longAgo })
      .where("session_id", "=", child.session.id)
      .execute();
    expect(await sessions.releaseIdleWorkspaces()).toBe(1);
    expect(await status()).toBe("released");
  }, 120_000);

  it("starts a child that asks for its own workspace at the parent's base", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    const parentRow = await session(parent.id);
    const before = await allocationCount();
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "Write the fix", workspace: "own" },
    );
    expect(child.workspace).toBe("own");
    await until("the child rests", () => idle(child.session.id));
    const childRow = await session(child.session.id);
    expect(childRow.workspace_session_id).toBeNull();
    expect(childRow.allocation_id).not.toBe(parentRow.allocation_id);
    expect(await allocationCount()).toBe(before + 1);
    // The parent's base, its ref and commit, not the project default.
    expect(childRow.workspace).toEqual(parentRow.workspace);
    expect(await sandboxOf(child.session.id)).not.toBe(
      await sandboxOf(parent.id).catch(() => "none"),
    );
    const readme = await machine.executeCommand(
      await sandboxOf(child.session.id),
      "cat README.md",
      { cwd: "/workspace/project" },
    );
    expect(readme.result.trim()).toBe("pull request");
  }, 120_000);

  it("refuses to share a contained workspace with an agent that publishes, naming own", async () => {
    const parent = await sessions.create(identity, projectId, {
      agentId: "sealed",
    });
    const shared = () =>
      sessions.createSubsession(identity, projectId, parent.id, {
        task: "Publish the fix",
        agentId: "publisher",
      });
    await expect(shared()).rejects.toBeInstanceOf(AgentDelegationSettingsError);
    await expect(shared()).rejects.toThrow(/workspace: "own"/);
    expect(
      await sessions.listSubsessions(identity, projectId, parent.id),
    ).toEqual([]);
  }, 60_000);

  it("shares a chat's workspace only with those who may work in it, and the child is that chat's", async () => {
    const chat = await sessions.create(
      projectChatIdentity({ tenantId: identity.tenantId, projectId }),
      projectId,
    );
    // A member who may message the project chat, not work beside its agent.
    const member: Identity = {
      tenantId: identity.tenantId,
      externalUserId: "bob",
      // Its agents, the host's own included (`agents: ["*"]`).
      scope: [{ kind: "agent", projectId, name: "*" }],
    };
    await expect(
      sessions.createSubsession(member, projectId, chat.id, {
        task: "Read the secrets",
      }),
    ).rejects.toThrow(/workspace: "own"/);
    expect(
      await sessions.listSubsessions(identity, projectId, chat.id),
    ).toEqual([]);
    // One who may work there starts a child that is the project chat's too.
    const maintainer: Identity = {
      ...member,
      externalUserId: "carol",
      projectPermissions: [{ projectId, permission: "sessions:write" }],
    };
    const child = await sessions.createSubsession(
      maintainer,
      projectId,
      chat.id,
      { task: "Check the build" },
    );
    expect(child.workspace).toBe("shared");
    expect(child.session.externalUserId).toBe(PROJECT_PRINCIPAL_ID);
    expect(child.session.owner).toBe("project");
    await until("the child rests", () => idle(child.session.id));
  }, 120_000);

  it("archives a busy shared child alone, leaving its parent in the person's chats", async () => {
    const parent = await sessions.create(identity, projectId);
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "Archive me" },
    );
    await until("the child rests", () => idle(child.session.id));
    // Its turn has not stopped when the archive looks (it runs elsewhere).
    const service = sessions as unknown as {
      sessionsWithRunningTurns(input: {
        sessionIds: readonly string[];
        executor?: unknown;
      }): Promise<Set<string>>;
    };
    const original = service.sessionsWithRunningTurns.bind(sessions);
    const running = vi
      .spyOn(service, "sessionsWithRunningTurns")
      .mockImplementation(async (input) =>
        input.executor
          ? new Set(input.sessionIds.filter((id) => id === child.session.id))
          : original(input),
      );
    try {
      await sessions.archive(identity, projectId, child.session.id, {
        confirmStop: true,
      });
    } finally {
      running.mockRestore();
    }
    expect(
      (await sessions.get(identity, projectId, child.session.id)).visibility,
    ).toBe("archived");
    expect(
      (await sessions.get(identity, projectId, parent.id)).visibility,
    ).not.toBe("archived");
  }, 60_000);

  it("keeps a child its parent stopped stopped, even when it wakes on its own", async () => {
    const parent = await sessions.create(identity, projectId);
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "[[wait 20000]] Long check" },
    );
    // Stopped while its turn runs, not while it is still being prepared.
    await until("the child works", async () =>
      Boolean(
        await db
          .selectFrom("agent_turns")
          .select("id")
          .where("session_id", "=", child.session.id)
          .where("status", "=", "running")
          .executeTakeFirst(),
      ),
    );
    await sessions.interruptSubsession(
      identity,
      projectId,
      parent.id,
      child.session.id,
    );
    await until("the child rests", () => idle(child.session.id));
    await sessions.notify(identity, projectId, child.session.id, {
      task: {
        type: "background_command",
        id: "watch",
        title: "Watch the logs",
        status: "completed",
      },
      summary: "Watch the logs finished",
      idempotencyKey: "watch-finished",
    });
    await until("the child's later turn ran", async () =>
      (await replies(child.session.id)).some((reply) =>
        reply.includes("Watch the logs"),
      ),
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const [stopped] = await sessions.listSubsessions(
      identity,
      projectId,
      parent.id,
    );
    expect(stopped?.status).toBe("interrupted");
  }, 120_000);

  it("holds a shared child's work while its parent rewinds, and refuses a rewind while the child has work waiting", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    await sessions.sendMessage(identity, projectId, parent.id, "One");
    await sessions.sendMessage(identity, projectId, parent.id, "Two");
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const author = {
      kind: "agent" as const,
      sessionId: parent.id,
      agentId: "reviewer",
    };
    const queuedTurn = async () =>
      db
        .selectFrom("agent_turns")
        .select("status")
        .where("session_id", "=", child.session.id)
        .orderBy("ordinal", "desc")
        .executeTakeFirstOrThrow();
    const rewinding = (id: string, on: boolean) =>
      db
        .updateTable("agent_sessions")
        .set({ rewind_until: on ? new Date(Date.now() + 3_600_000) : null })
        .where("id", "=", id)
        .execute();

    // While the parent's files are rewound, nothing starts on them.
    await rewinding(parent.id, true);
    await sessions.deliver(identity, projectId, child.session.id, {
      content: "Look again",
      author,
      mode: "steer",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await queuedTurn()).status).toBe("queued");
    await rewinding(parent.id, false);
    await sessions.deliver(identity, projectId, child.session.id, {
      content: "And once more",
      author,
      mode: "queue",
    });
    await until("the child rests", () => idle(child.session.id));

    // A child with work waiting there: the parent's files stay as they are.
    await rewinding(child.session.id, true);
    await sessions.deliver(identity, projectId, child.session.id, {
      content: "Later",
      author,
      mode: "queue",
    });
    expect((await queuedTurn()).status).toBe("queued");
    // The child's reports have woken the parent meanwhile.
    await until("the parent rests", () => idle(parent.id));
    const before = await sessions.get(identity, projectId, parent.id);
    const second = orderedTurns(sessionStateFromSnapshot(before.snapshot))[1];
    const receipt = await sessions.command(identity, projectId, parent.id, {
      type: "rollback",
      commandId: randomUUID(),
      turnId: second?.id ?? "",
    });
    expect(receipt.status).toBe("rejected");
    expect(receipt.error?.message).toContain("have work waiting there");
    await rewinding(child.session.id, false);
    await sessions.notify(identity, projectId, child.session.id, {
      task: {
        type: "background_command",
        id: "nudge",
        title: "Nudge",
        status: "completed",
      },
      summary: "Nudge finished",
      idempotencyKey: "nudge-finished",
    });
    await until("the child rests", () => idle(child.session.id));
  }, 120_000);

  it("keeps the owner's secrets in a shared workspace only while every turn there is the owner's", async () => {
    const parent = await sessions.create(identity, projectId, {
      workspace: { ref: "pr" },
    });
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First look" },
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    const secretsSet = async () =>
      (
        await machine.executeCommand(
          await sandboxOf(parent.id),
          "cat .work-session/env/secrets.sh 2>/dev/null || true",
          { cwd: "/workspace" },
        )
      ).result.includes("REVIEW_TOKEN");
    // The owner's own turn works with the secret.
    const working = sessions.sendMessage(
      identity,
      projectId,
      parent.id,
      "[[wait 8000]] Working with the token",
    );
    await until("the secret is set", secretsSet);
    // Someone else writes to the child: a turn the owner did not write.
    const other: Identity = {
      tenantId: identity.tenantId,
      externalUserId: "bob",
      scope: [{ kind: "agent", projectId, name: "*" }],
      projectPermissions: [{ projectId, permission: "sessions:write" }],
    };
    const beside = sessions.sendMessage(
      other,
      projectId,
      child.session.id,
      "[[wait 15000]] Bob here",
    );
    await until("the secret is gone", async () => !(await secretsSet()));
    // The owner's working turn was told.
    expect((await working).turn.status).toBe("completed");
    expect((await replies(parent.id)).at(-1)).toContain(
      "took the owner's secrets and personal files out",
    );
    // Its next turn, beside the other's, runs without them and hears why.
    await sessions.sendMessage(identity, projectId, parent.id, "Again");
    expect((await replies(parent.id)).at(-1)).toContain(
      "runs a turn its owner did not write",
    );
    expect(await secretsSet()).toBe(false);
    await beside;
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
  }, 120_000);

  it("refuses a child past the limit, saying so, and makes nothing", async () => {
    const parent = await sessions.create(identity, projectId);
    for (const task of ["[[wait 4000]] one", "[[wait 4000]] two"])
      await sessions.createSubsession(identity, projectId, parent.id, {
        task,
      });
    const counts = async () => ({
      sessions: Number(
        (
          await db
            .selectFrom("agent_sessions")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      ),
      delegations: Number(
        (
          await db
            .selectFrom("agent_delegations")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      ),
      allocations: await allocationCount(),
    });
    const before = await counts();
    const refused = sessions.createSubsession(identity, projectId, parent.id, {
      task: "three",
      workspace: "own",
    });
    await expect(refused).rejects.toBeInstanceOf(AgentDelegationDeniedError);
    await expect(refused).rejects.toThrow(
      /already has 2 active subsessions, its limit/,
    );
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("brings a child's later result to its working parent, after it woke on its own", async () => {
    const parent = await sessions.create(identity, projectId);
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "First pass", title: "Verifier" },
    );
    await until("the first result reaches the parent", async () =>
      (await replies(parent.id)).some((reply) => reply.includes("First pass")),
    );
    await until(
      "both rest",
      async () => (await idle(parent.id)) && (await idle(child.session.id)),
    );
    // The parent works on; meanwhile the child's own background command
    // finishes, its next turn settles with the result the parent waits on.
    const working = sessions.sendMessage(
      identity,
      projectId,
      parent.id,
      "[[wait 8000]] Waiting for the verifier",
    );
    await until("the parent works", async () => !(await idle(parent.id)));
    await sessions.notify(identity, projectId, child.session.id, {
      task: {
        type: "background_command",
        id: "tests",
        title: "Run the tests",
        status: "completed",
      },
      summary: "Run the tests finished",
      detail: "Verdict: approve",
      idempotencyKey: "tests-finished",
    });
    const settled = await working;
    expect(settled.turn.status).toBe("completed");
    // Heard in that turn, through the steer path (ADR 0278).
    const last = (await replies(parent.id)).at(-1) ?? "";
    expect(last).toContain("Steered:");
    expect(last).toContain("Verdict: approve");
  }, 120_000);
});
