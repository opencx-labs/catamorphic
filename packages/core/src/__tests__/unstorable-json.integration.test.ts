import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EchoAdapter } from "@catamorphic/agent-runner";
import {
  createDatabase,
  type DB,
  migrateToLatest,
  withStorableParameters,
} from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import {
  generateExecutorKeyPair,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import type { AppBundleStore } from "../services/app-bundle-store.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import {
  openRemoteOperation,
  RemoteOperationQueue,
  RemoteReceiptRefusedError,
  registerExecutorKey,
} from "../services/remote-operations.js";
import type { RunsService } from "../services/runs-service.js";
import { SessionArtifactValidationError } from "../services/session-artifacts-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { TriggersService } from "../services/triggers-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * JSON a service builds itself reaches jsonb as every other value does: half
 * of an emoji, as a cut at a length leaves it, or a NUL byte arrives as
 * U+FFFD. jsonb refuses both, and with either the whole statement, so a
 * trigger filter or a workflow schema carrying one failed the deploy, an app
 * contract the build, a file name the artifact.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const schema = `catamorphic_unstorable_json_${randomUUID().replaceAll("-", "")}`;
const identity: Identity = {
  tenantId: randomUUID(),
  externalUserId: "builder",
};
/** The first half of an emoji's surrogate pair, as a cut leaves it. */
const HALF_EMOJI = "🚀".slice(0, 1);
/** In Unicode mode, a surrogate is a character of its own only when alone. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;

/** Every string in a value, keys included. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...strings(item),
    ]);
  return [];
}

/** The strings in a value that hold half of an emoji or a NUL. */
function unstorable(value: unknown): string[] {
  return strings(value).filter(
    (text) => LONE_SURROGATE.test(text) || text.includes("\u0000"),
  );
}

/**
 * A workflow whose trigger config, filter and input type carry a NUL and
 * half an emoji, each written as an escape in a string literal.
 */
const TICKETS = String.raw`
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

export const triage = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("ticket.created", {
      label: "urgent \0 \ud83d",
      where: { title: { $prefix: "\ud83d\0" } },
    }),
  ],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ ticketId: string; mode: "\0" | "\ud83d" }>) => ({
        ok: input.ticketId,
      }),
    }),
  ],
}));
`;
const APP_API = `import { triage } from "./tickets.js";

export const appApi = { triage };
`;
/** The input schema of {@link TICKETS} as jsonb stores it. */
const STORED_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ticketId: { type: "string" },
    mode: { enum: ["\uFFFD", "\uFFFD"] },
  },
};

const ticketCreated: TriggerKindRuntime = {
  name: "ticket.created",
  description: "A ticket was created",
  display: { label: "Ticket Created", icon: "bell", color: "#ca8a04" },
  payloadJsonSchema: {
    type: "object",
    properties: { ticketId: { type: "string" } },
    required: ["ticketId"],
  },
  configJsonSchema: {
    type: "object",
    properties: { label: { type: "string" } },
  },
  validatePayload: () => ({ ok: true }),
  validateConfig: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ok: true }
      : { ok: false, errors: ["config must be an object"] },
};

