import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import type { AppBundleStore } from "../services/app-bundle-store.js";
import { AppPoliciesService } from "../services/app-policies-service.js";
import { AppPublishStateError, AppsService } from "../services/apps-service.js";
import { DbSandboxStore } from "../services/db-sandbox-store.js";
import { DevSandboxService } from "../services/dev-sandbox-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_apps_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const identity: Identity = { tenantId, externalUserId: "apps-test-user" };

class MemoryBundleStore implements AppBundleStore {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const data = this.objects.get(key);
    return data ? { data, etag: "test" } : null;
  }

  async put(key: string, data: Uint8Array) {
    this.objects.set(key, data);
  }

  async deletePrefix(prefix: string) {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }
}

/**
 * Executes build commands against nothing: `bun install` and `bun run build`
 * succeed and the provider serves a fixed bundle for dist reads. Command and
 * upload traffic is recorded so tests can assert the build shape.
 */
class BuildFakeProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly commands: { command: string; cwd?: string }[] = [];
  readonly uploads: { basePath: string; fileCount: number }[] = [];
  failBuild = false;

  async createSandbox() {
    return {
      id: crypto.randomUUID(),
      providerId: `build-sandbox-${crypto.randomUUID()}`,
      sandboxType: "dev" as const,
      status: "started" as const,
    };
  }

  async startSandbox(): Promise<void> {}
  async stopSandbox(): Promise<void> {}
  async destroySandbox(): Promise<void> {}
  async getSandboxStatus() {
    return "started" as const;
  }

  async executeCommand(
    _sandboxId: string,
    command: string,
    opts?: { cwd?: string },
  ) {
    this.commands.push({ command, cwd: opts?.cwd });
    if (command === "bun run build" && this.failBuild) {
      return { exitCode: 1, result: "error: cannot resolve ./missing" };
    }
    return { exitCode: 0, result: "" };
  }

  async uploadFiles(
    _sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ) {
    this.uploads.push({ basePath, fileCount: Object.keys(files).length });
  }

  async downloadFile(_sandboxId: string, filePath: string) {
    if (filePath.endsWith("dist/app.js")) return "console.log('built app');";
    if (filePath.endsWith("dist/app.css")) return ".app{color:red}";
    throw new Error(`Unexpected download: ${filePath}`);
  }

  async gitClone(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
}

let tempDirectory = "";
let projectManager: ProjectManager;
let apps: AppsService;
let provider: BuildFakeProvider;
let bundles: MemoryBundleStore;
let commitSha = "";

