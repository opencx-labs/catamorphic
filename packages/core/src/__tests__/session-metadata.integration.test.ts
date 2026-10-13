import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySessionEvents,
  SessionMetadataError,
  type StoredSessionEvent,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import { EchoAdapter } from "@catamorphic/agent-runner";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { copySettledHistory } from "../services/sessions/session-copy.js";
import { readFullSnapshot } from "../services/sessions/session-reads.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * Session metadata (ADR 0225): named JSON values on a session, set by
 * whoever may change it, logged as session.changed so snapshots, streams
 * and mirrors follow, and bounded so it stays a few facts.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_metadata";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "22222222-2222-4222-8222-222222222222",
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

const pullRequest = {
  url: "https://github.com/acme/web/pull/42",
  number: 42,
  title: "Session metadata",
  state: "open",
};

describe("session metadata", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projects: ProjectsService;

  /** The session's logged events after `sequence`, as a stream sends them. */
  const eventsAfter = async (
    sessionId: string,
    sequence: number,
  ): Promise<StoredSessionEvent[]> => {
    const rows = await db
      .selectFrom("agent_session_events")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("sequence", ">", String(sequence))
      .orderBy("sequence")
      .execute();
    return rows.map((row) => ({
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      at: row.created_at.toISOString(),
      commandId: row.command_id,
      event: row.payload as unknown as StoredSessionEvent["event"],
    }));
  };

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-metadata-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const agent: RegisteredCodingAgent = {
      id: "worker",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    sessions = new AgentSessionsService(db, {
      hostId: "metadata-test-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "worker",
        get: (id: string) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId }: { projectId: string }) => {
          const checkout = path.join(tmpDir, projectId);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
      },
    });
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sets, replaces and removes keys, logged so snapshots and streams follow", async () => {
    const project = await projects.create(identity, { name: "Metadata" });
    const session = await sessions.create(identity, project.id);
    const before = (await sessions.get(identity, project.id, session.id))
      .snapshot;
    expect(before.session.metadata).toEqual({});

    expect(
      await sessions.setMetadata({
        identity,
        projectId: project.id,
        sessionId: session.id,
        values: { pull_requests: [pullRequest], note: "keep" },
      }),
    ).toEqual({ pull_requests: [pullRequest], note: "keep" });
    const merged = [{ ...pullRequest, state: "merged" }];
    await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { pull_requests: merged },
    });
    const after = await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { note: null },
    });
    expect(after).toEqual({ pull_requests: merged });

    // The snapshot reads the projection.
    const snapshot = (await sessions.get(identity, project.id, session.id))
      .snapshot;
    expect(snapshot.session.metadata).toEqual({ pull_requests: merged });
    // A client holding the earlier snapshot folds the logged changes into
    // the same fields, one session.changed per write.
    const events = await eventsAfter(session.id, before.sequence);
    expect(events.map((stored) => stored.event)).toEqual([
      {
        type: "session.changed",
        session: { metadata: { pull_requests: [pullRequest], note: "keep" } },
      },
      { type: "session.changed", session: { metadata: expect.anything() } },
      {
        type: "session.changed",
        session: { metadata: { pull_requests: merged } },
      },
    ]);
    const folded = applySessionEvents(sessionStateFromSnapshot(before), events);
    expect(folded.stale).toBe(false);
    expect(folded.session.metadata).toEqual({ pull_requests: merged });
  });

  it("logs nothing for a write that changes nothing", async () => {
    const project = await projects.create(identity, { name: "Unchanged" });
    const session = await sessions.create(identity, project.id);
    await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { deploy: { url: "https://preview.example", ok: true } },
    });
    const { sequence } = (await sessions.get(identity, project.id, session.id))
      .snapshot;
    await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { deploy: { ok: true, url: "https://preview.example" } },
    });
    await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { absent: null },
    });
    expect(await eventsAfter(session.id, sequence)).toEqual([]);
  });

  it("refuses malformed keys, non-JSON and oversized writes, changing nothing", async () => {
    const project = await projects.create(identity, { name: "Limits" });
    const session = await sessions.create(identity, project.id);
    const write = (values: Record<string, unknown>) =>
      sessions.setMetadata({
        identity,
        projectId: project.id,
        sessionId: session.id,
        values: values as Record<string, never>,
      });
    await expect(write({ "Not A Key": 1 })).rejects.toThrow(
      SessionMetadataError,
    );
    // JSON text would turn NaN into null, a removal: refused as given.
    await write({ count: 1 });
    await expect(write({ count: Number.NaN })).rejects.toThrow(
      SessionMetadataError,
    );
    await expect(write({ big: "x".repeat(20_000) })).rejects.toThrow(
      /larger than/,
    );
    await expect(
      write(
        Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`key${index}`, index]),
        ),
      ),
    ).rejects.toThrow(/at most 32 metadata keys/);
    expect(
      (await sessions.get(identity, project.id, session.id)).snapshot.session
        .metadata,
    ).toEqual({ count: 1 });
  });

  it("stores what jsonb refuses as U+FFFD, the same in the log and the row", async () => {
    const project = await projects.create(identity, { name: "Unstorable" });
    const session = await sessions.create(identity, project.id);
    const { sequence } = (await sessions.get(identity, project.id, session.id))
      .snapshot;
    const metadata = await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: session.id,
      values: { note: "a\u0000b" },
    });
    expect(metadata).toEqual({ note: "a�b" });
    expect(
      (await sessions.get(identity, project.id, session.id)).snapshot.session
        .metadata,
    ).toEqual({ note: "a�b" });
    expect((await eventsAfter(session.id, sequence))[0]?.event).toEqual({
      type: "session.changed",
      session: { metadata: { note: "a�b" } },
    });
  });

  it("takes the authority that changes the session, as activity does", async () => {
    const project = await projects.create(identity, { name: "Authority" });
    const session = await sessions.create(identity, project.id);
    // An app that may read the viewer's chats reads them, and only reads.
    const reader: Identity = {
      ...identity,
      scope: [{ kind: "sessions", projectId: project.id }],
    };
    expect(
      (await sessions.get(reader, project.id, session.id)).snapshot.session
        .metadata,
    ).toEqual({});
    await expect(
      sessions.setMetadata({
        identity: reader,
        projectId: project.id,
        sessionId: session.id,
        values: { pull_requests: [pullRequest] },
      }),
    ).rejects.toThrow(AccessDeniedError);
    // Another member with every agent cannot change someone else's chat.
    const other: Identity = {
      tenantId: identity.tenantId,
      externalUserId: "someone-else",
      scope: [{ kind: "agent", projectId: project.id, name: "*" }],
    };
    await expect(
      sessions.setMetadata({
        identity: other,
        projectId: project.id,
        sessionId: session.id,
        values: { pull_requests: [pullRequest] },
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect(
      (await sessions.get(identity, project.id, session.id)).snapshot.session
        .metadata,
    ).toEqual({});
  });

  it("reaches a mirror through its base and its events, and stays out of forks", async () => {
    const project = await projects.create(identity, { name: "Copies" });
    const source = await sessions.create(identity, project.id);
    await sessions.sendMessage(identity, project.id, source.id, "Mirror me");
    await sessions.setMetadata({
      identity,
      projectId: project.id,
      sessionId: source.id,
      values: { pull_requests: [pullRequest] },
    });

    // A fork is a new chat: what the source recorded stays the source's.
    const fork = await sessions.fork(identity, project.id, source.id);
    expect(
      (await sessions.get(identity, project.id, fork.id)).snapshot.session
        .metadata,
    ).toEqual({});

    const sessionId = randomUUID();
    const copy = copySettledHistory({
      snapshot: await readFullSnapshot({ db, sessionId: source.id }),
      sessionId,
    });
    if (!copy) throw new Error("Expected a copy");
    await sessions.mirror(identity, project.id, sessionId, {
      authority: { hostId: "desktop-origin", revision: 1 },
      todos: [],
      base: copy.snapshot,
      events: [],
    });
    expect(
      (await sessions.get(identity, project.id, sessionId)).snapshot.session
        .metadata,
    ).toEqual({ pull_requests: [pullRequest] });
    const merged = [{ ...pullRequest, state: "merged" }];
    await sessions.mirror(identity, project.id, sessionId, {
      authority: { hostId: "desktop-origin", revision: 1 },
      events: [
        {
          sessionId,
          sequence: copy.snapshot.sequence + 1,
          at: new Date().toISOString(),
          commandId: null,
          event: {
            type: "session.changed",
            session: { metadata: { pull_requests: merged } },
          },
        },
      ],
    });
    expect(
      (await sessions.get(identity, project.id, sessionId)).snapshot.session
        .metadata,
    ).toEqual({ pull_requests: merged });
  });
});
