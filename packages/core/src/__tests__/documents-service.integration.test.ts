import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import {
  CheckoutRemoteBackend,
  FsBackend,
  FsRemoteBackend,
  nativeGit,
  ProjectManager,
  push,
} from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import {
  DocumentBlobUnavailableError,
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentPathError,
  documentAccessAllowed,
  normalizeDocumentPath,
} from "../services/documents-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0055: one path namespace — the program (git, at origin main) and the
 * project store (`store/…`, versioned per write, caller-stamped) — with
 * access by document refs: builders read the program, the store only ever
 * through document refs, root sees all.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_docs_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

describe("document paths (pure)", () => {
  it("normalizes and rejects unsafe paths", () => {
    expect(normalizeDocumentPath(" store/a/b.md ")).toBe("store/a/b.md");
    expect(normalizeDocumentPath("store\\a\\b.md")).toBe("store/a/b.md");
    for (const bad of [
      "",
      "/abs",
      "a//b",
      "a/../b",
      "./a",
      ".git/config",
      "a\0b",
    ]) {
      expect(() => normalizeDocumentPath(bad)).toThrow(DocumentPathError);
    }
  });

  it("access: root all; builders read the program only; store by refs for everyone", () => {
    const p = "p1";
    const admin: Identity = {
      ...root,
      scope: [{ kind: "project", projectId: p }],
    };
    expect(documentAccessAllowed(root, p, "store/x", "write")).toBe(true);
    expect(documentAccessAllowed(admin, p, "docs/a.md", "read")).toBe(true);
    expect(documentAccessAllowed(admin, p, "docs/a.md", "write")).toBe(false);
    expect(
      documentAccessAllowed(admin, p, "store/customers/acme/x", "read"),
    ).toBe(false);
    const adminWithStore: Identity = {
      ...admin,
      scope: [
        ...(admin.scope ?? []),
        { kind: "document", projectId: p, path: "store/**", access: "write" },
      ],
    };
    expect(
      documentAccessAllowed(
        adminWithStore,
        p,
        "store/customers/acme/x",
        "write",
      ),
    ).toBe(true);
    const csm: Identity = {
      ...root,
      scope: [
        { kind: "document", projectId: p, path: "docs/**" },
        {
          kind: "document",
          projectId: p,
          path: "store/customers/acme/**",
          access: "write",
        },
      ],
    };
    expect(documentAccessAllowed(csm, p, "docs/handbook.md", "read")).toBe(
      true,
    );
    expect(documentAccessAllowed(csm, p, "workflows/src/x.ts", "read")).toBe(
      false,
    );
    expect(
      documentAccessAllowed(csm, p, "store/customers/acme/notes.md", "write"),
    ).toBe(true);
    expect(
      documentAccessAllowed(csm, p, "store/customers/globex/notes.md", "read"),
    ).toBe(false);
  });
});