describeIf("AppsService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-apps-"),
    );
    projectManager = new ProjectManager(
      new FsBackend(path.join(tempDirectory, "dev")),
      new FsRemoteBackend(path.join(tempDirectory, "remote")),
    );
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Apps tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Apps project" })
      .execute();
    const repo = await projectManager.create(tenantId, projectId, {
      name: "apps-project",
      externalUserId: identity.externalUserId,
      initialFiles: {
        "workflows/src/orders.ts": [
          "export async function listOrders() {",
          '  "use workflow";',
          "  return [];",
          "}",
          "",
        ].join("\n"),
        "workflows/src/app-api.ts": [
          'import { listOrders } from "./orders.js";',
          "",
          "export const appApi = { listOrders };",
          "",
        ].join("\n"),
        "apps/ops-dashboard/package.json": JSON.stringify({
          name: "ops-dashboard",
          private: true,
        }),
        "apps/ops-dashboard/src/main.tsx": "export {};",
      },
    });
    try {
      commitSha = await repo.resolveRef("HEAD");
    } finally {
      await repo.dispose();
    }
    provider = new BuildFakeProvider();
    bundles = new MemoryBundleStore();
    apps = new AppsService(db, {
      projectManager,
      devSandboxes: new DevSandboxService({
        projectManager,
        provider,
        store: new DbSandboxStore(db),
      }),
      provider,
      bundleStore: bundles,
      policies: new AppPoliciesService(db),
    });
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("derives the app list from the repo, not from a table", async () => {
    const list = await apps.list({ identity, projectId });
    expect(list).toEqual([
      {
        name: "ops-dashboard",
        id: null,
        activeVersionId: null,
        publishedAt: null,
      },
    ]);
  });

  it("builds a preview from the dev tree and stores the bundle", async () => {
    const version = await apps.build({
      identity,
      projectId,
      appName: "ops-dashboard",
      kind: "preview",
    });

    expect(version.status).toBe("ready");
    expect(version.allowedWorkflows).toEqual(["listOrders"]);
    expect(version.kind).toBe("preview");
    expect(version.commitSha).toBeNull();
    expect(version.bundleBytes).toBeGreaterThan(0);

    const bundle = await apps.getBundle({
      identity,
      projectId,
      versionId: version.id,
    });
    expect(bundle.code).toContain("built app");
    expect(bundle.css).toContain(".app");

    const buildCommand = provider.commands.find(
      (entry) => entry.command === "bun run build",
    );
    expect(buildCommand?.cwd).toContain("apps/ops-dashboard");
  });

  it("builds a published version from a pristine commit checkout", async () => {
    const before = provider.uploads.length;
    const version = await apps.build({
      identity,
      projectId,
      appName: "ops-dashboard",
      kind: "published",
      commitSha,
    });

    expect(version.status).toBe("ready");
    expect(version.commitSha).toBe(commitSha);
    // The pinned commit was materialized into a scratch dir, not built in place.
    expect(provider.uploads.length).toBeGreaterThan(before);
    expect(
      provider.uploads.at(-1)?.basePath.includes(`app-builds/${commitSha}`),
    ).toBe(true);
    // Scratch checkout is removed afterwards.
    expect(
      provider.commands.some(
        (entry) =>
          entry.command.startsWith("rm -rf") &&
          entry.command.includes("app-builds"),
      ),
    ).toBe(true);
  });

  it("publish activates exactly one version", async () => {
    const versions = await apps.listVersions({
      identity,
      projectId,
      appName: "ops-dashboard",
    });
    const published = versions.find((entry) => entry.kind === "published");
    if (!published) throw new Error("expected a published build");

    const active = await apps.publish({
      identity,
      projectId,
      versionId: published.id,
    });
    expect(active.isActive).toBe(true);
    expect(active.publishedAt).not.toBeNull();

    const second = await apps.build({
      identity,
      projectId,
      appName: "ops-dashboard",
      kind: "published",
      commitSha,
    });
    const nextActive = await apps.publish({
      identity,
      projectId,
      versionId: second.id,
    });
    expect(nextActive.isActive).toBe(true);

    const after = await apps.listVersions({
      identity,
      projectId,
      appName: "ops-dashboard",
    });
    expect(after.filter((entry) => entry.isActive)).toHaveLength(1);
    expect(after.find((entry) => entry.isActive)?.id).toBe(second.id);
  });

  it("refuses to activate a preview", async () => {
    const preview = await apps.build({
      identity,
      projectId,
      appName: "ops-dashboard",
      kind: "preview",
    });
    await expect(
      apps.publish({ identity, projectId, versionId: preview.id }),
    ).rejects.toThrow(AppPublishStateError);
  });

  it("records a failed build with its output instead of throwing", async () => {
    provider.failBuild = true;
    try {
      const version = await apps.build({
        identity,
        projectId,
        appName: "ops-dashboard",
        kind: "preview",
      });
      expect(version.status).toBe("failed");
      expect(version.error).toContain("cannot resolve");
    } finally {
      provider.failBuild = false;
    }
  });

  it("prunes old preview builds and their bundles", async () => {
    for (let i = 0; i < 4; i += 1) {
      await apps.build({
        identity,
        projectId,
        appName: "ops-dashboard",
        kind: "preview",
      });
    }
    const versions = await apps.listVersions({
      identity,
      projectId,
      appName: "ops-dashboard",
    });
    const previews = versions.filter((entry) => entry.kind === "preview");
    expect(previews.length).toBeLessThanOrEqual(3);
    // Every stored bundle key belongs to a surviving version.
    const survivingIds = new Set(versions.map((entry) => entry.id));
    for (const key of bundles.objects.keys()) {
      const versionId = key.split("/").at(-2);
      expect(survivingIds.has(versionId ?? "")).toBe(true);
    }
  });

  it("scopes everything to the tenant", async () => {
    const stranger: Identity = {
      tenantId: crypto.randomUUID(),
      externalUserId: "intruder",
    };
    await expect(apps.list({ identity: stranger, projectId })).rejects.toThrow(
      /not found/i,
    );
  });
});