class MemoryBundleStore implements AppBundleStore {
  private readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const data = this.objects.get(key);
    return data ? { data, etag: "test" } : null;
  }

  async put(key: string, data: Uint8Array) {
    this.objects.set(key, data);
  }

  async deletePrefix(prefix: string) {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

/** Builds succeed against nothing and serve a fixed bundle. */
class BuildFakeProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";

  async createSandbox() {
    return {
      id: randomUUID(),
      providerId: `build-sandbox-${randomUUID()}`,
      sandboxType: "dev" as const,
      status: "started" as const,
    };
  }

  async startSandbox(): Promise<void> {}
  async stopSandbox(): Promise<void> {}
  async destroySandbox(): Promise<void> {}
  async getSandboxStatus() {
    return "started" as const;
  }

  async executeCommand() {
    return { exitCode: 0, result: "" };
  }

  async uploadFiles(): Promise<void> {}

  async downloadFile(_sandboxId: string, filePath: string) {
    if (filePath.endsWith("dist/app.js")) return "console.log('built app');";
    if (filePath.endsWith("dist/app.css")) return ".app{color:red}";
    throw new Error(`Unexpected download: ${filePath}`);
  }

  async gitClone(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
}

/** PGlite, wrapped as core wraps whatever database a host injects. */
function pglite(): Kysely<DB> {
  return withStorableParameters(
    new Kysely<DB>({
      dialect: new PGliteDialect({
        pglite: new PGlite({ extensions: { pgcrypto } }),
      }),
      plugins: [new WithSchemaPlugin(schema)],
    }),
  );
}

const databases: Array<[string, () => Kysely<DB>]> = [["PGlite", pglite]];
if (connectionString)
  databases.push([
    "Postgres",
    () => createDatabase({ connectionString, schema, poolSize: 4 }),
  ]);

describe.each(databases)("JSON a service builds, on %s", (name, open) => {
  const db = open();
  let tmpDir: string | undefined;
  let projectManager: ProjectManager;
  let core: CatamorphicCore;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unstorable-json-"));
    tmpDir = dir;
    await migrateToLatest({ db, schema });
    projectManager = new ProjectManager(
      new FsBackend(path.join(dir, "dev")),
      new FsRemoteBackend(path.join(dir, "origin")),
    );
    const provider = new BuildFakeProvider();
    const echo: RegisteredCodingAgent = {
      id: "echo",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    core = new CatamorphicCore({
      hostId: `unstorable-json-${name}`,
      db,
      projectManager,
      sandboxProvider: provider,
      environmentProvider: testEnvironmentProvider(provider),
      appBundleStore: new MemoryBundleStore(),
      triggerKinds: [ticketCreated],
      codingAgent: echo,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      // Setup may have failed before core existed.
      await core?.runs.stopWorkers();
      await core?.agentSessions?.stopLocalTurns();
      if (name === "Postgres")
        await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    } finally {
      await db.destroy();
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function project(title: string): Promise<string> {
    return (await core.projects.create(identity, { name: title })).id;
  }

  function sessions() {
    if (!core.agentSessions) throw new Error("agent sessions not configured");
    return core.agentSessions;
  }

  function apps() {
    if (!core.apps) throw new Error("apps not configured");
    return core.apps;
  }
  async function publish(projectId: string): Promise<void> {
    await projectManager.publishFiles({
      tenantId: identity.tenantId,
      projectId,
      files: { ".work/workflows/src/tickets.ts": TICKETS },
      message: "Triage tickets",
      author: { name: "Builder", email: "builder@example.com" },
    });
  }

  it("records the trigger bindings of a commit whose filter and schema carry them", async () => {
    const projectId = await project("Triggers");
    await publish(projectId);
    const bindings = await core.triggers.list({ identity, projectId });
    expect(bindings.map((binding) => binding.workflowName)).toEqual(["triage"]);
    const stored = await db
      .selectFrom("trigger_definitions")
      .select([
        "config",
        "where_filters",
        "input_parameters",
        "input_schema",
        "output_schema",
      ])
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    expect(stored.config).toEqual({ label: "urgent \uFFFD \uFFFD" });
    expect(stored.where_filters).toEqual([
      { title: { $prefix: "\uFFFD\uFFFD" } },
    ]);
    expect(stored.input_schema).toMatchObject(STORED_INPUT_SCHEMA);
    expect(stored.input_parameters).toMatchObject([
      { name: "ticketId" },
      { name: "mode", schema: { enum: ["\uFFFD", "\uFFFD"] } },
    ]);
    expect(stored.output_schema).toMatchObject({
      properties: { ok: { type: "string" } },
    });
    expect(unstorable(stored)).toEqual([]);
  });

  it("gives every replica a commit's trigger bindings as stored, and matches payloads in that form", async () => {
    const projectId = await project("Trigger replicas");
    await publish(projectId);
    const started: unknown[] = [];
    // Replicas of one control plane: their own scan memo, one database.
    const replica = () =>
      new TriggersService(db, {
        kinds: [ticketCreated],
        projectManager,
        runs: {
          triggerProduction: async (args: { input: unknown }) => {
            started.push(args.input);
            return { id: randomUUID() };
          },
        } as unknown as RunsService,
      });
    const scanning = replica();
    const other = replica();
    // The first scans the commit and records it; the second reads the rows.
    const scanned = await scanning.list({ identity, projectId });
    const read = await other.list({ identity, projectId });
    expect(unstorable(scanned)).toEqual([]);
    expect(scanned).toEqual(read);
    expect(scanned[0]?.where).toEqual([{ title: { $prefix: "\uFFFD\uFFFD" } }]);
    // A ticket whose title starts as the filter was written matches on both,
    // and one that does not on neither. Each run gets the payload as sent.
    const down = { ticketId: "t-1", title: `${HALF_EMOJI}\u0000 down` };
    for (const triggers of [scanning, other])
      for (const payload of [down, { ticketId: "t-2", title: "all good" }])
        await triggers.fire({
          identity,
          projectId,
          kind: "ticket.created",
          payload,
          interactive: true,
        });
    expect(started).toEqual([down, down]);
  });

  it("builds an app whose workflow contract carries them", async () => {
    const projectId = await project("Apps");
    for (const [file, content] of Object.entries({
      ".work/workflows/src/tickets.ts": TICKETS,
      ".work/workflows/src/app-api.ts": APP_API,
      ".work/apps/desk/package.json": JSON.stringify({
        name: "desk",
        private: true,
      }),
      ".work/apps/desk/src/main.tsx": "export {};",
    }))
      await core.projects.writeFile(identity, projectId, file, { content });
    const version = await apps().build({
      identity,
      projectId,
      appName: "desk",
      kind: "preview",
    });
    expect(version.error).toBeNull();
    expect(version.status).toBe("ready");
    expect(version.allowedWorkflows).toEqual(["triage"]);
    const stored = await db
      .selectFrom("app_versions")
      .select(["allowed_workflows", "workflow_shapes", "access"])
      .where("id", "=", version.id)
      .executeTakeFirstOrThrow();
    expect(stored.allowed_workflows).toEqual(["triage"]);
    expect(stored.workflow_shapes).toMatchObject({
      triage: { inputSchema: STORED_INPUT_SCHEMA },
    });
    expect(stored.access).toEqual({});
    expect(unstorable(stored)).toEqual([]);
  });

  it("keeps a file whose name an agent cut through an emoji under one name", async () => {
    const projectId = await project("Artifacts");
    const session = await sessions().create(identity, projectId);
    // As the agent names it, and as git and Postgres keep it.
    const named = `notes/plan ${HALF_EMOJI}.md`;
    const kept = "notes/plan \uFFFD.md";
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      sessionId: session.id,
      kind: "app",
      name: "review",
      source: "export default function App() { return <p>Plan</p>; }",
      files: { [named]: "# Plan" },
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const keptPaths = async () => {
      const { source_paths } = await db
        .selectFrom("session_artifacts")
        .select("source_paths")
        .where("id", "=", artifact.id)
        .executeTakeFirstOrThrow();
      return Array.isArray(source_paths)
        ? source_paths.filter((path) => path === kept)
        : [];
    };
    expect((await core.sessionArtifacts.files(address))[kept]).toBe("# Plan");
    expect(await keptPaths()).toEqual([kept]);
    // Written again under the name the agent gave it: one file, one path.
    const rewritten = await core.sessionArtifacts.update({
      ...address,
      revision: artifact.revision,
      files: { [named]: "# Plan, again" },
    });
    expect((await core.sessionArtifacts.files(address))[kept]).toBe(
      "# Plan, again",
    );
    expect(await keptPaths()).toEqual([kept]);
    // Deleted by that name: gone from the files and the paths.
    await core.sessionArtifacts.update({
      ...address,
      revision: rewritten.revision,
      files: { [named]: null },
    });
    expect(
      Object.keys(await core.sessionArtifacts.files(address)),
    ).not.toContain(kept);
    expect(await keptPaths()).toEqual([]);
    const revisions = await db
      .selectFrom("session_artifact_revisions")
      .select("source_paths")
      .where("artifact_id", "=", artifact.id)
      .execute();
    expect(revisions).toHaveLength(3);
    expect(unstorable(revisions)).toEqual([]);
    // A NUL cannot be in a file name.
    await expect(
      core.sessionArtifacts.update({
        ...address,
        revision: rewritten.revision + 1,
        files: { "notes/a\u0000.md": "# A" },
      }),
    ).rejects.toThrow(SessionArtifactValidationError);
  });

  it("names approvers whose names carry them", async () => {
    const projectId = await project("Approvers");
    const session = await sessions().create(identity, projectId);
    await sessions().setApprovers({
      identity,
      projectId,
      sessionId: session.id,
      approvers: { roles: [`lead ${HALF_EMOJI}\u0000`] },
    });
    const stored = await db
      .selectFrom("agent_sessions")
      .select("approvers")
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    expect(stored.approvers).toEqual({ roles: ["lead \uFFFD\uFFFD"] });
  });

  it("stores a machine's error with U+FFFD and hands its output back with NUL as U+FFFD", async () => {
    const lease = {
      executor: `node:${randomUUID()}`,
      leaseToken: randomUUID(),
    };
    const keys = generateExecutorKeyPair();
    await registerExecutorKey({ db, ...lease, publicKey: keys.publicKey });
    const queue = new RemoteOperationQueue(db);
    const provider = queue.provider({
      ...lease,
      leaseHeld: async (token) => token === lease.leaseToken,
      label: "The worker",
      workspaceRoot: "/workspace",
      processes: false,
    });
    const take = async () => {
      const [job] = await queue.poll({
        ...lease,
        pollId: randomUUID(),
        waitMs: 5_000,
        leaseHeld: async () => true,
      });
      if (!job) throw new Error("no operation queued");
      openRemoteOperation({
        operationId: job.id,
        executor: lease.executor,
        envelope: job.operation,
        privateKeys: [keys.privateKey],
      });
      return job.id;
    };
    // The response is sealed before it is stored; its NUL arrives as U+FFFD,
    // as a machine's output always has (the Work server's remote execution
    // test pins it), and the rest as printed.
    const printed = `built\u0000 ok ${HALF_EMOJI}`;
    const ran = provider.executeCommand("sandbox-1", "cat build.log");
    await queue.complete({
      ...lease,
      operationId: await take(),
      response: { exitCode: 0, result: printed },
    });
    await expect(ran).resolves.toEqual({
      exitCode: 0,
      result: `built\uFFFD ok ${HALF_EMOJI}`,
    });
    // An error is stored in the clear, as text Postgres keeps.
    const error = `No such file: notes\u0000 ${HALF_EMOJI}`;
    const failed = provider.downloadFile("sandbox-1", "/missing");
    const failure = failed.catch((cause: unknown) => cause);
    await queue.complete({ ...lease, operationId: await take(), error });
    expect(String(await failure)).toContain("No such file: notes\uFFFD \uFFFD");
    // A receipt retried after its answer was lost, for an operation no
    // controller has read yet, is recognized as recorded: its error matches
    // the stored one, U+FFFD and all.
    const { id } = await db
      .insertInto("remote_operations")
      .values({
        executor: lease.executor,
        lease_token: lease.leaseToken,
        operation: { kind: "download" },
        status: "running",
        reply_key: keys.publicKey,
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await queue.complete({ ...lease, operationId: id, error });
    await queue.complete({ ...lease, operationId: id, error });
    expect(
      await db
        .selectFrom("remote_operations")
        .select(["status", "error"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed", error: "No such file: notes\uFFFD \uFFFD" });
    // Another receipt for it is refused.
    await expect(
      queue.complete({ ...lease, operationId: id, error: "Other" }),
    ).rejects.toBeInstanceOf(RemoteReceiptRefusedError);
  });
});
