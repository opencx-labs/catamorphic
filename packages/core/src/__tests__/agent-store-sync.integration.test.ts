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
      hostAgentCheckout: { resolve: () => rootPath },
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

  it("host-execution turns never sync store/: the shared project folder stays clean", async () => {
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("agent sessions not configured");
    provider.writes = [
      {
        path: "store/customers/acme/notes.md",
        text: "# Acme\nRenewal in Q4.\n",
      },
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
    // Nothing pulled into the shared folder (one folder serves every member)…
    await expect(
      fs.access(path.join(rootPath, "store/customers/acme/plan.md")),
    ).rejects.toThrow();
    // …and the agent's write stayed a file, not a store version.
    await expect(
      core.documents.read({
        identity: root,
        projectId,
        path: "store/customers/acme/notes.md",
      }),
    ).rejects.toThrow(/not found/);
    const detail = await sessions.get(alice, projectId, session.id);
    expect(
      (detail.messages.at(-1)?.metadata as { storeSync?: unknown })?.storeSync,
    ).toBeUndefined();
  });

  it("the caller-bound adapter pulls only what the caller may read and ships as the caller", async () => {
    // What the per-caller dev copy path runs around a sandbox turn, driven
    // directly: same adapter, same engine.
    const { documentsClientFor, shipRemoteProject, syncRemoteProject } =
      await import("../services/store-sync.js");
    const folder = path.join(tmpDir, "alice-copy");
    await fs.mkdir(folder, { recursive: true });
    const client = documentsClientFor(core.documents, alice, projectId, {
      source: "store",
    });
    await syncRemoteProject(folder, client);
    expect(
      await fs.readFile(
        path.join(folder, "store/customers/acme/plan.md"),
        "utf8",
      ),
    ).toBe("Plan v1\n");
    await expect(
      fs.access(path.join(folder, "store/customers/globex/secret.md")),
    ).rejects.toThrow();

    await fs.mkdir(path.join(folder, "store/customers/globex"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(folder, "store/customers/acme/notes.md"),
      "# Acme\nRenewal in Q4.\n",
    );
    await fs.writeFile(
      path.join(folder, "store/customers/globex/notes.md"),
      "should not land\n",
    );
    const report = await shipRemoteProject(folder, client);
    expect(report.shipped).toEqual(["store/customers/acme/notes.md"]);
    expect(report.failed.map((f) => f.path)).toEqual([
      "store/customers/globex/notes.md",
    ]);
    const notes = await core.documents.read({
      identity: root,
      projectId,
      path: "store/customers/acme/notes.md",
    });
    expect(notes.text).toContain("Renewal in Q4");
    expect(notes.writtenBy).toBe("alice");
    await expect(
      core.documents.read({
        identity: root,
        projectId,
        path: "store/customers/globex/notes.md",
      }),
    ).rejects.toThrow(/not found/);
  });
});
