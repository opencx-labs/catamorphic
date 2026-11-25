import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  orderedTurns,
  type SessionState,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import { EchoAdapter } from "@catamorphic/agent-runner";
import { type DB, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import {
  ANSWERED_IN_TIME_NOTE,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * A harness whose client gives a tool call up after its own timeout (an
 * MCP client's request timeout) would lose the answer of a wait that
 * outlasts it. Work ends every wait in its tools before then (ADR 0351),
 * as it ends one when something reaches the chat (ADR 0264).
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_tool_answer_deadline";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "55555555-5555-4555-8555-555555555555",
  externalUserId: "builder",
};
const unusedSandbox = new Proxy(
  { workspaceRoot: "/unused" } as SandboxProvider,
  {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {
        throw new Error(`Unexpected sandbox call: ${String(property)}`);
      };
    },
  },
);

/** A tool directive the echo harness runs: `[[tool <name> <json>]]`. */
const tool = (name: string, input: unknown) =>
  `[[tool ${name} ${JSON.stringify(input)}]]`;

describe("tool answers within the client's timeout (ADR 0351)", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projectId: string;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-deadline-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    // One whose client waits as long as a tool takes.
    const patient: RegisteredCodingAgent = {
      id: "patient",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    // One whose client gives a call up after 4 seconds: Work holds it 3.
    const hurried: RegisteredCodingAgent = {
      ...patient,
      id: "hurried",
      toolTimeoutMs: 4_000,
    };
    const agents = [patient, hurried];
    sessions = new AgentSessionsService(db, {
      hostId: "tool-deadline-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "patient",
        get: (id: string) => agents.find((agent) => agent.id === id),
        list: () => agents,
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId: id }: { projectId: string }) => {
          const checkout = path.join(tmpDir, id);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
        head: () => Promise.resolve("c0ffee".padEnd(40, "0")),
      },
    });
    projectId = (await projects.create(identity, { name: "Waits" })).id;
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function state(sessionId: string): Promise<SessionState> {
    const detail = await sessions.get(identity, projectId, sessionId);
    return sessionStateFromSnapshot(detail.snapshot);
  }

  /** A parent with a child that works until stopped, and the parent's wait on it. */
  async function waitOnBusyChild(input: {
    agentId: string;
    timeoutMs: number;
  }): Promise<{ elapsedMs: number; result: string }> {
    const parent = await sessions.create(identity, projectId, {
      agentId: input.agentId,
    });
    const child = await sessions.createSubsession(
      identity,
      projectId,
      parent.id,
      { task: "[[hang]]" },
    );
    try {
      const started = Date.now();
      await sessions.command(identity, projectId, parent.id, {
        type: "send",
        commandId: randomUUID(),
        text: `${tool("wait_for_subsessions", { timeout_ms: input.timeoutMs })} Waited.`,
      });
      await vi.waitFor(
        async () => {
          const turns = orderedTurns(await state(parent.id));
          expect(turns.length).toBeGreaterThan(0);
          expect(turns.every((turn) => turn.status === "completed")).toBe(true);
        },
        { timeout: 20_000, interval: 100 },
      );
      const call = (await state(parent.id)).items.find(
        (item) => item.kind === "tool_call",
      );
      return {
        elapsedMs: Date.now() - started,
        result: JSON.stringify(
          call?.kind === "tool_call" ? (call.result ?? call.error) : null,
        ),
      };
    } finally {
      await sessions.interruptSubsession(
        identity,
        projectId,
        parent.id,
        child.session.id,
      );
    }
  }

  it("ends a wait before the agent's client would give the call up, and says to call again", async () => {
    // Asked to wait a minute for a child that never finishes.
    const hurried = await waitOnBusyChild({
      agentId: "hurried",
      timeoutMs: 60_000,
    });
    // Held three of its client's four seconds, never the minute.
    expect(hurried.elapsedMs).toBeGreaterThanOrEqual(2_500);
    expect(hurried.elapsedMs).toBeLessThan(15_000);
    // The child is reported as it stands, with why the wait ended.
    expect(hurried.result).toMatch(/status\\": \\"running/);
    expect(hurried.result).toContain(
      JSON.stringify(ANSWERED_IN_TIME_NOTE).slice(1, -1),
    );
  }, 60_000);

  it("leaves the wait of a harness with no timeout to run its own time", async () => {
    const patient = await waitOnBusyChild({
      agentId: "patient",
      timeoutMs: 1_500,
    });
    expect(patient.elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(patient.result).toMatch(/status\\": \\"running/);
    expect(patient.result).not.toContain("before your client");
  }, 60_000);
});
