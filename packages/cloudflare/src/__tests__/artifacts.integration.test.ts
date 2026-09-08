/**
 * Integration tests against the real Cloudflare Artifacts API using the
 * credentials in the repo root `.env`:
 *
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ARTIFACTS_NAMESPACE
 *
 * Skipped when the env vars are missing. Also skipped (with a warning) when
 * the account does not have the Artifacts closed beta enabled — the probe
 * request returns error code 10004 ("Access denied by feature gate").
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactsApiError, ArtifactsClient } from "../artifacts-client.js";
import { ArtifactsRemoteBackend } from "../artifacts-remote-backend.js";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE = process.env.CLOUDFLARE_ARTIFACTS_NAMESPACE;
const EXTERNAL_INTEGRATIONS =
  process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";

const FEATURE_GATE_CODE = 10004;

async function artifactsAccessible(): Promise<boolean> {
  if (!EXTERNAL_INTEGRATIONS || !ACCOUNT_ID || !API_TOKEN || !NAMESPACE) {
    return false;
  }
  const client = new ArtifactsClient({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    namespace: NAMESPACE,
  });
  try {
    await client.getRepo("catamorphic-access-probe");
    return true;
  } catch (err) {
    if (
      err instanceof ArtifactsApiError &&
      err.codes.includes(FEATURE_GATE_CODE)
    ) {
      console.warn(
        "[artifacts.integration] Skipping: Cloudflare account does not have " +
          "Artifacts beta access yet (error 10004 'Access denied by feature " +
          "gate'). Request access at https://www.cloudflare.com/products/artifacts/",
      );
      return false;
    }
    // Auth/network problems should fail loudly, not silently skip.
    throw err;
  }
}

const accessible = await artifactsAccessible();
const describeIf = accessible ? describe : describe.skip;

const TENANT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

describeIf("ArtifactsRemoteBackend (integration)", () => {
  const client = new ArtifactsClient({
    accountId: ACCOUNT_ID!,
    apiToken: API_TOKEN!,
    namespace: NAMESPACE!,
  });

  const tmpDirs: string[] = [];
  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  let backend: ArtifactsRemoteBackend;

  afterAll(async () => {
    await backend?.deleteRemote(TENANT, PROJECT).catch(() => {});
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates and detects the Artifacts repo", async () => {
    backend = new ArtifactsRemoteBackend({
      client,
      cachePath: await tmp("artifacts-cache-"),
    });

    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
    await backend.initRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);
    // Idempotent re-init.
    await backend.initRemote(TENANT, PROJECT);
  }, 60_000);

  it("pushes the initial commit through ProjectManager.create", async () => {
    const manager = new ProjectManager(
      new FsBackend(await tmp("artifacts-dev-")),
      backend,
    );
    const repo = await manager.create(TENANT, PROJECT, {
      name: "artifacts-e2e",
      initialFiles: {
        "src/index.ts": 'export const hello = "artifacts";\n',
      },
    });
    const head = await repo.resolveRef("HEAD");
    await repo.dispose();

    const originMain = await backend.withOrigin(TENANT, PROJECT, (origin) =>
      origin.resolveRef("refs/heads/main"),
    );
    expect(originMain).toBe(head);
  }, 120_000);

  it("seeds a second user's working copy from the Artifacts origin", async () => {
    const manager = new ProjectManager(
      new FsBackend(await tmp("artifacts-dev2-")),
      backend,
    );
    const repo = await manager.openDev(TENANT, PROJECT, "user-2");
    const files = await repo.readAllFiles();
    await repo.dispose();

    expect(files["src/index.ts"]).toContain("artifacts");
    expect(files[".catamorphic/project.json"]).toContain("artifacts-e2e");
  }, 120_000);

  it("hands out a clone source usable by a plain git client", async () => {
    const source = await backend.getCloneSource!(TENANT, PROJECT, {
      scope: "read",
    });
    expect(source.url).toMatch(/^https:\/\//);
    expect(source.password).toBeTruthy();

    const git = (await import("isomorphic-git")).default;
    const http = (await import("isomorphic-git/http/node")).default;
    const nodeFs = (await import("node:fs")).default;

    const cloneDir = await tmp("artifacts-clone-");
    await git.clone({
      fs: nodeFs,
      http,
      dir: cloneDir,
      url: source.url,
      ref: "main",
      singleBranch: true,
      onAuth: () => ({
        username: source.username ?? "x",
        password: source.password!,
      }),
    });

    const content = await readFile(
      path.join(cloneDir, "src/index.ts"),
      "utf-8",
    );
    expect(content).toContain("artifacts");
  }, 120_000);

  it("deletes the Artifacts repo", async () => {
    await backend.deleteRemote(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  }, 60_000);
});
