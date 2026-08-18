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
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";

/**
 * ADR 0055: on a hosting backend, an agent's `store/` writes in its working
 * folder are shipped into the store AS THE CALLER after each turn, and the
 * caller's store view is pulled before it. A member's agent can only land
 * what the member may write; the write is stamped with the member.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_storesync_${crypto.randomUUID().replaceAll("-", "")}`;
const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

const unusedSandboxProvider = new Proxy({} as SandboxProvider, {
  get(_t, prop) {
    if (prop === "workspaceRoot") return "/unused";
    return () => {
      throw new Error(`SandboxProvider.${String(prop)} must not be called`);
    };
  },
});

/** A host-execution "agent" whose turn writes files into its folder. */
class WritingProvider implements CodingAgentProvider {
  readonly name = "writer";
  writes: Array<{ path: string; text: string }> = [];
  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }
  async *sendMessage(session: ProviderSession): AsyncIterable<AgentEvent> {
    for (const write of this.writes) {
      const target = path.join(session.workingDirectory, write.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, write.text);
      yield { type: "file_edit", filePath: target };
    }
    yield { type: "text", content: "done" };
    yield { type: "done" };
  }
  async dispose(): Promise<void> {}
}

describeIf("store sync around agent turns (ADR 0055)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectId: string;
  let rootPath: string;
  let provider: WritingProvider;
  let alice: Identity;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-storesync-"));
    // A single-folder host (like the desktop): the project folder is the
    // working directory of host-execution agents.
    rootPath = path.join(tmpDir, "brain");
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects"), async () => rootPath),
    );
    provider = new WritingProvider();
    const agentId = "project:pending:csm"; // patched below once we know the id
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
    const registered = { id: agentId, provider, execution: "host" as const };
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider: unusedSandboxProvider,
      hostProjectPathResolver: () => rootPath,
      codingAgent: {
        defaultAgentId: () => registered.id,
        get: (id) => (id === registered.id ? registered : undefined),
        list: () => [registered],
      },
    });
    const project = await core.projects.create(root, {
      name: "brain",
      rootPath,
    });
    projectId = project.id;
    registered.id = `project:${projectId}:csm`;
    alice = {
      ...root,
      externalUserId: "alice",
      scope: [
        { kind: "agent", projectId, name: "csm" },
        {
          kind: "document",
          projectId,
          path: "store/customers/acme/**",
          access: "write",
        },
      ],
    };
    // Something already in the store Alice may see, and something she may not.
    await core.documents.write({
      identity: root,
      projectId,
      path: "store/customers/acme/plan.md",
      content: "Plan v1\n",
    });
    await core.documents.write({
      identity: root,
      projectId,
      path: "store/customers/globex/secret.md",
      content: "not for alice\n",
    });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("pulls the caller's store view before the turn and ships the agent's store writes as the caller after it", async () => {
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("agent sessions not configured");
    provider.writes = [
      {
        path: "store/customers/acme/notes.md",
        text: "# Acme\nRenewal in Q4.\n",
      },
      { path: "store/customers/globex/notes.md", text: "should not land\n" },
      { path: "docs/handbook.md", text: "program edit, not shipped\n" },
    ];
    const session = await sessions.create(alice, projectId, {
      agentId: `project:${projectId}:csm`,
    });
    const reply = await sessions.sendMessage(
      alice,
      projectId,
      session.id,
      "take notes",
    );
    expect(reply.content).toContain("done");

    // Pulled before the turn: what Alice may read is in the folder, the rest is not.
    expect(
      await fs.readFile(
        path.join(rootPath, "store/customers/acme/plan.md"),
        "utf8",
      ),
    ).toBe("Plan v1\n");
    await expect(
      fs.access(path.join(rootPath, "store/customers/globex/secret.md")),
    ).rejects.toThrow();

    // Shipped after the turn, stamped with Alice.
    const notes = await core.documents.read({
      identity: root,
      projectId,
      path: "store/customers/acme/notes.md",
    });
    expect(notes.text).toContain("Renewal in Q4");
    expect(notes.writtenBy).toBe("alice");
    // Outside her refs: refused, never lands.
    await expect(
      core.documents.read({
        identity: root,
        projectId,
        path: "store/customers/globex/notes.md",
      }),
    ).rejects.toThrow(/not found/);
    // The turn's metadata says what became of each write.
    const detail = await sessions.get(alice, projectId, session.id);
    const last = detail.messages.at(-1);
    const storeSync = (
      last?.metadata as { storeSync?: Record<string, unknown> }
    )?.storeSync;
    expect(storeSync).toMatchObject({
      shipped: ["store/customers/acme/notes.md"],
    });
    // The program edit stays a program edit: in the folder for the
    // checkpoint commit (a program path is never a store row).
    expect(
      await fs.readFile(path.join(rootPath, "docs/handbook.md"), "utf8"),
    ).toContain("program edit");
    expect(
      (
        await core.documents.list({
          identity: root,
          projectId,
          source: "store",
        })
      ).map((e) => e.path),
    ).not.toContain("docs/handbook.md");
    const failed = (storeSync?.failed ?? []) as Array<{ path: string }>;
    expect(failed[0]?.path).toBe("store/customers/globex/notes.md");
  });
});
