import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, nativeGit, ProjectManager } from "@catamorphic/git";
import type {
  GithubTokenStore,
  StoredGithubConnection,
} from "@catamorphic/github";
import { GithubApiError } from "@catamorphic/github";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import {
  GithubNotConnectedError,
  GithubService,
  ProjectAlreadyLinkedError,
} from "../services/github-service.js";
import type { ProjectsService } from "../services/projects-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "user-1",
};

const APP = { clientId: "Iv1_test" };

class MemoryTokenStore implements GithubTokenStore {
  private readonly map = new Map<string, StoredGithubConnection>();

  async get(tenantId: string, externalUserId: string) {
    return this.map.get(`${tenantId}/${externalUserId}`) ?? null;
  }

  async set(
    tenantId: string,
    externalUserId: string,
    connection: StoredGithubConnection,
  ) {
    this.map.set(`${tenantId}/${externalUserId}`, connection);
  }

  async delete(tenantId: string, externalUserId: string) {
    this.map.delete(`${tenantId}/${externalUserId}`);
  }
}

/** Fake GitHub: OAuth token host + REST API in one fetch. */
function fakeGithub(state: { refreshed?: boolean } = {}) {
  return (async (url: unknown) => {
    const u = new URL(String(url));
    if (u.pathname === "/login/oauth/access_token") {
      state.refreshed = true;
      return Response.json({
        access_token: "ghu_refreshed",
        expires_in: 28800,
        refresh_token: "ghr_next",
      });
    }
    if (u.pathname === "/user") {
      return Response.json({
        login: "octo",
        id: 7,
        avatar_url: "a",
        name: "Octo",
      });
    }
    if (u.pathname === "/user/repos") {
      return Response.json([
        {
          id: 42,
          full_name: "octo/hello",
          name: "hello",
          owner: { login: "octo" },
          private: true,
          default_branch: "master",
          clone_url: "https://github.com/octo/hello.git",
          description: null,
          pushed_at: "2026-07-01T00:00:00Z",
        },
      ]);
    }
    if (u.pathname === "/repos/octo/hello") {
      return Response.json({
        id: 42,
        full_name: "octo/hello",
        name: "hello",
        owner: { login: "octo" },
        private: true,
        default_branch: "master",
        clone_url: "https://github.com/octo/hello.git",
        description: null,
        pushed_at: null,
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

function fakeProject(over?: { id?: string; name?: string }) {
  return {
    id: over?.id ?? crypto.randomUUID(),
    tenantId: identity.tenantId,
    name: over?.name ?? "hello",
    storageType: "managed" as const,
    remoteUrl: null,
    remoteOwnership: null,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function service(over?: {
  fetch?: typeof fetch;
  store?: GithubTokenStore;
  projects?: Partial<ProjectsService>;
  projectManager?: ProjectManager;
}) {
  const projects = {
    create: vi.fn(async () => fakeProject()),
    ...over?.projects,
  } as unknown as ProjectsService;
  const projectManager = over?.projectManager ?? ({} as ProjectManager);
  return new GithubService(db, projectManager, projects, {
    app: APP,
    tokenStore: over?.store ?? new MemoryTokenStore(),
    fetch: over?.fetch ?? fakeGithub(),
  });
}

const FRESH_TOKENS = {
  accessToken: "ghu_tok",
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
};

beforeAll(async () => {
  await migrateToLatest({ db });
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "gh-test" })
    .execute();
}, 30_000);

afterAll(async () => {
  await db.destroy();
});

describe("GithubService", () => {
  it("reports disconnected before connect and errors on token use", async () => {
    const svc = service();
    expect(await svc.status(identity)).toEqual({ connected: false });
    await expect(svc.listRepos(identity)).rejects.toThrow(
      GithubNotConnectedError,
    );
  });

  it("connect writes to the store and status reflects it", async () => {
    const store = new MemoryTokenStore();
    const svc = service({ store });
    const status = await svc.connect(identity, FRESH_TOKENS);
    expect(status).toEqual({ connected: true, login: "octo" });
    expect(await svc.status(identity)).toEqual({
      connected: true,
      login: "octo",
    });
    const stored = await store.get(identity.tenantId, identity.externalUserId);
    expect(stored?.githubLogin).toBe("octo");
    expect(stored?.githubUserId).toBe(7);
  });

  it("lists repos with the stored token", async () => {
    const svc = service();
    await svc.connect(identity, FRESH_TOKENS);
    const repos = await svc.listRepos(identity);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.fullName).toBe("octo/hello");
  });

  it("validates an exact repository before storing supplied credentials", async () => {
    const store = new MemoryTokenStore();
    const svc = service({ store });

    const result = await svc.connectForRepository(
      identity,
      FRESH_TOKENS,
      "octo/hello",
    );

    expect(result.repository.fullName).toBe("octo/hello");
    expect(result.connection).toEqual({ connected: true, login: "octo" });
    expect(await svc.repository(identity, "octo/hello")).toMatchObject({
      defaultBranch: "master",
    });
  });

  it("does not store supplied credentials that cannot access the repository", async () => {
    const store = new MemoryTokenStore();
    const svc = service({ store });

    await expect(
      svc.connectForRepository(identity, FRESH_TOKENS, "octo/missing"),
    ).rejects.toThrow(GithubApiError);
    expect(await svc.status(identity)).toEqual({ connected: false });
  });

  it("refreshes a stale token and persists the new set to the store", async () => {
    const state = { refreshed: false };
    const store = new MemoryTokenStore();
    const svc = service({ fetch: fakeGithub(state), store });
    await svc.connect(identity, {
      accessToken: "ghu_stale",
      expiresAt: Date.now() - 1000,
      refreshToken: "ghr_old",
      refreshTokenExpiresAt: Date.now() + 86_400_000,
    });
    // connect() itself doesn't refresh; the first token use does.
    state.refreshed = false;
    await svc.listRepos(identity);
    expect(state.refreshed).toBe(true);

    const stored = await store.get(identity.tenantId, identity.externalUserId);
    expect(stored?.tokens.accessToken).toBe("ghu_refreshed");
    expect(stored?.tokens.refreshToken).toBe("ghr_next");
    // Identity fields survive the refresh rewrite.
    expect(stored?.githubLogin).toBe("octo");
  });

  it("importRepo passes cloneFrom with token credentials and records the remote", async () => {
    const created = fakeProject();
    await db
      .insertInto("projects")
      .values({ id: created.id, tenant_id: identity.tenantId, name: "hello" })
      .execute();
    const create = vi.fn(async () => created);
    const svc = service({ projects: { create } as Partial<ProjectsService> });
    await svc.connect(identity, FRESH_TOKENS);

    const project = await svc.importRepo(identity, { fullName: "octo/hello" });

    expect(create).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        name: "hello",
        cloneFrom: expect.objectContaining({
          url: "https://github.com/octo/hello.git",
          branch: "master",
          credentials: { username: "x-access-token", password: "ghu_tok" },
        }),
      }),
    );
    expect(project.remoteUrl).toBe("https://github.com/octo/hello.git");

    const row = await db
      .selectFrom("projects")
      .where("id", "=", created.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.remote_url).toBe("https://github.com/octo/hello.git");
    expect(row.remote_branch).toBe("master");
    // An imported repository existed before Work: attached (ADR 0170).
    expect(row.remote_ownership).toBe("attached");
    expect(project.remoteOwnership).toBe("attached");
  });

  it("publishProject refuses a project already linked to a repository", async () => {
    const id = crypto.randomUUID();
    await db
      .insertInto("projects")
      .values({
        id,
        tenant_id: identity.tenantId,
        name: "linked",
        remote_url: "https://github.com/octo/hello.git",
        remote_ownership: "attached",
      })
      .execute();
    const svc = service();
    await svc.connect(identity, FRESH_TOKENS);
    await expect(
      svc.publishProject(identity, id, { name: "hello-again" }),
    ).rejects.toThrow(ProjectAlreadyLinkedError);
  });

  it("publishProject creates a repository, links it as owned, and pushes the project", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gh-publish-"));
    try {
      const root = path.join(temp, "root");
      const bare = path.join(temp, "published.git");
      await fs.mkdir(root);
      await fs.mkdir(bare);
      await nativeGit(bare, ["init", "--bare", "-b", "main"]);
      await nativeGit(root, ["init", "-b", "main"]);
      await fs.writeFile(path.join(root, "notes.md"), "# Notes\n");
      await nativeGit(root, ["add", "."]);
      await nativeGit(root, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "notes",
      ]);
      const id = crypto.randomUUID();
      await db
        .insertInto("projects")
        .values({ id, tenant_id: identity.tenantId, name: "notes" })
        .execute();
      const created: Array<{ path: string; body: unknown }> = [];
      const github = fakeGithub();
      const svc = service({
        projectManager: new ProjectManager(
          new FsBackend(path.join(temp, "internal"), async () => root),
          undefined,
          async () => root,
        ),
        fetch: (async (url: unknown, init?: RequestInit) => {
          const u = new URL(String(url));
          if (init?.method === "POST" && u.pathname === "/orgs/acme/repos") {
            created.push({
              path: u.pathname,
              body: JSON.parse(String(init.body)),
            });
            return Response.json({
              id: 43,
              full_name: "acme/notes",
              name: "notes",
              owner: { login: "acme" },
              private: true,
              default_branch: "main",
              clone_url: bare,
              description: null,
              pushed_at: null,
            });
          }
          return github(String(url), init);
        }) as typeof fetch,
      });
      await svc.connect(identity, FRESH_TOKENS);

      const published = await svc.publishProject(identity, id, {
        name: "notes",
        organization: "acme",
      });

      expect(published).toEqual({ fullName: "acme/notes", remoteUrl: bare });
      expect(created).toEqual([
        {
          path: "/orgs/acme/repos",
          body: { name: "notes", private: true, auto_init: false },
        },
      ]);
      const row = await db
        .selectFrom("projects")
        .where("id", "=", id)
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        remote_url: bare,
        remote_branch: "main",
        remote_ownership: "owned",
      });
      expect(await nativeGit(bare, ["show", "main:notes.md"])).toBe(
        "# Notes\n",
      );
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("disconnect removes the connection from the store", async () => {
    const svc = service();
    await svc.connect(identity, FRESH_TOKENS);
    await svc.disconnect(identity);
    expect(await svc.status(identity)).toEqual({ connected: false });
  });
});
