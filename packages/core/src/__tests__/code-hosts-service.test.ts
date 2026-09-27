import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, nativeGit, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  CodeHostNotConnectedError,
  ProjectAlreadyLinkedError,
} from "../services/code-hosts-service.js";
import { fakeCodeHost } from "./code-host-fixture.js";

/** ADR 0177: every code-host operation acts through one connection. */
const database = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite: database }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const admin: Identity = { tenantId, externalUserId: "admin" };
const alice: Identity = { tenantId, externalUserId: "alice" };
const bob: Identity = { tenantId, externalUserId: "bob" };
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
let temp: string;
let manager: ProjectManager;
const checkout = (projectId: string) => path.join(temp, "checkouts", projectId);

async function bareRepository(name: string, files: Record<string, string>) {
  const bare = path.join(temp, "remotes", `${name}.git`);
  const seed = path.join(temp, "seeds", name);
  await fs.mkdir(bare, { recursive: true });
  await fs.mkdir(seed, { recursive: true });
  await nativeGit(bare, ["init", "--bare", "-b", "trunk"]);
  if (Object.keys(files).length === 0) return bare;
  await nativeGit(seed, ["init", "-b", "trunk"]);
  for (const [file, content] of Object.entries(files))
    await fs.writeFile(path.join(seed, file), content);
  await nativeGit(seed, ["add", "."]);
  await nativeGit(seed, [...author, "commit", "-m", "seed"]);
  await nativeGit(seed, ["push", bare, "trunk"]);
  return bare;
}

async function linkedProject(remoteUrl: string) {
  const id = crypto.randomUUID();
  await db
    .insertInto("projects")
    .values({
      id,
      tenant_id: tenantId,
      name: id,
      remote_url: remoteUrl,
      remote_ownership: "attached",
      remote_branch: "trunk",
      default_branch: "trunk",
    })
    .execute();
  return id;
}

beforeAll(async () => {
  await migrateToLatest({ db });
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "code-hosts-"));
  await db.insertInto("tenants").values({ id: tenantId, name: "t" }).execute();
  const resolve = async (_tenant: string, projectId: string) => {
    const dir = checkout(projectId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };
  manager = new ProjectManager(
    new FsBackend(path.join(temp, "internal"), resolve),
    undefined,
    resolve,
  );
}, 30_000);

