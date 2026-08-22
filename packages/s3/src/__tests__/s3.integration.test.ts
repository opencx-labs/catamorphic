/**
 * Integration tests against a real S3-compatible bucket (Cloudflare R2, AWS
 * S3, MinIO) using credentials from the repo root `.env`:
 *
 *   S3_ENDPOINT           e.g. https://<accountId>.r2.cloudflarestorage.com
 *   S3_BUCKET
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_REGION             optional, defaults to "auto" (R2)
 *   S3_FORCE_PATH_STYLE   optional, set to "true" for MinIO
 *
 * Skipped when the env vars are missing. All keys are written under a
 * throwaway per-run prefix and deleted afterwards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsBackend, ProjectManager, push } from "@catamorphic/git";
import { afterAll, describe, expect, it } from "vitest";
import { PreconditionFailedError } from "../object-store.js";
import { S3ObjectStore } from "../s3-object-store.js";
import { S3RemoteBackend } from "../s3-remote-backend.js";

const BUCKET = process.env.S3_BUCKET ?? "";
const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "";

const configured = !!(BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY);

async function s3Accessible(): Promise<boolean> {
  if (!configured) return false;
  const probe = new S3ObjectStore({
    bucket: BUCKET,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
  try {
    await probe.get(`catamorphic-test/access-probe-${crypto.randomUUID()}`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "NotEntitled") {
      console.warn(
        "[s3.integration] Skipping: this Cloudflare account does not have R2 enabled.",
      );
      return false;
    }
    throw error;
  }
}

const accessible = await s3Accessible();
const describeIf = accessible ? describe : describe.skip;

const TENANT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const KEY_PREFIX = `catamorphic-test/${crypto.randomUUID()}/`;
const AUTHOR = { name: "Alice", email: "alice@test.dev" };

describeIf("S3RemoteBackend (integration)", () => {
  const store = new S3ObjectStore({
    bucket: BUCKET,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
  const backend = new S3RemoteBackend({ store, keyPrefix: KEY_PREFIX });

  const tmpDirs: string[] = [];
  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterAll(async () => {
    await store.deletePrefix(KEY_PREFIX).catch(() => {});
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("conditional writes behave as compare-and-swap", async () => {
    const key = `${KEY_PREFIX}cas-probe`;
    const body = (text: string) => new TextEncoder().encode(text);

    await store.put(key, body("v1"), { ifNoneMatch: "*" });
    await expect(
      store.put(key, body("v2"), { ifNoneMatch: "*" }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    const current = await store.get(key);
    expect(current).not.toBeNull();
    await store.put(key, body("v2"), { ifMatch: current?.etag });
    await expect(
      store.put(key, body("v3"), { ifMatch: current?.etag }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  }, 60_000);

  it("creates the remote and pushes the initial commit", async () => {
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
    await backend.initRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);

    const manager = new ProjectManager(
      new FsBackend(await tmp("s3-dev-")),
      backend,
    );
    const repo = await manager.create(TENANT, PROJECT, {
      name: "s3-e2e",
      initialFiles: { "src/index.ts": 'export const hello = "s3";\n' },
    });
    const head = await repo.resolveRef("HEAD");
    await repo.dispose();

    const originMain = await backend.withOrigin(TENANT, PROJECT, (origin) =>
      origin.resolveRef("refs/heads/main"),
    );
    expect(originMain).toBe(head);
  }, 120_000);

  it("round-trips a push and seeds a second user's working copy", async () => {
    const managerA = new ProjectManager(
      new FsBackend(await tmp("s3-devA-")),
      backend,
    );
    const repoA = await managerA.openDev(TENANT, PROJECT, "user-a");
    await repoA.writeFile("src/feature.ts", "export const feature = 42;\n");
    await repoA.commit("add feature", AUTHOR);
    await push({
      dev: repoA,
      remote: backend,
      tenantId: TENANT,
      projectId: PROJECT,
    });
    await repoA.dispose();

    const managerB = new ProjectManager(
      new FsBackend(await tmp("s3-devB-")),
      backend,
    );
    const repoB = await managerB.openDev(TENANT, PROJECT, "user-b");
    const files = await repoB.readAllFiles();
    await repoB.dispose();

    expect(files["src/feature.ts"]).toContain("feature = 42");
    expect(files["src/index.ts"]).toContain('"s3"');

    const log = await backend.withOrigin(TENANT, PROJECT, (origin) =>
      origin.log("refs/heads/main"),
    );
    expect(log.map((c) => c.message.trim())).toContain("add feature");
  }, 120_000);

  it("deletes the remote", async () => {
    await backend.deleteRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  }, 60_000);
});
