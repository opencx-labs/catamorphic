import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandReceipt,
  SessionSnapshot,
  SessionStreamMessage,
  StoredSessionEvent,
} from "@catamorphic/agent-protocol";
import { EchoAdapter } from "@catamorphic/agent-runner";
import {
  AgentSessionsService,
  ExecutionAllocationsService,
  ExecutionEnvironmentsService,
  type Identity,
  ProjectEnvironmentsService,
  ProjectsService,
  type RegisteredCodingAgent,
} from "@catamorphic/core";
import { type DB, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { EnvironmentProvider } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

/*
 * The session log over HTTP (ADR 0196): real AgentSessionsServices on
 * PGlite, each driving the deterministic echo harness in this process.
 */

const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "builder",
};

/** One machine-local Environment that runs native agents in this process. */
const localEnvironment: EnvironmentProvider = {
  get: ({ allocationBindingId, pool }) =>
    (!allocationBindingId || allocationBindingId === "local") &&
    Object.keys(pool).length === 0
      ? {
          descriptor: {
            id: "local",
            label: "Test Environment",
            trust: "local",
            isolation: "none",
            workloads: ["agent", "workflow"],
            agentTopologies: ["native"],
            capabilities: [],
            resources: {},
          },
        }
      : undefined,
};

interface Backend {
  name: string;
  sessions: AgentSessionsService;
  projects: ProjectsService;
  app: ReturnType<typeof createTestApp>;
}

async function backend(name: string, tmpDir: string): Promise<Backend> {
  const schema = `catamorphic_${name}`;
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(schema)],
  });
  await migrateToLatest({ db, schema });
  const projectManager = new ProjectManager(
    new FsBackend(path.join(tmpDir, name, "projects")),
  );
  const echo: RegisteredCodingAgent = {
    id: "echo",
    harness: { placement: "host", adapter: new EchoAdapter() },
    topology: "native",
  };
  const sessions = new AgentSessionsService(db, {
    hostId: `${name}-host`,
    projectManager,
    executionEnvironments: new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      localEnvironment,
    ),
    executionAllocations: new ExecutionAllocationsService(db),
    codingAgents: {
      defaultAgentId: () => "echo",
      get: (id) => (id === "echo" ? echo : undefined),
      list: () => [echo],
    },
    nativeAgentCheckout: {
      resolve: async ({ projectId }) => {
        const checkout = path.join(tmpDir, name, "checkouts", projectId);
        await fs.mkdir(checkout, { recursive: true });
        return { path: checkout, owned: false };
      },
      checkpoint: () => Promise.resolve(null),
    },
  });
  const app = createTestApp({
    core: { agentSessions: sessions } as never,
    identity: () => identity,
  });
  await app.ready();
  return {
    name,
    sessions,
    projects: new ProjectsService(db, projectManager),
    app,
  };
}

/** Read server-sent events off a live stream, one parsed message at a time. */
class EventReader {
  readonly ids: string[] = [];
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async next(): Promise<SessionStreamMessage> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) this.ids.push(line.slice(4));
          if (line.startsWith("data: ")) data += line.slice(6);
        }
        return JSON.parse(data);
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("The stream ended");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Events until one matches, collecting every event on the way. */
  async until(
    match: (event: StoredSessionEvent) => boolean,
  ): Promise<StoredSessionEvent[]> {
    const seen: StoredSessionEvent[] = [];
    for (;;) {
      const message = await this.next();
      if (message.type !== "events") continue;
      seen.push(...message.events);
      if (message.events.some(match)) return seen;
    }
  }

  close(): Promise<void> {
    return this.reader.cancel();
  }
}

const isEchoReply =
  (text: string) =>
  (event: StoredSessionEvent): boolean =>
    (event.event.type === "item.added" ||
      event.event.type === "item.changed") &&
    event.event.item.kind === "assistant_message" &&
    event.event.item.status === "completed" &&
    event.event.item.text.startsWith(`Echo: ${text}`);

