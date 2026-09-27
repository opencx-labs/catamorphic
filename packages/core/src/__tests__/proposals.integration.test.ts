import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import {
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
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { DocumentPathError } from "../services/documents-service.js";
import { proposalBranch } from "../services/proposals-service.js";
import {
  connectForgeService,
  fakeForge,
  gitHttpServer,
} from "./code-host-fixture.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0055: a member proposes a program change; it lands as a branch from
 * the shared main, authored as the member, on the project origin; with the
 * organization's service connection for a code host, as a pull request
 * (ADR 0177).
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_proposals_${crypto.randomUUID().replaceAll("-", "")}`;
const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

describe("proposal branch names (pure)", () => {
  it("are per member, slugged, stamped", () => {
    expect(
      proposalBranch(
        "Fix refund policy!",
        "alice@acme",
        new Date(Date.UTC(2026, 7, 18, 9, 5, 7)),
      ),
    ).toBe("work/proposals/alice-acme/fix-refund-policy-20260818-090507");
  });
});

describeIf("ProposalsService (ADR 0055)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectManager: ProjectManager;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-proposals-"));
    projectManager = new ProjectManager(
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
      await repo.commit("docs", { name: "root", email: "root@example.com" });
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

  it("a member's proposal lands as a branch from main on the origin, authored as them", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      scope: [{ kind: "document", projectId, path: "docs/**" }],
    };
    const result = await core.proposals.propose({
      identity: alice,
      projectId,
      title: "Refunds now take 3 days",
      body: "Support confirmed the new SLA.",
      changes: [
        {
          path: "docs/handbook.md",
          content: "# Handbook\n\nRefunds take 3 days.\n",
        },
        { path: "docs/faq.md", content: "# FAQ\n" },
      ],
    });
    expect(result.branch).toMatch(
      /^work\/proposals\/alice\/refunds-now-take-3-days-/,
    );
    expect(result.pullRequest).toBeUndefined();

    // Read the branch back from the origin through a fresh working copy.
    const reviewer = await projectManager.openDev(
      root.tenantId,
      projectId,
      "reviewer",
    );
    try {
      const remote = projectManager.remoteBackend;
      if (!remote) throw new Error("expected remote");
      const { fetchRemote } = await import("@catamorphic/git");
      await fetchRemote({
        dev: reviewer,
        remote,
        tenantId: root.tenantId,
        projectId,
        remoteBranch: result.branch,
      });
      const files = await reviewer.readFilesAtRef(
        `refs/work/published/${result.branch}`,
        { prefix: "docs/" },
      );
      expect(files["docs/handbook.md"]).toContain("3 days");
      expect(files["docs/faq.md"]).toBe("# FAQ\n");
      // main is untouched.
      await fetchRemote({
        dev: reviewer,
        remote,
        tenantId: root.tenantId,
        projectId,
        remoteBranch: "main",
      });
      const main = await reviewer.readFilesAtRef("refs/work/published/main", {
        prefix: "docs/",
      });
      expect(main["docs/handbook.md"]).toContain("5 days");
      expect(main["docs/faq.md"]).toBeUndefined();
      const log = await reviewer.log({
        ref: `refs/work/published/${result.branch}`,
        maxCount: 1,
      });
      expect(log[0]?.author.name).toBe("alice");
      expect(log[0]?.message).toContain("Proposed by alice via Work");
    } finally {
      await reviewer.dispose();
    }
  });

  it("opens a pull request through the organization's service connection (ADR 0177)", async () => {
    const repositories = path.join(tmpDir, "hosted");
    const bare = path.join(repositories, "hosted.git");
    await fs.mkdir(bare, { recursive: true });
    await nativeGit(bare, ["init", "--bare", "-b", "main"]);
    const server = await gitHttpServer(repositories);
    const remoteUrl = `${server.url}/hosted.git`;
    const forge = fakeForge({ remoteBase: `${server.url}/` });
    const vault = new MemoryCredentialVault();
    const hosted = new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
      credentialVault: vault,
      connectionProviders: [forge.provider],
      codeHosts: [forge.host],
    });
    expect(hosted.proposalsOpenPullRequests).toBe(true);
    await db
      .updateTable("projects")
      .set({ remote_url: remoteUrl, remote_ownership: "attached" })
      .where("id", "=", projectId)
      .execute();
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      scope: [{ kind: "document", projectId, path: "docs/**" }],
    };
    const propose = () =>
      hosted.proposals.propose({
        identity: alice,
        projectId,
        title: "Refunds take 2 days",
        changes: [
          {
            path: "docs/handbook.md",
            content: "# Handbook\n\nRefunds take 2 days.\n",
          },
        ],
      });
    try {
      // A member's own connection does not act for proposals.
      if (!hosted.connections) throw new Error("expected connections");
      await hosted.connections.savePersonal({
        identity: alice,
        providerKind: "forge",
        authorized: { material: new TextEncoder().encode("alice-token") },
      });
      expect((await propose()).pullRequest).toBeUndefined();
      expect(forge.createPullRequest).not.toHaveBeenCalled();

      await connectForgeService({
        connections: hosted.connections,
        admin: root,
        token: "org-token",
      });
      const result = await propose();
      expect(result.pullRequest).toEqual({
        url: "https://forge.test/pr/org-token",
        number: 1,
      });
      expect(forge.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ head: result.branch, base: "main" }),
      );
      expect(forge.gitCalls).toContainEqual({
        token: "org-token",
        access: "write",
        remoteUrl,
      });
      expect(
        await nativeGit(bare, ["show", `${result.branch}:docs/handbook.md`]),
      ).toContain("2 days");
    } finally {
      await server.close();
      await db
        .updateTable("projects")
        .set({ remote_url: null, remote_ownership: null })
        .where("id", "=", projectId)
        .execute();
    }
  });

  it("refuses store paths, empty proposals, and outsiders", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      scope: [{ kind: "document", projectId, path: "docs/**" }],
    };
    await expect(
      core.proposals.propose({
        identity: alice,
        projectId,
        title: "x",
        changes: [{ path: "store/customers/acme/notes.md", content: "no" }],
      }),
    ).rejects.toThrow(DocumentPathError);
    await expect(
      core.proposals.propose({
        identity: alice,
        projectId,
        title: "x",
        changes: [],
      }),
    ).rejects.toThrow(DocumentPathError);
    const stranger: Identity = {
      ...root,
      externalUserId: "mallory",
      scope: [],
    };
    await expect(
      core.proposals.propose({
        identity: stranger,
        projectId,
        title: "x",
        changes: [{ path: "docs/handbook.md", content: "pwned" }],
      }),
    ).rejects.toThrow(AccessDeniedError);
  });
});
