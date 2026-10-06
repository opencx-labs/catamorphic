import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createDatabase, type DB, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import { SessionPreviewError } from "../services/session-previews-service.js";
import { SessionTerminalNotFoundError } from "../services/session-terminals-service.js";
import { SessionWorkspaceUnavailableError } from "../services/session-workspace.js";
import { RecordingAdapter } from "./recording-adapter.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * Terminals and previews in a chat's workspace (ADR 0208), on a real
 * local-process sandbox: a login shell on a pseudo-terminal that is typed
 * into, read by cursor, resized and closed; the Environment's secrets
 * loaded; access only for whom the chat's workspace is; and HTTP requests
 * made inside the sandbox to a server listening there.
 */

// Postgres when the run has one, else PGlite in this process.
const connectionString = process.env.DATABASE_URL ?? "";
const schema = `catamorphic_terminals_${crypto.randomUUID().replaceAll("-", "")}`;
const tenantId = crypto.randomUUID();
const alice: Identity = { tenantId, externalUserId: "alice" };

/** A free port on this machine, which a local-process sandbox shares. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const SERVER = `
const http = require("node:http");
const port = Number(process.argv[1]);
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.url === "/go") {
      res.writeHead(302, { location: "/landing?from=go" });
      return res.end();
    }
    if (req.url === "/big") {
      res.setHeader("content-type", "application/octet-stream");
      return res.end(Buffer.alloc(5 * 1024 * 1024, 7));
    }
    if (req.url === "/huge") return res.end(Buffer.alloc(17 * 1024 * 1024, 1));
    res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
    res.setHeader("content-type", "application/json");
    res.statusCode = req.method === "POST" ? 201 : 200;
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString("utf8"),
      cookie: req.headers.cookie ?? null,
      authorization: req.headers.authorization ?? null,
      host: req.headers.host,
    }));
  });
}).listen(port, "127.0.0.1", () => console.log("listening"));
`;

describe("terminals and previews in a chat's workspace (ADR 0208)", () => {
  let tmpDir: string;
  let db: Kysely<DB>;
  let core: CatamorphicCore;
  let provider: LocalProcessSandboxProvider;
  let projectId: string;
  let bob: Identity;
  let carol: Identity;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-terminals-"));
    provider = new LocalProcessSandboxProvider({
      root: path.join(tmpDir, "sandboxes"),
    });
    db = connectionString
      ? createDatabase({ connectionString, schema, poolSize: 4 })
      : new Kysely<DB>({
          dialect: new PGliteDialect({
            pglite: new PGlite({ extensions: { pgcrypto } }),
          }),
          plugins: [new WithSchemaPlugin(schema)],
        });
    await migrateToLatest({ db, schema });
    const agent = {
      id: "worker",
      harness: { placement: "host" as const, adapter: new RecordingAdapter() },
      topology: "controller" as const,
    };
    core = new CatamorphicCore({
      hostId: "terminals-test-host",
      db,
      projectManager: new ProjectManager(
        new FsBackend(path.join(tmpDir, "projects")),
      ),
      environmentProvider: testEnvironmentProvider(provider),
      codingAgent: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
    });
    projectId = (await core.projects.create(alice, { name: "Terminals" })).id;
    const member = {
      scope: [{ kind: "agent" as const, projectId, name: "*" }],
      executionScope: [{ projectId, name: "*" }],
    };
    bob = { tenantId, externalUserId: "bob", ...member };
    carol = {
      tenantId,
      externalUserId: "carol",
      ...member,
      projectPermissions: [{ projectId, permission: "sessions:write" }],
    };
  }, 120_000);

  afterAll(async () => {
    // Every workspace goes, and whatever still runs in it.
    const sandboxes = await db
      .selectFrom("project_sandboxes")
      .select("provider_id")
      .execute();
    for (const sandbox of sandboxes)
      await provider.destroySandbox(sandbox.provider_id).catch(() => {});
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  const terminals = () => {
    if (!core.sessionTerminals) throw new Error("terminals not configured");
    return core.sessionTerminals;
  };
  const previews = () => {
    if (!core.sessionPreviews) throw new Error("previews not configured");
    return core.sessionPreviews;
  };
  const chat = async (identity: Identity) => {
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("sessions not configured");
    return (await sessions.create(identity, projectId)).id;
  };

  /** Read a terminal until its output (from `cursor`) matches. */
  async function readUntil(input: {
    identity: Identity;
    sessionId: string;
    terminalId: string;
    cursor: number;
    match: RegExp;
  }): Promise<{ text: string; cursor: number }> {
    let text = "";
    let cursor = input.cursor;
    const deadline = Date.now() + 30_000;
    while (!input.match.test(text)) {
      if (Date.now() > deadline)
        throw new Error(`Terminal never printed ${input.match}: ${text}`);
      const read = await terminals().read({
        identity: input.identity,
        projectId,
        sessionId: input.sessionId,
        terminalId: input.terminalId,
        cursor,
        waitMs: 1_000,
      });
      text += read.data;
      cursor = read.nextCursor;
      if (read.exited && !input.match.test(text))
        throw new Error(`Terminal ended before ${input.match}: ${text}`);
    }
    return { text, cursor };
  }

  it("starts the workspace, runs a login shell on a pseudo-terminal, resizes and closes", async () => {
    const sessionId = await chat(alice);
    const opened = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 100,
      rows: 30,
    });
    expect(opened.pty).toBe(true);
    const base = { identity: alice, sessionId, terminalId: opened.terminalId };
    await terminals().write({
      ...base,
      projectId,
      data: "echo hello-$((40+2))\n",
    });
    let { cursor } = await readUntil({ ...base, cursor: 0, match: /hello-42/ });

    // The shell starts in the project folder, which the workspace seeded.
    await terminals().write({ ...base, projectId, data: 'basename "$PWD"\n' });
    ({ cursor } = await readUntil({
      ...base,
      cursor,
      match: /\bproject\r?\n/,
    }));

    await terminals().write({ ...base, projectId, data: "stty size\n" });
    ({ cursor } = await readUntil({ ...base, cursor, match: /30 100/ }));
    await terminals().resize({ ...base, projectId, cols: 120, rows: 40 });
    await terminals().write({ ...base, projectId, data: "stty size\n" });
    ({ cursor } = await readUntil({ ...base, cursor, match: /40 120/ }));

    // Typing, and reading output, keep the workspace from counting as
    // idle, recorded at most once a minute.
    const usedAgo = async () =>
      Number(
        (
          await db
            .selectFrom("session_workspace_use")
            .select(sql<number>`extract(epoch from now() - used_at)`.as("ago"))
            .where("session_id", "=", sessionId)
            .executeTakeFirstOrThrow()
        ).ago,
      );
    const longAgo = () =>
      db
        .updateTable("session_workspace_use")
        .set({ used_at: sql<Date>`now() - interval '1 hour'` })
        .where("session_id", "=", sessionId)
        .execute();
    expect(await usedAgo()).toBeLessThan(60);
    await longAgo();
    await terminals().write({ ...base, projectId, data: "true\n" });
    expect(await usedAgo()).toBeLessThan(60);
    await longAgo();
    await terminals().read({ ...base, projectId, cursor, waitMs: 0 });
    expect(await usedAgo()).toBeLessThan(60);
    const marked = (
      await db
        .selectFrom("session_workspace_use")
        .select("used_at")
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).used_at;
    await terminals().read({ ...base, projectId, cursor, waitMs: 0 });
    const again = (
      await db
        .selectFrom("session_workspace_use")
        .select("used_at")
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).used_at;
    expect(new Date(again).getTime()).toBe(new Date(marked).getTime());

    await terminals().close({ ...base, projectId });
    await expect(
      terminals().read({ ...base, projectId, cursor, waitMs: 0 }),
    ).rejects.toBeInstanceOf(SessionTerminalNotFoundError);
  }, 120_000);

  it("ends with a workspace given back, and opening one admits the chat again", async () => {
    const sessionId = await chat(alice);
    const opened = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    const before = await db
      .selectFrom("agent_sessions")
      .select(["allocation_id", "sandbox_id"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    // Released while idle (ADR 0173).
    await core.executionAllocations.release({
      identity: alice,
      allocationId: before.allocation_id ?? "",
      reason: "idle",
    });
    await expect(
      terminals().read({
        identity: alice,
        projectId,
        sessionId,
        terminalId: opened.terminalId,
        cursor: 0,
      }),
    ).rejects.toThrow("This terminal ended with its chat's workspace.");
    await expect(
      previews().request({
        identity: alice,
        projectId,
        sessionId,
        port: 3000,
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({ reason: "not_running" });

    const again = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    const after = await db
      .selectFrom("agent_sessions")
      .select(["allocation_id", "sandbox_id"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(after.allocation_id).not.toBe(before.allocation_id);
    expect(after.sandbox_id).not.toBe(before.sandbox_id);
    await terminals().write({
      identity: alice,
      projectId,
      sessionId,
      terminalId: again.terminalId,
      data: "echo again-$((2+3))\n",
    });
    await readUntil({
      identity: alice,
      sessionId,
      terminalId: again.terminalId,
      cursor: 0,
      match: /again-5/,
    });
    // The earlier workspace's terminal is forgotten with it.
    const kept = await db
      .selectFrom("session_terminals")
      .select("process_id")
      .where("session_id", "=", sessionId)
      .execute();
    expect(kept.map((row) => row.process_id)).toEqual([again.terminalId]);
    await terminals().close({
      identity: alice,
      projectId,
      sessionId,
      terminalId: again.terminalId,
    });
  }, 120_000);

  it("keeps a workspace someone uses from being given back as idle", async () => {
    const sessionId = await chat(alice);
    const opened = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    const row = await db
      .selectFrom("agent_sessions")
      .select("allocation_id")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const allocationId = row.allocation_id ?? "";
    // The workspace sits on a remote machine and has idled past its
    // Environment's 30 minutes, with no turn since.
    const nodeId = `node-${crypto.randomUUID()}`;
    await db
      .insertInto("worker_nodes")
      .values({
        id: nodeId,
        tenant_id: tenantId,
        authority_id: "test",
        descriptor: JSON.stringify({}),
        lease_token: crypto.randomUUID(),
        lease_expires_at: new Date(Date.now() + 3_600_000),
        remote: JSON.stringify({}),
      })
      .execute();
    await db
      .updateTable("execution_allocations")
      .set({
        worker_node_id: nodeId,
        created_at: new Date(Date.now() - 2 * 3_600_000),
      })
      .where("id", "=", allocationId)
      .execute();
    const status = async () =>
      (
        await db
          .selectFrom("execution_allocations")
          .select("status")
          .where("id", "=", allocationId)
          .executeTakeFirstOrThrow()
      ).status;
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("sessions not configured");

    // Opening the terminal marked it used a moment ago: it stays.
    expect(await sessions.releaseIdleWorkspaces()).toBe(0);
    expect(await status()).toBe("active");

    // Nobody has used it for an hour: it goes, and its terminal with it.
    await db
      .updateTable("session_workspace_use")
      .set({ used_at: sql<Date>`now() - interval '1 hour'` })
      .where("session_id", "=", sessionId)
      .execute();
    expect(await sessions.releaseIdleWorkspaces()).toBe(1);
    expect(await status()).toBe("released");
    await expect(
      terminals().read({
        identity: alice,
        projectId,
        sessionId,
        terminalId: opened.terminalId,
        cursor: 0,
      }),
    ).rejects.toThrow("This terminal ended with its chat's workspace.");
  }, 120_000);

  it("loads the Environment's secrets into the shell when the workspace has them", async () => {
    const sessionId = await chat(alice);
    const first = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    // The first shell is up (and found no secrets) before they arrive.
    await terminals().write({
      identity: alice,
      projectId,
      sessionId,
      terminalId: first.terminalId,
      data: "echo up-$((1+1))\n",
    });
    const { cursor: firstCursor } = await readUntil({
      identity: alice,
      sessionId,
      terminalId: first.terminalId,
      cursor: 0,
      match: /up-2/,
    });
    const workspace = await core.agentSessions?.personWorkspace({
      identity: alice,
      projectId,
      sessionId,
      start: false,
    });
    if (!workspace) throw new Error("no workspace");
    await workspace.provider.uploadFiles(
      workspace.sandboxId,
      { "env/secrets.sh": "export TERMINAL_SECRET='s3cret value'\n" },
      workspace.sessionDirectory,
    );
    const second = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    const base = { identity: alice, projectId, sessionId };
    await terminals().write({
      ...base,
      terminalId: second.terminalId,
      data: 'echo "[$TERMINAL_SECRET]"\n',
    });
    await readUntil({
      ...base,
      terminalId: second.terminalId,
      cursor: 0,
      match: /\[s3cret value\]/,
    });
    // A shell opened before the file existed has nothing to load.
    await terminals().write({
      ...base,
      terminalId: first.terminalId,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
      data: 'echo "<${TERMINAL_SECRET:-none}>"\n',
    });
    await readUntil({
      ...base,
      terminalId: first.terminalId,
      cursor: firstCursor,
      match: /<none>/,
    });
    await terminals().close({ ...base, terminalId: first.terminalId });
    await terminals().close({ ...base, terminalId: second.terminalId });
  }, 120_000);

  it("is the chat owner's alone, or for a project chat anyone's with sessions:write", async () => {
    const sessionId = await chat(alice);
    const opened = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    for (const other of [bob, carol]) {
      await expect(
        terminals().open({
          identity: other,
          projectId,
          sessionId,
          cols: 80,
          rows: 24,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        terminals().read({
          identity: other,
          projectId,
          sessionId,
          terminalId: opened.terminalId,
          cursor: 0,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        previews().request({
          identity: other,
          projectId,
          sessionId,
          port: 80,
          method: "GET",
          path: "/",
          headers: [],
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    await terminals().close({
      identity: alice,
      projectId,
      sessionId,
      terminalId: opened.terminalId,
    });

    const projectChat = await chat(
      projectChatIdentity({ tenantId, projectId }),
    );
    await expect(
      terminals().open({
        identity: bob,
        projectId,
        sessionId: projectChat,
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const carols = await terminals().open({
      identity: carol,
      projectId,
      sessionId: projectChat,
      cols: 80,
      rows: 24,
    });
    // Another person who may work in the chat still cannot read hers.
    await expect(
      terminals().read({
        identity: alice,
        projectId,
        sessionId: projectChat,
        terminalId: carols.terminalId,
        cursor: 0,
      }),
    ).rejects.toBeInstanceOf(SessionTerminalNotFoundError);
    await terminals().close({
      identity: carol,
      projectId,
      sessionId: projectChat,
      terminalId: carols.terminalId,
    });
  }, 120_000);

  it("previews a server in the workspace: methods, bodies, cookies, redirects and limits", async () => {
    const sessionId = await chat(alice);
    // A preview never starts a workspace: nothing would listen in it.
    await expect(
      previews().request({
        identity: alice,
        projectId,
        sessionId,
        port: 3000,
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({
      constructor: SessionWorkspaceUnavailableError,
      reason: "not_running",
    });
    const opened = await terminals().open({
      identity: alice,
      projectId,
      sessionId,
      cols: 80,
      rows: 24,
    });
    const workspace = await core.agentSessions?.personWorkspace({
      identity: alice,
      projectId,
      sessionId,
      start: false,
    });
    const processes = workspace?.provider.processes;
    if (!workspace || !processes) throw new Error("no workspace processes");
    const port = await freePort();
    const server = await processes.startProcess({
      sandboxId: workspace.sandboxId,
      command: `node -e '${SERVER.replaceAll("'", `'\\''`)}' ${port}`,
      cwd: workspace.projectDirectory,
      name: "Preview server",
    });
    let started = "";
    const deadline = Date.now() + 20_000;
    while (!started.includes("listening")) {
      if (Date.now() > deadline) throw new Error(`No server: ${started}`);
      const read = await processes.readProcessOutput({
        sandboxId: workspace.sandboxId,
        processId: server.processId,
        cursor: started.length,
        waitMs: 1_000,
      });
      started += read.chunk;
    }
    const preview = (input: {
      method: string;
      path: string;
      headers?: Array<[string, string]>;
      body?: string;
    }) =>
      previews().request({
        identity: alice,
        projectId,
        sessionId,
        port,
        method: input.method,
        path: input.path,
        headers: input.headers ?? [],
        ...(input.body !== undefined
          ? { body: new TextEncoder().encode(input.body) }
          : {}),
      });
    const decode = (body: Uint8Array) =>
      JSON.parse(new TextDecoder().decode(body));

    // Looking at a preview keeps the workspace.
    await db
      .updateTable("session_workspace_use")
      .set({ used_at: sql<Date>`now() - interval '1 hour'` })
      .where("session_id", "=", sessionId)
      .execute();
    const got = await preview({
      method: "GET",
      path: "/hello?x=1",
      headers: [
        ["Cookie", "session=abc"],
        ["Authorization", "Bearer member-token"],
        ["Connection", "keep-alive, x-drop"],
        ["X-Drop", "gone"],
        ["Host", "work.example.com"],
      ],
    });
    expect(got.status).toBe(200);
    const previewUse = await db
      .selectFrom("session_workspace_use")
      .select(sql<number>`extract(epoch from now() - used_at)`.as("ago"))
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(Number(previewUse.ago)).toBeLessThan(60);
    expect(decode(got.body)).toMatchObject({
      method: "GET",
      url: "/hello?x=1",
      cookie: "session=abc",
      // The person's own credential for this server stays out.
      authorization: null,
      host: `127.0.0.1:${port}`,
    });
    expect(
      got.headers
        .filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => value),
    ).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
    expect(
      got.headers.some(([name]) => name.toLowerCase() === "transfer-encoding"),
    ).toBe(false);

    const posted = await preview({
      method: "POST",
      path: "/submit",
      headers: [["Content-Type", "text/plain"]],
      body: "x".repeat(100_000),
    });
    expect(posted.status).toBe(201);
    expect(decode(posted.body)).toMatchObject({
      method: "POST",
      body: "x".repeat(100_000),
    });

    const redirected = await preview({ method: "GET", path: "/go" });
    expect(redirected.status).toBe(302);
    expect(
      redirected.headers.find(([name]) => name.toLowerCase() === "location"),
    ).toEqual([expect.any(String), "/landing?from=go"]);

    const big = await preview({ method: "GET", path: "/big" });
    expect(big.body.byteLength).toBe(5 * 1024 * 1024);
    expect(big.body.every((byte) => byte === 7)).toBe(true);

    await expect(
      preview({ method: "GET", path: "/huge" }),
    ).rejects.toMatchObject({
      constructor: SessionPreviewError,
      reason: "too_large",
    });
    await expect(
      previews().request({
        identity: alice,
        projectId,
        sessionId,
        port: await freePort(),
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({
      constructor: SessionPreviewError,
      reason: "unreachable",
    });
    await expect(
      previews().request({
        identity: alice,
        projectId,
        sessionId,
        port: 70_000,
        method: "GET",
        path: "/",
        headers: [],
      }),
    ).rejects.toMatchObject({ reason: "invalid" });

    await processes.signalProcess({
      sandboxId: workspace.sandboxId,
      processId: server.processId,
      signal: "SIGKILL",
    });
    await terminals().close({
      identity: alice,
      projectId,
      sessionId,
      terminalId: opened.terminalId,
    });
  }, 180_000);
});
