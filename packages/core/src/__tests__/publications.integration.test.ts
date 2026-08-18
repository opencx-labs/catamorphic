import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";

/**
 * ADR 0055 publications: a document bound to an audience; public = an
 * anonymous identity scoped to exactly that document, members = the caller
 * narrowed to it. Builders publish what they read, members what they write.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_pubs_${crypto.randomUUID().replaceAll("-", "")}`;
const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

describeIf("PublicationsService (ADR 0055)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectId: string;
  let admin: Identity;
  let sales: Identity;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-pubs-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
    core = new CatamorphicCore({ db, projectManager });
    projectId = (await core.projects.create(root, { name: "brain" })).id;
    admin = {
      ...root,
      externalUserId: "admin",
      scope: [{ kind: "project", projectId }],
    };
    sales = {
      ...root,
      externalUserId: "sam",
      scope: [
        { kind: "document", projectId, path: "docs/**" },
        {
          kind: "document",
          projectId,
          path: "store/decks/sam/**",
          access: "write",
        },
      ],
    };
    await core.documents.write({
      identity: sales,
      projectId,
      path: "store/decks/sam/acme.md",
      content: "# Acme deck\n",
    });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("members publish their own store documents; not the program, not others' folders", async () => {
    const pub = await core.publications.publish({
      identity: sales,
      projectId,
      path: "store/decks/sam/acme.md",
      audience: "public",
      slug: "acme-deck",
    });
    expect(pub).toMatchObject({
      slug: "acme-deck",
      audience: "public",
      createdBy: "sam",
      revokedAt: null,
    });
    await expect(
      core.publications.publish({
        identity: sales,
        projectId,
        path: "docs/handbook.md",
        audience: "public",
      }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      core.publications.publish({
        identity: sales,
        projectId,
        path: "store/decks/other/x.md",
        audience: "members",
      }),
    ).rejects.toThrow(AccessDeniedError);
    // A builder publishes the program; the store still only through refs.
    const handbook = await core.publications.publish({
      identity: admin,
      projectId,
      path: "docs/handbook.md",
      audience: "members",
    });
    expect(handbook.audience).toBe("members");
    await expect(
      core.publications.publish({
        identity: admin,
        projectId,
        path: "store/decks/sam/acme.md",
        audience: "public",
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("resolves public as an anonymous document-scoped identity, members as the caller narrowed to it", async () => {
    const anon = await core.publications.resolve({
      projectId,
      slug: "acme-deck",
      caller: null,
    });
    expect(anon?.identity).toEqual({
      tenantId: root.tenantId,
      externalUserId: "public:acme-deck",
      scope: [{ kind: "document", projectId, path: "store/decks/sam/acme.md" }],
    });
    // ...and that identity can read exactly that document, nothing else.
    if (!anon) throw new Error("expected");
    const doc = await core.documents.read({
      identity: anon.identity,
      projectId,
      path: anon.path,
    });
    expect(doc.text).toContain("Acme deck");
    await expect(
      core.documents.read({
        identity: anon.identity,
        projectId,
        path: "store/decks/sam/other.md",
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect(
      (await core.documents.list({ identity: anon.identity, projectId })).map(
        (e) => e.path,
      ),
    ).toEqual(["store/decks/sam/acme.md"]);

    const handbook = (
      await core.publications.list({ identity: admin, projectId })
    ).find((p) => p.path === "docs/handbook.md");
    if (!handbook) throw new Error("expected");
    // A member with no docs ref of their own still reads a members publication.
    const csm: Identity = {
      ...root,
      externalUserId: "carol",
      scope: [{ kind: "agent", projectId, name: "csm" }],
    };
    const forCarol = await core.publications.resolve({
      projectId,
      slug: handbook.slug,
      caller: csm,
    });
    expect(forCarol?.identity.scope).toEqual([
      { kind: "document", projectId, path: "docs/handbook.md" },
    ]);
    // Anonymous, or a stranger to the project, gets nothing for members-only.
    expect(
      await core.publications.resolve({
        projectId,
        slug: handbook.slug,
        caller: null,
      }),
    ).toBeNull();
    const stranger: Identity = { ...root, externalUserId: "x", scope: [] };
    expect(
      await core.publications.resolve({
        projectId,
        slug: handbook.slug,
        caller: stranger,
      }),
    ).toBeNull();
  });

  it("listing and revocation: builders all, members their own; revoked resolves to nothing", async () => {
    expect(
      (await core.publications.list({ identity: sales, projectId })).map(
        (p) => p.slug,
      ),
    ).toEqual(["acme-deck"]);
    expect(
      (await core.publications.list({ identity: admin, projectId })).length,
    ).toBe(2);
    const csm: Identity = {
      ...root,
      externalUserId: "carol",
      scope: [{ kind: "agent", projectId, name: "csm" }],
    };
    await expect(
      core.publications.revoke({ identity: csm, projectId, slug: "acme-deck" }),
    ).rejects.toThrow(AccessDeniedError);
    await core.publications.revoke({
      identity: sales,
      projectId,
      slug: "acme-deck",
    });
    expect(
      await core.publications.resolve({
        projectId,
        slug: "acme-deck",
        caller: null,
      }),
    ).toBeNull();
    expect(
      (await core.publications.list({ identity: sales, projectId }))[0]
        ?.revokedAt,
    ).not.toBeNull();
  });
});