afterAll(async () => {
  await db.destroy();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

describe("CodeHostsService", () => {
  it("acts as the caller's own connection, else the organization's service connection", async () => {
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: temp,
    });
    const remoteUrl = path.join(temp, "remotes", "shared.git");
    const projectId = await linkedProject(remoteUrl);
    const credentials = (
      identity: Identity,
      principal?: "member" | "service",
    ) =>
      forge.codeHosts.gitCredentials({
        identity,
        projectId,
        remoteUrl,
        access: "read",
        ...(principal ? { principal } : {}),
      });

    expect(await credentials(alice)).toBeUndefined();
    await forge.connectService(admin, "org-token");
    expect((await credentials(alice))?.password).toBe("org-token");

    await forge.connectPersonal(alice, "alice-token");
    expect((await credentials(alice))?.password).toBe("alice-token");
    expect((await credentials(alice, "service"))?.password).toBe("org-token");
    expect(await credentials(bob, "member")).toBeUndefined();
    expect((await credentials(bob))?.password).toBe("org-token");

    // A project's own service connection of that name wins over the tenant's.
    await forge.connectService(admin, "project-token", projectId);
    expect((await credentials(bob))?.password).toBe("project-token");

    // Remotes no provider serves get no credentials at all.
    expect(
      await forge.codeHosts.gitCredentials({
        identity: alice,
        projectId,
        remoteUrl: "https://elsewhere.test/repo.git",
        access: "read",
      }),
    ).toBeUndefined();
  });

  it("refreshes a lapsed personal token before acting", async () => {
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: temp,
    });
    const frank: Identity = { tenantId, externalUserId: "frank" };
    forge.provider.refresh = async () => ({
      material: new TextEncoder().encode("frank-fresh"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await forge.connections.savePersonal({
      identity: frank,
      providerKind: "forge",
      authorized: {
        material: new TextEncoder().encode("frank-stale"),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const remoteUrl = path.join(temp, "remotes", "shared.git");
    const projectId = await linkedProject(remoteUrl);
    expect(
      (
        await forge.codeHosts.gitCredentials({
          identity: frank,
          projectId,
          remoteUrl,
          access: "read",
          principal: "member",
        })
      )?.password,
    ).toBe("frank-fresh");
  });

  it("personal authorization runs the provider's challenge and re-authorizing rotates it", async () => {
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: temp,
    });
    const carol: Identity = { tenantId, externalUserId: "carol" };
    const authorize = async (token: string) => {
      const started = await forge.connections.beginPersonalAuthorization({
        identity: carol,
        providerKind: "forge",
        redirectUri: "https://work.test/callback",
      });
      expect(started.challenge.kind).toBe("form");
      return forge.connections.completeAuthorization({
        identity: carol,
        state: started.authorizationId,
        callback: { token },
      });
    };
    const first = await authorize("carol-1");
    expect(first).toMatchObject({
      principalKind: "member",
      projectId: null,
      ownerExternalUserId: "carol",
      account: { login: "carol-1" },
    });
    const second = await authorize("carol-2");
    expect(second.id).toBe(first.id);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(
      await forge.codeHosts.personalConnection({
        identity: carol,
        provider: "forge",
      }),
    ).toMatchObject({ id: first.id, account: { login: "carol-2" } });
  });

  it("imports a repository as an attached project through the caller's connection", async () => {
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: temp,
    });
    const dave: Identity = { tenantId, externalUserId: "dave" };
    const bare = await bareRepository("imported", { "README.md": "hello" });
    forge.host.repository = async ({ fullName }) => ({
      fullName,
      name: "imported",
      owner: "acme",
      private: true,
      defaultBranch: "trunk",
      cloneUrl: bare,
      description: null,
      pushedAt: null,
    });
    await expect(
      forge.codeHosts.importRepository({
        identity: dave,
        provider: "forge",
        fullName: "acme/imported",
      }),
    ).rejects.toThrow(CodeHostNotConnectedError);
    await forge.connectPersonal(dave, "dave-token");
    const project = await forge.codeHosts.importRepository({
      identity: dave,
      provider: "forge",
      fullName: "acme/imported",
    });
    expect(project).toMatchObject({
      name: "imported",
      remoteUrl: bare,
      remoteOwnership: "attached",
      defaultBranch: "trunk",
    });
    expect(forge.gitCalls).toContainEqual({
      token: "dave-token",
      access: "read",
      remoteUrl: bare,
    });
    expect(
      await fs.readFile(path.join(checkout(project.id), "README.md"), "utf8"),
    ).toBe("hello");
  });

  it("publishes an unlinked project to a new repository it owns, once", async () => {
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: temp,
    });
    const erin: Identity = { tenantId, externalUserId: "erin" };
    await forge.connectPersonal(erin, "erin-token");
    const bare = await bareRepository("published", {});
    forge.host.createRepository = async ({ name }) => ({
      fullName: `erin/${name}`,
      name,
      owner: "erin",
      private: true,
      defaultBranch: "trunk",
      cloneUrl: bare,
      description: null,
      pushedAt: null,
    });
    const created = await db
      .insertInto("projects")
      .values({ id: crypto.randomUUID(), tenant_id: tenantId, name: "notes" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const dir = checkout(created.id);
    await fs.mkdir(dir, { recursive: true });
    await nativeGit(dir, ["init", "-b", "main"]);
    await fs.writeFile(path.join(dir, "notes.md"), "mine");
    await nativeGit(dir, ["add", "."]);
    await nativeGit(dir, [...author, "commit", "-m", "notes"]);

    const published = await forge.codeHosts.publishProject({
      identity: erin,
      projectId: created.id,
      provider: "forge",
      name: "notes",
    });
    expect(published).toEqual({ fullName: "erin/notes", remoteUrl: bare });
    expect(
      await db
        .selectFrom("projects")
        .select(["remote_url", "remote_ownership"])
        .where("id", "=", created.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ remote_url: bare, remote_ownership: "owned" });
    expect((await nativeGit(bare, ["show", "trunk:notes.md"])).trim()).toBe(
      "mine",
    );
    expect(forge.gitCalls).toContainEqual({
      token: "erin-token",
      access: "write",
      remoteUrl: bare,
    });
    await expect(
      forge.codeHosts.publishProject({
        identity: erin,
        projectId: created.id,
        provider: "forge",
        name: "notes",
      }),
    ).rejects.toThrow(ProjectAlreadyLinkedError);
  });

  it("links one repository when publishes race, here or on another replica", async () => {
    const frank: Identity = { tenantId, externalUserId: "frank" };
    const replica = async (name: string) => {
      const forge = fakeCodeHost({ db, projectManager: manager, remoteBase: temp });
      await forge.connectPersonal(frank, "frank-token");
      const bare = await bareRepository(name, {});
      const created: string[] = [];
      forge.host.createRepository = async ({ name: repo }) => {
        created.push(repo);
        return {
          fullName: `frank/${repo}`,
          name: repo,
          owner: "frank",
          private: true,
          defaultBranch: "main",
          cloneUrl: bare,
          description: null,
          pushedAt: null,
        };
      };
      return { forge, bare, created };
    };
    const project = await db
      .insertInto("projects")
      .values({ id: crypto.randomUUID(), tenant_id: tenantId, name: "race" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const dir = checkout(project.id);
    await fs.mkdir(dir, { recursive: true });
    await nativeGit(dir, ["init", "-b", "main"]);
    await fs.writeFile(path.join(dir, "race.md"), "race");
    await nativeGit(dir, ["add", "."]);
    await nativeGit(dir, [...author, "commit", "-m", "race"]);
    const publish = (forge: Awaited<ReturnType<typeof replica>>["forge"]) =>
      forge.codeHosts.publishProject({
        identity: frank,
        projectId: project.id,
        provider: "forge",
        name: "race",
      });

    // A double submit on one replica creates one repository.
    const here = await replica("race-here");
    const [first, second] = await Promise.allSettled([
      publish(here.forge),
      publish(here.forge),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.any(ProjectAlreadyLinkedError),
    });
    expect(here.created).toEqual(["race"]);

    // Another replica that got as far as creating one never relinks.
    await db
      .updateTable("projects")
      .set({ remote_url: null, remote_ownership: null })
      .where("id", "=", project.id)
      .execute();
    const there = await replica("race-there");
    const racing = await replica("race-racing");
    const original = racing.forge.host.createRepository;
    racing.forge.host.createRepository = async (input) => {
      // The other replica links while this one creates its repository.
      await there.forge.connectPersonal(frank, "frank-token");
      await publish(there.forge);
      if (!original) throw new Error("No repository creation");
      return original(input);
    };
    await expect(publish(racing.forge)).rejects.toThrow(
      ProjectAlreadyLinkedError,
    );
    expect(
      await db
        .selectFrom("projects")
        .select("remote_url")
        .where("id", "=", project.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ remote_url: there.bare });
  });
});