describe("session log routes", () => {
  let tmpDir: string;
  let source: Backend;
  let copy: Backend;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-routes-"));
    [source, copy] = await Promise.all([
      backend("source", tmpDir),
      backend("copy", tmpDir),
    ]);
    baseUrl = await source.app.listen({ host: "127.0.0.1", port: 0 });
  }, 60_000);

  afterAll(async () => {
    for (const each of [source, copy]) {
      await each?.app.close();
      await each?.sessions.stopLocalTurns();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function chat(name: string) {
    const project = await source.projects.create(identity, { name });
    const session = await source.sessions.create(identity, project.id);
    const base = `/api/projects/${project.id}/agent/sessions/${session.id}`;
    return { projectId: project.id, sessionId: session.id, base };
  }

  async function command(url: string, body: object): Promise<CommandReceipt> {
    const response = await source.app.inject({
      method: "POST",
      url: `${url}/commands`,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function settled(url: string, turns: number): Promise<SessionSnapshot> {
    return vi.waitFor(
      async () => {
        const response = await source.app.inject({ method: "GET", url });
        const { snapshot } = response.json() as { snapshot: SessionSnapshot };
        expect(snapshot.turns.map((turn) => turn.status)).toEqual(
          Array.from({ length: turns }, () => "completed"),
        );
        return snapshot;
      },
      { timeout: 15_000 },
    );
  }

  async function open(url: string, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${url}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = response.body;
    if (!body) throw new Error("No stream body");
    return new EventReader(body.getReader());
  }

  it("returns the snapshot with its cursor, and pages older items", async () => {
    const { base } = await chat("Snapshot");
    await command(base, { type: "send", commandId: randomUUID(), text: "hi" });
    const snapshot = await settled(base, 1);
    expect(snapshot.items.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(snapshot.sequence).toBeGreaterThan(0);

    const page = await source.app.inject({
      method: "GET",
      url: `${base}/items?before=${snapshot.items[1]?.position}`,
    });
    expect(page.statusCode).toBe(200);
    expect(
      page.json().items.map((item: { kind: string }) => item.kind),
    ).toEqual(["user_message"]);

    const legacy = await source.app.inject({
      method: "POST",
      url: `${base}/messages`,
      payload: { message: "hello" },
    });
    expect(legacy.statusCode).toBe(404);
  });

  it("streams a turn's events as server-sent events and resumes from Last-Event-ID", async () => {
    const { base } = await chat("Stream");
    const stream = await open(`${base}/events?after=0`);
    await command(base, { type: "send", commandId: randomUUID(), text: "one" });
    const events = await stream.until(isEchoReply("one"));
    // Gapless from the cursor, and every frame's id is its last sequence.
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    const lastId = stream.ids.at(-1);
    expect(lastId).toBe(String(events.at(-1)?.sequence));
    await stream.close();

    // A reconnecting EventSource names its cursor in Last-Event-ID, which
    // wins over the URL's `after`.
    const resumed = await open(`${base}/events?after=0`, {
      "last-event-id": lastId ?? "0",
    });
    await command(base, { type: "send", commandId: randomUUID(), text: "two" });
    const later = await resumed.until(isEchoReply("two"));
    expect(later[0]?.sequence).toBeGreaterThan(Number(lastId));
    await resumed.close();
  });

  it("refuses a stream of a session the caller cannot reach", async () => {
    const { projectId } = await chat("Missing");
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/agent/sessions/${randomUUID()}/events`,
    );
    expect(response.status).toBe(404);
  });

  it("answers a repeated command with its first receipt, and a refusal with 200", async () => {
    const { base } = await chat("Commands");
    const send = { type: "send", commandId: randomUUID(), text: "once" };
    const first = await command(base, send);
    const second = await command(base, send);
    expect(first.status).toBe("accepted");
    expect(second).toEqual(first);
    const snapshot = await settled(base, 1);
    expect(
      snapshot.items.filter((item) => item.kind === "user_message"),
    ).toHaveLength(1);

    const refused = await command(base, {
      type: "respond",
      commandId: randomUUID(),
      requestId: randomUUID(),
      response: { kind: "question", answers: ["Yes"] },
    });
    expect(refused).toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });

    const invalid = await source.app.inject({
      method: "POST",
      url: `${base}/commands`,
      payload: { type: "send", text: "no command id" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("mirrors a session to another backend, asking for what it lacks", async () => {
    const { base: sourceUrl, sessionId } = await chat("Mirrored");
    await command(sourceUrl, {
      type: "send",
      commandId: randomUUID(),
      text: "first",
    });
    await settled(sourceUrl, 1);
    const detail = (
      await source.app.inject({ method: "GET", url: sourceUrl })
    ).json();
    const authority = {
      hostId: detail.authorityHostId,
      revision: detail.authorityRevision,
    };
    const target = await copy.projects.create(identity, { name: "Copy" });
    const copyUrl = `/api/projects/${target.id}/agent/sessions/${sessionId}`;
    const push = (body: object) =>
      copy.app.inject({
        method: "PUT",
        url: `${copyUrl}/mirror`,
        payload: body,
      });

    // A copy that does not exist yet needs a base.
    const exportAll = (
      await source.app.inject({ method: "GET", url: `${sourceUrl}/mirror` })
    ).json();
    const missing = await push({ authority, events: exportAll.events });
    expect([
      missing.statusCode,
      missing.json().code,
      missing.json().sequence,
    ]).toEqual([409, "behind", 0]);
    const created = await push({ authority, base: exportAll.base, events: [] });
    expect(created.statusCode).toBe(200);
    const atBase = created.json().sequence;
    expect(atBase).toBe(exportAll.base.sequence);
    expect(created.json().session).toMatchObject({
      id: sessionId,
      mirrorSequence: atBase,
    });

    // A push that skips events is told where the copy ends.
    await command(sourceUrl, {
      type: "send",
      commandId: randomUUID(),
      text: "second",
    });
    await settled(sourceUrl, 2);
    const delta = (
      await source.app.inject({
        method: "GET",
        url: `${sourceUrl}/mirror?after=${atBase}`,
      })
    ).json();
    expect(delta.base).toBeUndefined();
    expect(delta.events.length).toBeGreaterThan(1);
    const gap = await push({ authority, events: delta.events.slice(1) });
    expect([gap.statusCode, gap.json()]).toMatchObject([
      409,
      { code: "behind", sequence: atBase },
    ]);
    const caughtUp = await push({ authority, events: delta.events });
    expect(caughtUp.statusCode).toBe(200);
    expect(caughtUp.json().sequence).toBe(delta.events.at(-1).sequence);
    const mirrored = (
      await copy.app.inject({ method: "GET", url: copyUrl })
    ).json();
    expect(
      mirrored.snapshot.items
        .filter((item: { kind: string }) => item.kind === "assistant_message")
        .map((item: { text: string }) => item.text),
    ).toEqual(["Echo: first", expect.stringMatching(/^Echo: second/)]);

    // Another authority than the copy's own is a fork: stop pushing.
    const forked = await push({
      authority: { hostId: "another-host", revision: 1 },
      events: [],
    });
    expect([forked.statusCode, forked.json().code]).toEqual([409, "diverged"]);
  });
});