describeIf("DocumentsService (ADR 0055)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectId: string;
  let admin: Identity;
  let csm: Identity;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-docs-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
    core = new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
    });
    const project = await core.projects.create(root, { name: "brain" });
    projectId = project.id;
    admin = {
      ...root,
      externalUserId: "admin",
      scope: [{ kind: "project", projectId }],
    };
    csm = {
      ...root,
      externalUserId: "alice",
      scope: [
        { kind: "document", projectId, path: "docs/**" },
        {
          kind: "document",
          projectId,
          path: "store/customers/acme/**",
          access: "write",
        },
      ],
    };

    // The program: a handbook and a workflow, pushed to origin.
    const repo = await projectManager.openDev(
      root.tenantId,
      projectId,
      root.externalUserId,
    );
    try {
      await repo.writeFile(
        "docs/handbook.md",
        "# Handbook\n\nRefunds take 5 days.\n",
      );
      await repo.writeFile(
        "docs/pricing.md",
        "# Pricing\n\nEnterprise refunds are custom.\n",
      );
      await repo.writeFile(
        "workflows/src/secret.ts",
        "export const key = 'refunds-internal';\n",
      );
      await repo.commit("program", { name: "root", email: "root@example.com" });
      const remote = projectManager.remoteBackend;
      if (!remote) throw new Error("expected remote");
      await push({ dev: repo, remote, tenantId: root.tenantId, projectId });
    } finally {
      await repo.dispose();
    }
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("local documents share the folder with MCP, preserve bytes and require fresh versions", async () => {
    const directory = path.join(tmpDir, "local-documents");
    await fs.mkdir(directory);
    await nativeGit(directory, ["init", "-b", "feature"]);
    const resolver = async () => directory;
    const manager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "unused"), resolver),
      new CheckoutRemoteBackend(
        resolver,
        new FsRemoteBackend(path.join(tmpDir, "unused-origin")),
      ),
      resolver,
    );
    const local = new CatamorphicCore({
      db,
      projectManager: manager,
      environmentProvider: testEnvironmentProvider(),
    });
    const project = await local.projects.create(root, {
      name: "Local",
      rootPath: directory,
      importExisting: true,
    });
    const identity = root;
    const args = { identity, projectId: project.id, path: "store/report.pdf" };
    const bytes = new Uint8Array([0, 255, 128, 37, 80, 68, 70]);
    const first = await local.documents.write({
      ...args,
      content: bytes,
      ifVersion: 0,
    });
    expect(await fs.readFile(path.join(directory, args.path))).toEqual(
      Buffer.from(bytes),
    );
    expect((await local.documents.readBytes(args)).bytes).toEqual(bytes);
    expect((await nativeGit(directory, ["status", "--porcelain"])).trim()).toBe(
      "",
    );
    await fs.writeFile(
      path.join(directory, args.path),
      new Uint8Array([1, 2, 3]),
    );
    await expect(
      local.documents.write({
        ...args,
        content: bytes,
        ifVersion: first.version,
      }),
    ).rejects.toBeInstanceOf(DocumentConflictError);
    expect((await local.documents.readBytes(args)).bytes).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (await local.documents.readBytes({ ...args, version: first.version }))
        .bytes,
    ).toEqual(bytes);
    await fs.writeFile(
      path.join(directory, "store/notes.md"),
      "Private research notes",
    );
    expect(
      (
        await local.documents.search({
          identity,
          projectId: project.id,
          query: "research",
          prefix: "store",
        })
      ).map((entry) => entry.path),
    ).toEqual(["store/notes.md"]);
    await fs.rm(path.join(directory, "store/notes.md"));
    const history = await local.documents.history({
      identity,
      projectId: project.id,
      path: "store/notes.md",
    });
    expect(history[0]).toMatchObject({
      deleted: true,
      writtenBy: "local-filesystem",
    });
    expect(
      await local.documents.search({
        identity,
        projectId: project.id,
        query: "research",
        prefix: "store",
      }),
    ).toEqual([]);
    expect(
      await local.documents.storage({ identity, projectId: project.id }),
    ).toMatchObject({ location: "device", uploadIsExplicit: true });
    const restricted = {
      ...root,
      scope: [{ kind: "project" as const, projectId: project.id }],
    };
    expect(
      await local.documents.list({
        identity: restricted,
        projectId: project.id,
        source: "store",
      }),
    ).toEqual([]);
    await fs.writeFile(path.join(directory, "notes.md"), "committed only here");
    await fs.writeFile(
      path.join(directory, "flow.ts"),
      `
      import { defineWorkflow } from "@catamorphic/workflow";
      export const importedFlow = defineWorkflow(({ defineBoundary }) => ({
        steps: [defineBoundary({ run: () => "published" })],
      }));
    `,
    );
    await nativeGit(directory, ["add", "notes.md", "flow.ts"]);
    await nativeGit(directory, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Local history",
    ]);
    expect(
      (
        await local.documents.read({
          identity,
          projectId: project.id,
          path: "notes.md",
        })
      ).text,
    ).toBe("committed only here");
    await expect(
      local.documents.read({
        identity: restricted,
        projectId: project.id,
        path: "notes.md",
      }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    const workflowMember: Identity = {
      ...root,
      scope: [
        { kind: "workflow", projectId: project.id, name: "importedFlow" },
      ],
    };
    expect(
      await local.workflows.list({
        identity: workflowMember,
        projectId: project.id,
      }),
    ).toEqual([]);
    await nativeGit(directory, [
      "update-ref",
      "refs/catamorphic/published/main",
      "HEAD",
    ]);
    await fs.writeFile(
      path.join(directory, "flow.ts"),
      "private incomplete draft",
    );
    expect(
      (
        await local.workflows.list({
          identity: workflowMember,
          projectId: project.id,
        })
      ).map((w) => w.name),
    ).toEqual(["importedFlow"]);

    await fs.writeFile(
      path.join(directory, "notes.md"),
      "private working edit",
    );
    expect(
      (
        await local.documents.read({
          identity: restricted,
          projectId: project.id,
          path: "notes.md",
        })
      ).text,
    ).toBe("committed only here");
    expect(
      (
        await local.documents.read({
          identity,
          projectId: project.id,
          path: "notes.md",
        })
      ).text,
    ).toBe("private working edit");
    await fs.symlink(tmpDir, path.join(directory, "store/outside"));
    await expect(
      local.documents.write({
        ...args,
        path: "store/outside/escape.txt",
        content: "no",
      }),
    ).rejects.toThrow("symbolic links");
    expect(
      await fs.access(path.join(tmpDir, "escape.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("concurrent first writes use the version precondition", async () => {
    const args = {
      identity: root,
      projectId,
      path: "store/concurrent.md",
      ifVersion: 0,
    };
    const results = await Promise.allSettled([
      core.documents.write({ ...args, content: "one" }),
      core.documents.write({ ...args, content: "two" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(
      DocumentConflictError,
    );
  });

  it("missing external blobs fail explicitly instead of becoming empty files", async () => {
    const blobs = new Map<string, Uint8Array>();
    const manager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "blob-dev")),
      new FsRemoteBackend(path.join(tmpDir, "blob-origin")),
    );
    const withBlobs = new CatamorphicCore({
      db,
      projectManager: manager,
      environmentProvider: testEnvironmentProvider(),
      documentBlobStore: {
        put: async (key, bytes) => {
          blobs.set(key, bytes);
        },
        get: async (key) => {
          const data = blobs.get(key);
          return data ? { data, etag: key } : null;
        },
        deletePrefix: async (prefix) => {
          for (const key of blobs.keys())
            if (key.startsWith(prefix)) blobs.delete(key);
        },
      },
    });
    const args = { identity: root, projectId, path: "store/missing.pdf" };
    await withBlobs.documents.write({
      ...args,
      content: new Uint8Array([0, 255]),
    });
    blobs.clear();
    await expect(withBlobs.documents.readBytes(args)).rejects.toBeInstanceOf(
      DocumentBlobUnavailableError,
    );
  });

  it("builders read the program; viewers only their document refs", async () => {
    const all = await core.documents.list({ identity: admin, projectId });
    // The whole program (seeds included), never the store.
    expect(all.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        "docs/handbook.md",
        "docs/pricing.md",
        "workflows/src/secret.ts",
        ".catamorphic/project.json",
      ]),
    );
    expect(all.every((e) => e.source === "program")).toBe(true);
    const underDocs = await core.documents.list({
      identity: admin,
      projectId,
      prefix: "docs",
    });
    expect(underDocs.map((e) => e.path)).toEqual([
      "docs/handbook.md",
      "docs/pricing.md",
    ]);
    const mine = await core.documents.list({ identity: csm, projectId });
    expect(mine.map((e) => e.path)).toEqual([
      "docs/handbook.md",
      "docs/pricing.md",
    ]);
    const doc = await core.documents.read({
      identity: csm,
      projectId,
      path: "docs/handbook.md",
    });
    expect(doc.source).toBe("program");
    expect(doc.text).toContain("Refunds take 5 days");
    await expect(
      core.documents.read({
        identity: csm,
        projectId,
        path: "workflows/src/secret.ts",
      }),
    ).rejects.toThrow(AccessDeniedError);
    // The program is read-only through this surface, even for builders.
    await expect(
      core.documents.write({
        identity: admin,
        projectId,
        path: "docs/new.md",
        content: "x",
      }),
    ).rejects.toThrow(DocumentPathError);
  });

  it("store writes are versioned, stamped, conflict-checked; the store is ref-gated for builders too", async () => {
    const v1 = await core.documents.write({
      identity: csm,
      projectId,
      path: "store/customers/acme/notes.md",
      content: "# Acme\n\nWants faster refunds.\n",
    });
    expect(v1).toMatchObject({
      version: 1,
      writtenBy: "alice",
      source: "store",
      contentType: "text/markdown",
    });

    // Stale version → conflict, nothing written.
    await expect(
      core.documents.write({
        identity: csm,
        projectId,
        path: "store/customers/acme/notes.md",
        content: "stale",
        ifVersion: 0,
      }),
    ).rejects.toThrow(DocumentConflictError);
    const v2 = await core.documents.write({
      identity: csm,
      projectId,
      path: "store/customers/acme/notes.md",
      content: "# Acme\n\nWants faster refunds. Renewal in Q4.\n",
      ifVersion: 1,
    });
    expect(v2.version).toBe(2);
    const latest = await core.documents.read({
      identity: csm,
      projectId,
      path: "store/customers/acme/notes.md",
    });
    expect(latest.text).toContain("Renewal in Q4");
    const old = await core.documents.read({
      identity: csm,
      projectId,
      path: "store/customers/acme/notes.md",
      version: 1,
    });
    expect(old.text).not.toContain("Renewal");
    expect(
      (
        await core.documents.history({
          identity: csm,
          projectId,
          path: "store/customers/acme/notes.md",
        })
      ).map((v) => v.version),
    ).toEqual([2, 1]);

    // Outside the CSM's customers: denied uniformly.
    await expect(
      core.documents.write({
        identity: csm,
        projectId,
        path: "store/customers/globex/notes.md",
        content: "x",
      }),
    ).rejects.toThrow(AccessDeniedError);
    // The admin (project ref only) cannot see the store at all…
    await expect(
      core.documents.read({
        identity: admin,
        projectId,
        path: "store/customers/acme/notes.md",
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect(
      (
        await core.documents.list({
          identity: admin,
          projectId,
          prefix: "store",
        })
      ).length,
    ).toBe(0);
    // …root can.
    const asRoot = await core.documents.read({
      identity: root,
      projectId,
      path: "store/customers/acme/notes.md",
    });
    expect(asRoot.writtenBy).toBe("alice");
  });

  it("binary content round-trips as bytes; text detection is by type + UTF-8", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await core.documents.write({
      identity: csm,
      projectId,
      path: "store/customers/acme/logo.png",
      content: png,
    });
    const back = await core.documents.readBytes({
      identity: csm,
      projectId,
      path: "store/customers/acme/logo.png",
    });
    expect(Array.from(back.bytes)).toEqual(Array.from(png));
    expect(back.contentType).toBe("image/png");
    const meta = await core.documents.read({
      identity: csm,
      projectId,
      path: "store/customers/acme/logo.png",
    });
    expect(meta.text).toBeUndefined();
  });

  it("delete is a tombstone; history stays; a later write revives", async () => {
    await core.documents.write({
      identity: csm,
      projectId,
      path: "store/customers/acme/tmp.md",
      content: "temp",
    });
    const { version } = await core.documents.delete({
      identity: csm,
      projectId,
      path: "store/customers/acme/tmp.md",
    });
    expect(version).toBe(2);
    await expect(
      core.documents.read({
        identity: csm,
        projectId,
        path: "store/customers/acme/tmp.md",
      }),
    ).rejects.toThrow(DocumentNotFoundError);
    expect(
      (
        await core.documents.list({
          identity: csm,
          projectId,
          prefix: "store/customers/acme",
        })
      ).map((e) => e.path),
    ).not.toContain("store/customers/acme/tmp.md");
    const history = await core.documents.history({
      identity: csm,
      projectId,
      path: "store/customers/acme/tmp.md",
    });
    expect(history[0]).toMatchObject({ version: 2, deleted: true });
    const revived = await core.documents.write({
      identity: csm,
      projectId,
      path: "store/customers/acme/tmp.md",
      content: "back",
    });
    expect(revived.version).toBe(3);
  });

  it("search: grep and full-text over what the caller may read, program and store alike", async () => {
    const grep = await core.documents.search({
      identity: csm,
      projectId,
      query: "refunds",
    });
    expect(grep.map((m) => `${m.source}:${m.path}`).sort()).toEqual([
      "program:docs/handbook.md",
      "program:docs/pricing.md",
      "store:store/customers/acme/notes.md",
    ]);
    // The workflow file mentions refunds too — invisible to the CSM…
    expect(grep.some((m) => m.path.startsWith("workflows/"))).toBe(false);
    // …visible to a builder, whose search never reaches the store.
    const adminGrep = await core.documents.search({
      identity: admin,
      projectId,
      query: "refunds",
    });
    expect(adminGrep.map((m) => m.path)).toContain("workflows/src/secret.ts");
    expect(adminGrep.some((m) => m.source === "store")).toBe(false);
    // Full text: words in any order; lines carry the hits.
    const text = await core.documents.search({
      identity: csm,
      projectId,
      query: "renewal acme",
      mode: "text",
    });
    expect(text.map((m) => m.path)).toEqual(["store/customers/acme/notes.md"]);
    expect(text[0]?.lines.some((l) => l.text.includes("Renewal"))).toBe(true);
    // Prefix narrows.
    const scoped = await core.documents.search({
      identity: csm,
      projectId,
      query: "refunds",
      prefix: "store",
    });
    expect(scoped.map((m) => m.path)).toEqual([
      "store/customers/acme/notes.md",
    ]);
  });
});
