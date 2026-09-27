import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Identity } from "../identity.js";
import {
  AgentCapabilitiesService,
  defineAgentCapability,
} from "../services/agent-capabilities-service.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { CodingAgentRegistry } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0176: a committed definition's mode and tool policies hold on any
 * host, enforced by core rather than by the harness.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_agent_modes_${crypto.randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

const unusedSandboxProvider = new Proxy({} as SandboxProvider, {
  get(_target, prop) {
    if (prop === "workspaceRoot") return "/unused";
    return () => {
      throw new Error(`SandboxProvider.${String(prop)} must not be called`);
    };
  },
});

class RecordingProvider implements CodingAgentProvider {
  readonly name = "recording";
  readonly starts: StartSessionOpts[] = [];
  readonly turns: Array<TurnOptions | undefined> = [];
  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    this.starts.push(opts);
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }
  async *sendMessage(
    _session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    this.turns.push(opts);
    yield { type: "text", content: `echo: ${message}` };
    yield { type: "done" };
  }
  async dispose(): Promise<void> {}
}

describeIf("agent modes and definition policies (ADR 0176)", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let capabilities: AgentCapabilitiesService;
  let projectId: string;
  const provider = new RecordingProvider();
  const executed: string[] = [];

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-modes-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    const rootPath = path.join(tmpDir, "checkout");
    await fs.mkdir(rootPath, { recursive: true });
    projectId = (await projects.create(root, { name: "modes" })).id;
    const repo = await projectManager.open(root.tenantId, projectId);
    try {
      await repo.writeFile(
        ".work/agents/reviewer.json",
        JSON.stringify({
          version: 1,
          name: "Reviewer",
          kind: "builtin",
          mode: "read-only",
          toolPolicies: {
            prod: { default: "ask", tools: { query: "allow" } },
            catamorphic: { default: "deny" },
          },
        }),
      );
      await repo.writeFile(
        ".work/agents/editor.json",
        JSON.stringify({
          version: 1,
          name: "Editor",
          kind: "builtin",
          mode: "edit",
        }),
      );
      await repo.commit("Add agents", {
        name: "root",
        email: "root@example.com",
      });
    } finally {
      await repo.dispose();
    }
    const registry: CodingAgentRegistry = {
      defaultAgentId: () => undefined,
      get: () => undefined,
      list: () => [],
      // The host declares neither mode nor policies: core applies both.
      projectAgent: ({ id }) => ({ id, provider, topology: "native" }),
    };
    const executionAllocations = new ExecutionAllocationsService(db);
    const executionEnvironments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      testEnvironmentProvider(unusedSandboxProvider),
    );
    sessions = new AgentSessionsService(db, {
      hostId: "modes-test-host",
      projectManager,
      codingAgents: registry,
      executionEnvironments,
      executionAllocations,
      nativeAgentCheckout: { resolve: () => rootPath },
    });
    const capability = (
      name: string,
      effect: "read" | "write",
      mode?: "full-access",
    ) =>
      defineAgentCapability({
        revision: "1",
        name,
        description: name,
        effect,
        ...(mode ? { mode } : {}),
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ ok: z.boolean() }),
        authorize: () => true,
        execute: async () => {
          executed.push(name);
          return { ok: true };
        },
      });
    capabilities = new AgentCapabilitiesService({
      db,
      allocations: executionAllocations,
      environments: executionEnvironments,
      options: {
        capabilities: [
          capability("test.read", "read"),
          capability("test.propose", "write"),
          capability("test.deploy", "write", "full-access"),
        ],
      },
      sessionMode: (args) => sessions.agentMode(args),
    });
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("layers a definition's tool policies with the caller's on the server", async () => {
    const session = await sessions.create(root, projectId, {
      agentId: `project:${projectId}:reviewer`,
    });
    await sessions.sendMessage(root, projectId, session.id, "review");
    const start = provider.starts.at(-1);
    expect(start?.toolPolicies?.connection_prod).toEqual([
      { default: "ask", tools: { query: "allow" } },
    ]);
    expect(start?.toolPolicies?.catamorphic).toEqual([{ default: "deny" }]);
    expect(provider.turns.at(-1)?.toolPolicies).toEqual(start?.toolPolicies);
    expect(await sessions.agentMode({ projectId, sessionId: session.id })).toBe(
      "read-only",
    );
  });

  it("refuses capabilities above the agent's mode with a readable reason", async () => {
    const invoke = (sessionId: string, name: string) =>
      capabilities
        .forSession({ identity: root, projectId, sessionId })
        .invoke({ name, input: {}, requestId: crypto.randomUUID() });
    const reviewer = await sessions.create(root, projectId, {
      agentId: `project:${projectId}:reviewer`,
    });
    await expect(invoke(reviewer.id, "test.read")).resolves.toEqual({
      ok: true,
    });
    await expect(invoke(reviewer.id, "test.propose")).rejects.toThrow(
      "read-only mode",
    );
    const editor = await sessions.create(root, projectId, {
      agentId: `project:${projectId}:editor`,
    });
    await expect(invoke(editor.id, "test.propose")).resolves.toEqual({
      ok: true,
    });
    await expect(invoke(editor.id, "test.deploy")).rejects.toThrow("edit mode");
    expect(executed).toEqual(["test.read", "test.propose"]);
  });
});
