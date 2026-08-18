import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  APP_SOURCE_ROOT,
  type AppApiSurface,
  parseProject,
  SANDBOX_STRIPPED_PACKAGES,
} from "@catamorphic/parser";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  APP_PACKAGE_NAME,
  loadAppPackagePayload,
  removePackageDependencies,
  uploadPluginPayloads,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import { type Identity, identityCovers } from "../identity.js";
import {
  type AppBundleStore,
  appBundleKey,
  appVersionPrefix,
} from "./app-bundle-store.js";
import {
  AppLimitExceededError,
  type AppPoliciesService,
  AppsDisabledError,
} from "./app-policies-service.js";
import { assertBuilder } from "./artifact-scope.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import { ProjectNotFoundError } from "./projects-service.js";

const tracer = getTracer("@catamorphic/core");

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Hex object name only. The sha lands in shell commands and scratch-directory
 * paths inside the caller's sandbox, so a malformed value (e.g. `../project`)
 * must be rejected before it can traverse out of the build root.
 */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const DEFAULT_MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
/** Preview builds kept per app; older ones are pruned with their bundles. */
const PREVIEW_VERSIONS_KEPT = 3;
const INSTALL_TIMEOUT_SECONDS = 300;
const BUILD_TIMEOUT_SECONDS = 300;

export type AppVersionKind = "preview" | "published";
export type AppVersionStatus = "building" | "ready" | "failed";

export interface AppSummary {
  /** Directory name under apps/ — the identity of the app in code. */
  name: string;
  /** Null until the app has been built at least once. */
  id: string | null;
  activeVersionId: string | null;
  publishedAt: string | null;
}

export interface AppVersion {
  id: string;
  appId: string;
  appName: string;
  kind: AppVersionKind;
  status: AppVersionStatus;
  commitSha: string | null;
  bundleBytes: number | null;
  /** Workflow names this version may invoke; null until the build succeeds. */
  allowedWorkflows: string[] | null;
  error: string | null;
  isActive: boolean;
  createdAt: string;
  readyAt: string | null;
  publishedAt: string | null;
}

export interface AppBundle {
  code: string;
  css: string;
  /**
   * Cache validator for the version's bundle bytes. Versions are append-only
   * and never rebuilt in place, so a matching etag is always safe to serve
   * from cache.
   */
  etag: string;
}

export class AppNotFoundError extends Error {
  constructor(readonly appName: string) {
    super(`App '${appName}' not found in this project`);
    this.name = "AppNotFoundError";
  }
}

export class AppVersionNotFoundError extends Error {
  constructor(readonly versionId: string) {
    super(`App version '${versionId}' not found`);
    this.name = "AppVersionNotFoundError";
  }
}

export class AppBuildFailedError extends Error {
  constructor(readonly output: string) {
    super(`App build failed:\n${output}`);
    this.name = "AppBuildFailedError";
  }
}

export class AppBundleTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`App bundle is ${bytes} bytes; the limit is ${limit}`);
    this.name = "AppBundleTooLargeError";
  }
}

export class AppContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppContractError";
  }
}

export class AppPublishStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPublishStateError";
  }
}

/**
 * Builds, publishes, and serves user-built frontend apps.
 *
 * Which apps exist is derived from the project repo (`apps/<name>/package.json`)
 * — code is the source of truth, and the `apps` table is only an anchor for
 * built artifacts and publish state, created lazily on first build.
 *
 * Builds run in the caller's dev sandbox: previews build the user's mutable
 * dev tree in place, published versions build a pristine checkout of a pinned
 * commit under a scratch directory. No new sandbox type is required.
 */
export class AppsService {
  /**
   * Serializes compiles that share a build root. Preview builds mutate the
   * caller's dev tree in place (strip manifests → install → restore), so two
   * interleaved previews could install against restored manifests or restore
   * a stripped manifest as the "original". Published builds get their own
   * per-version scratch root and never contend.
   */
  private readonly buildLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      projectManager: ProjectManager;
      devSandboxes: DevSandboxService;
      provider: SandboxProvider;
      bundleStore: AppBundleStore;
      policies: AppPoliciesService;
      maxBundleBytes?: number;
    },
  ) {}

  private withBuildLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.buildLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.buildLocks.set(key, settled);
    void settled.then(() => {
      if (this.buildLocks.get(key) === settled) this.buildLocks.delete(key);
    });
    return run;
  }

  /** Apps present in the repo, merged with build/publish state. */
  async list(args: {
    identity: Identity;
    projectId: string;
  }): Promise<AppSummary[]> {
    await this.requireProject(args.identity, args.projectId);
    const names = await this.appNamesFromRepo(args);
    if (names.length === 0) return [];

    const rows = await this.db
      .selectFrom("apps")
      .leftJoin("app_versions", (join) =>
        join
          .onRef("app_versions.app_id", "=", "apps.id")
          .on("app_versions.is_active", "=", true),
      )
      .where("apps.project_id", "=", args.projectId)
      .select([
        "apps.id",
        "apps.name",
        "app_versions.id as active_version_id",
        "app_versions.published_at",
      ])
      .execute();
    const byName = new Map(rows.map((row) => [row.name, row]));

    return names.map((name) => {
      const row = byName.get(name);
      return {
        name,
        id: row?.id ?? null,
        activeVersionId: row?.active_version_id ?? null,
        publishedAt: row?.published_at?.toISOString() ?? null,
      };
    });
  }

  /**
   * Builds the app and records a version. Preview builds compile whatever is
   * in the caller's dev tree; published builds compile a pinned commit in a
   * clean scratch checkout so the artifact is exactly reproducible from git.
   */
  async build(args: {
    identity: Identity;
    projectId: string;
    appName: string;
    kind: AppVersionKind;
    /** Required for published builds; ignored for previews. */
    commitSha?: string;
  }): Promise<AppVersion> {
    return withSpan(
      {
        tracer,
        name: "app.build",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.project.id": args.projectId,
          "catamorphic.app.name": args.appName,
          "catamorphic.app.build_kind": args.kind,
        },
      },
      async (span) => {
        await this.requireProject(args.identity, args.projectId);
        assertAppName(args.appName);
        const policy = await this.deps.policies.get(args.identity.tenantId);
        if (!policy.appsEnabled) {
          throw new AppsDisabledError(args.identity.tenantId);
        }
        if (policy.maxAppsPerProject) {
          const names = await this.appNamesFromRepo(args);
          if (names.length > policy.maxAppsPerProject) {
            throw new AppLimitExceededError(
              `This project has ${names.length} apps but the tenant allows ${policy.maxAppsPerProject}; remove apps from the repo to build again`,
            );
          }
        }
        if (args.kind === "published") {
          if (!args.commitSha) {
            throw new AppPublishStateError(
              "A published build requires a commitSha",
            );
          }
          if (!COMMIT_SHA_PATTERN.test(args.commitSha)) {
            throw new AppPublishStateError(
              "commitSha must be a hex git object name",
            );
          }
        }

        const appId = await this.ensureAppRow(args);
        const version = await this.db
          .insertInto("app_versions")
          .values({
            app_id: appId,
            kind: args.kind,
            status: "building",
            commit_sha: args.kind === "published" ? args.commitSha : null,
            built_by_external_user_id: args.identity.externalUserId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        span.setAttribute("catamorphic.app.version_id", version.id);

        try {
          // Preview builds compile what the caller has right now — including
          // an agent's in-flight sandbox work that hasn't hit the end-of-turn
          // sync yet — so pull sandbox changes into the dev tree first.
          if (args.kind === "preview") {
            await this.deps.devSandboxes.syncBack({
              identity: args.identity,
              projectId: args.projectId,
            });
          }
          // One snapshot feeds both the authorization parse and the compile
          // upload, so the frozen set and the bundle come from the same tree
          // — for previews too, where the dev repo can move mid-build.
          const files = await this.projectSnapshot(args);
          const { allowedWorkflows, workflowShapes } =
            this.resolveAppContract(files);
          const bundle = await (args.kind === "preview"
            ? this.withBuildLock(
                `${args.projectId}:${args.identity.externalUserId}`,
                () => this.compile({ ...args, versionId: version.id, files }),
              )
            : this.compile({ ...args, versionId: version.id, files }));
          const installLimit =
            this.deps.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
          const limit = policy.maxBundleBytes
            ? Math.min(installLimit, policy.maxBundleBytes)
            : installLimit;
          const encoder = new TextEncoder();
          const codeBytes = encoder.encode(bundle.code);
          const cssBytes = encoder.encode(bundle.css);
          const bundleBytes = codeBytes.byteLength + cssBytes.byteLength;
          if (bundleBytes > limit) {
            throw new AppBundleTooLargeError(bundleBytes, limit);
          }

          const keyArgs = {
            tenantId: args.identity.tenantId,
            projectId: args.projectId,
            appId,
            versionId: version.id,
          };
          const bundleKey = appBundleKey({ ...keyArgs, file: "app.js" });
          const cssKey = appBundleKey({ ...keyArgs, file: "app.css" });
          await this.deps.bundleStore.put(bundleKey, codeBytes);
          await this.deps.bundleStore.put(cssKey, cssBytes);

          const ready = await this.db
            .updateTable("app_versions")
            .set({
              status: "ready",
              bundle_key: bundleKey,
              css_key: cssKey,
              bundle_bytes: bundleBytes,
              allowed_workflows: JSON.stringify(allowedWorkflows),
              // Frozen IO shapes for the callable set, so the MCP tool
              // surface serves real input schemas without a parse.
              workflow_shapes: JSON.stringify(workflowShapes),
              ready_at: new Date(),
            })
            .where("id", "=", version.id)
            .returningAll()
            .executeTakeFirstOrThrow();

          await this.pruneOldPreviews({ ...keyArgs });
          return mapVersion(ready, args.appName);
        } catch (error) {
          const failed = await this.db
            .updateTable("app_versions")
            .set({
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            })
            .where("id", "=", version.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          if (
            error instanceof AppBundleTooLargeError ||
            error instanceof AppBuildFailedError ||
            error instanceof AppContractError
          ) {
            return mapVersion(failed, args.appName);
          }
          throw error;
        }
      },
    );
  }

  /**
   * Sync any in-flight sandbox work into the dev tree and commit the whole
   * tree, returning the commit sha for a published build to pin. Returns the
   * current HEAD when the tree is already clean.
   */
  async commitDevTree(args: {
    identity: Identity;
    projectId: string;
    message: string;
  }): Promise<string> {
    await this.requireProject(args.identity, args.projectId);
    await this.deps.devSandboxes.syncBack({
      identity: args.identity,
      projectId: args.projectId,
    });
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      const status = await repo.status();
      if (!status.dirty) return await repo.resolveRef("HEAD");
      return await repo.commit(args.message, {
        name: "catamorphic",
        email: "agent@catamorphic.dev",
      });
    } finally {
      await repo.dispose();
    }
  }

  /** Makes a ready published version the live one, atomically replacing any predecessor. */
  async publish(args: {
    identity: Identity;
    projectId: string;
    versionId: string;
  }): Promise<AppVersion> {
    await this.requireProject(args.identity, args.projectId);
    const policy = await this.deps.policies.get(args.identity.tenantId);
    if (!policy.appsEnabled) {
      throw new AppsDisabledError(args.identity.tenantId);
    }
    return this.db.transaction().execute(async (trx) => {
      const version = await trx
        .selectFrom("app_versions")
        .innerJoin("apps", "apps.id", "app_versions.app_id")
        .where("app_versions.id", "=", args.versionId)
        .where("apps.project_id", "=", args.projectId)
        .selectAll("app_versions")
        .select("apps.name as app_name")
        .executeTakeFirst();
      if (!version) throw new AppVersionNotFoundError(args.versionId);
      if (version.kind !== "published" || version.status !== "ready") {
        throw new AppPublishStateError(
          "Only a ready published build can be made active",
        );
      }
      await trx
        .updateTable("app_versions")
        .set({ is_active: false })
        .where("app_id", "=", version.app_id)
        .where("is_active", "=", true)
        .execute();
      const active = await trx
        .updateTable("app_versions")
        .set({ is_active: true, published_at: new Date() })
        .where("id", "=", args.versionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapVersion(active, version.app_name);
    });
  }

  async listVersions(args: {
    identity: Identity;
    projectId: string;
    appName: string;
  }): Promise<AppVersion[]> {
    await this.requireProject(args.identity, args.projectId);
    const rows = await this.db
      .selectFrom("app_versions")
      .innerJoin("apps", "apps.id", "app_versions.app_id")
      .where("apps.project_id", "=", args.projectId)
      .where("apps.name", "=", args.appName)
      .selectAll("app_versions")
      .select("apps.name as app_name")
      .orderBy("app_versions.created_at", "desc")
      .execute();
    return rows.map((row) => mapVersion(row, row.app_name));
  }

  /**
   * Authorizes a bundle read without loading the bytes. A conditional request
   * (`If-None-Match`) must pass exactly the same access checks as a full one:
   * the validator is derived from the caller-supplied version id, so
   * answering 304 before authorizing would let anyone probe which versions
   * exist in any tenant.
   */
  async assertBundleReadable(args: {
    identity: Identity;
    projectId: string;
    versionId: string;
  }): Promise<void> {
    await this.requireProject(args.identity, args.projectId);
    const version = await this.db
      .selectFrom("app_versions")
      .innerJoin("apps", "apps.id", "app_versions.app_id")
      .where("app_versions.id", "=", args.versionId)
      .where("apps.project_id", "=", args.projectId)
      .select("app_versions.id")
      .executeTakeFirst();
    if (!version) throw new AppVersionNotFoundError(args.versionId);
  }

  /** Loads the stored bundle for one version. */
  async getBundle(args: {
    identity: Identity;
    projectId: string;
    versionId: string;
  }): Promise<AppBundle> {
    await this.requireProject(args.identity, args.projectId);
    const version = await this.db
      .selectFrom("app_versions")
      .innerJoin("apps", "apps.id", "app_versions.app_id")
      .where("app_versions.id", "=", args.versionId)
      .where("apps.project_id", "=", args.projectId)
      .select(["app_versions.bundle_key", "app_versions.css_key"])
      .executeTakeFirst();
    if (!version?.bundle_key || !version.css_key) {
      throw new AppVersionNotFoundError(args.versionId);
    }
    const [code, css] = await Promise.all([
      this.deps.bundleStore.get(version.bundle_key),
      this.deps.bundleStore.get(version.css_key),
    ]);
    if (!code || !css) throw new AppVersionNotFoundError(args.versionId);
    const decoder = new TextDecoder();
    return {
      code: decoder.decode(code.data),
      css: decoder.decode(css.data),
      etag: `"${args.versionId}"`,
    };
  }

  /**
   * What a viewer should see for an app, as data rather than an error: the
   * host renders each state with its own copy, and a new state is a compile
   * error at the switch, not a mystery 403 (assertNever on the client).
   * This is the one read a scoped identity may perform: the identity must
   * cover `{ kind: "app", projectId, name, channel }` or the app reads as
   * not found.
   */
  async viewState(args: {
    identity: Identity;
    projectId: string;
    appName: string;
    /**
     * "published" (default) serves the active published version — what
     * external viewers see. "dev" serves the newest ready build this same
     * user made, so a builder can open the version being developed right
     * now (mirrors the `dev` app ref in `resolveScope`).
     */
    channel?: "published" | "dev";
  }): Promise<
    | { state: "not_found" }
    | { state: "not_published" }
    | {
        state: "ready";
        appId: string;
        versionId: string;
        code: string;
        css: string;
        allowedWorkflows: string[];
        /** Frozen per-workflow IO schemas, keyed by workflow name. */
        workflowShapes: Record<string, AppWorkflowShape>;
        /** Origins the mount's iframe CSP may allow (tenant policy). */
        allowedNetworkOrigins: string[];
      }
  > {
    // Deliberately NOT assertBuilder: viewers land here. Tenant scoping
    // still applies through the project join below, and a scoped identity
    // must cover this very app.
    if (
      !identityCovers(args.identity, {
        kind: "app",
        projectId: args.projectId,
        name: args.appName,
      })
    ) {
      return { state: "not_found" };
    }
    const app = await this.db
      .selectFrom("apps")
      .innerJoin("projects", "projects.id", "apps.project_id")
      .where("apps.project_id", "=", args.projectId)
      .where("apps.name", "=", args.appName)
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .select("apps.id")
      .executeTakeFirst();
    if (!app) return { state: "not_found" };

    let versionQuery = this.db
      .selectFrom("app_versions")
      .where("app_id", "=", app.id)
      .where("status", "=", "ready")
      .select([
        "id",
        "bundle_key",
        "css_key",
        "allowed_workflows",
        "workflow_shapes",
      ]);
    versionQuery =
      args.channel === "dev"
        ? versionQuery
            .where(
              "built_by_external_user_id",
              "=",
              args.identity.externalUserId,
            )
            .orderBy("created_at", "desc")
            .limit(1)
        : versionQuery.where("is_active", "=", true);
    const version = await versionQuery.executeTakeFirst();
    if (!version?.bundle_key || !version.css_key) {
      return { state: "not_published" };
    }

    const [code, css] = await Promise.all([
      this.deps.bundleStore.get(version.bundle_key),
      this.deps.bundleStore.get(version.css_key),
    ]);
    if (!code || !css) return { state: "not_published" };
    const policy = await this.deps.policies.get(args.identity.tenantId);
    const decoder = new TextDecoder();
    return {
      state: "ready",
      appId: app.id,
      versionId: version.id,
      code: decoder.decode(code.data),
      css: decoder.decode(css.data),
      allowedWorkflows: parseAllowedWorkflows(version.allowed_workflows) ?? [],
      workflowShapes: parseWorkflowShapes(version.workflow_shapes),
      allowedNetworkOrigins: policy.allowedNetworkOrigins,
    };
  }

  private async compile(args: {
    identity: Identity;
    projectId: string;
    appName: string;
    kind: AppVersionKind;
    versionId: string;
    /** The snapshot to build — the same file set the frozen set was parsed from. */
    files: Record<string, string>;
  }): Promise<Pick<AppBundle, "code" | "css">> {
    const sandbox = await this.deps.devSandboxes.ensure({
      identity: args.identity,
      projectId: args.projectId,
      refresh: false,
    });

    let buildRoot = sandbox.projectDirectory;
    if (args.kind === "published") {
      // Published artifacts must be reproducible from git alone, so they build
      // from a pristine checkout rather than the user's mutable dev tree.
      // Keyed by version id: two apps published from the same commit build
      // concurrently, and a sha-keyed directory would be torn down by one
      // build's cleanup while the other is mid-install.
      buildRoot = `${this.deps.provider.workspaceRoot}/app-builds/${args.versionId}`;
      await this.deps.provider.executeCommand(
        sandbox.providerId,
        `rm -rf ${shellQuote(buildRoot)} && mkdir -p ${shellQuote(buildRoot)}`,
        { timeout: 30 },
      );
    }
    // Both kinds build the snapshot: uploading it (rather than trusting the
    // sandbox's current tree for previews) is what keeps the compiled bundle
    // and the frozen authorization set on the same commit of reality.
    await this.deps.provider.uploadFiles(
      sandbox.providerId,
      args.files,
      buildRoot,
    );

    const appDir = `${buildRoot}/${APP_SOURCE_ROOT}/${args.appName}`;
    try {
      // @catamorphic/app is provided from the local install, not the
      // registry. Bun resolves the whole workspace at once, so strip the
      // dependency from every manifest that names it, install, then restore
      // the manifests and upload the runtime payload into node_modules.
      const manifests = await this.readAppPackageManifests({
        sandboxId: sandbox.providerId,
        buildRoot,
        appName: args.appName,
      });
      const stripped = Object.fromEntries(
        Object.entries(manifests).map(([path, content]) => [
          path,
          removePackageDependencies({
            packageJson: content,
            packageNames: SANDBOX_STRIPPED_PACKAGES,
          }),
        ]),
      );
      if (Object.keys(stripped).length > 0) {
        await this.deps.provider.uploadFiles(
          sandbox.providerId,
          stripped,
          buildRoot,
        );
      }
      const install = await this.deps.provider.executeCommand(
        sandbox.providerId,
        "bun install",
        { cwd: buildRoot, timeout: INSTALL_TIMEOUT_SECONDS },
      );
      if (Object.keys(manifests).length > 0) {
        await this.deps.provider.uploadFiles(
          sandbox.providerId,
          manifests,
          buildRoot,
        );
        // node_modules is hoisted to the workspace root; one payload there
        // serves every member.
        await uploadPluginPayloads({
          provider: this.deps.provider,
          sandboxId: sandbox.providerId,
          projectDir: buildRoot,
          plugins: [await loadAppPackagePayload()],
        });
      }
      if (install.exitCode !== 0) {
        throw new AppBuildFailedError(install.result);
      }
      const build = await this.deps.provider.executeCommand(
        sandbox.providerId,
        "bun run build",
        { cwd: appDir, timeout: BUILD_TIMEOUT_SECONDS },
      );
      if (build.exitCode !== 0) {
        throw new AppBuildFailedError(build.result);
      }
      const [code, css] = await Promise.all([
        this.deps.provider.downloadFile(
          sandbox.providerId,
          `${appDir}/dist/app.js`,
        ),
        this.deps.provider
          .downloadFile(sandbox.providerId, `${appDir}/dist/app.css`)
          .catch(() => ""),
      ]);
      return { code, css };
    } finally {
      if (buildRoot !== sandbox.projectDirectory) {
        await this.deps.provider
          .executeCommand(
            sandbox.providerId,
            `rm -rf ${shellQuote(buildRoot)}`,
            { timeout: 30 },
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * One file snapshot per build: published versions read the pinned commit,
   * previews read the dev tree once. The same snapshot is parsed for the
   * frozen workflow set and uploaded for the compile, so the authorization
   * set and the bundle cannot come from different states of the repo.
   */
  private async projectSnapshot(args: {
    identity: Identity;
    projectId: string;
    kind: AppVersionKind;
    commitSha?: string;
  }): Promise<Record<string, string>> {
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      return args.kind === "published" && args.commitSha
        ? await repo.readAllFilesAtRef(args.commitSha)
        : await repo.readAllFiles();
    } finally {
      await repo.dispose();
    }
  }

  /**
   * The workflows this version may invoke, frozen from `app-api.ts` in the
   * snapshot the bundle compiles from, so the authorization set and the type
   * surface cannot disagree. A project with apps but no valid contract
   * surface fails the build: a version with no frozen set would either be
   * uncallable or unbounded, and both are worse than an error.
   */
  private resolveAppContract(files: Record<string, string>): {
    allowedWorkflows: string[];
    workflowShapes: Record<
      string,
      { inputSchema: unknown; outputSchema: unknown }
    >;
  } {
    const parsed = parseProject(files);
    const surface: AppApiSurface | null = parsed.appApi;
    const contractErrors = parsed.errors.filter((error) =>
      error.file?.endsWith("app-api.ts"),
    );
    if (contractErrors.length > 0) {
      throw new AppContractError(
        contractErrors.map((error) => error.message).join("\n"),
      );
    }
    if (!surface) {
      throw new AppContractError(
        "workflows/src/app-api.ts is missing. Export the contract object listing the workflows apps may call.",
      );
    }
    const workflowShapes: Record<
      string,
      { inputSchema: unknown; outputSchema: unknown }
    > = {};
    for (const entry of surface.entries) {
      workflowShapes[entry.workflowName] = {
        inputSchema: entry.inputSchema ?? {},
        outputSchema: entry.outputSchema ?? {},
      };
    }
    return {
      allowedWorkflows: surface.entries
        .map((entry) => entry.workflowName)
        .sort(),
      workflowShapes,
    };
  }

  /** Manifests under the build root that declare @catamorphic/app. */
  private async readAppPackageManifests(args: {
    sandboxId: string;
    buildRoot: string;
    appName: string;
  }): Promise<Record<string, string>> {
    const candidates = [
      "package.json",
      "contracts/package.json",
      `${APP_SOURCE_ROOT}/${args.appName}/package.json`,
    ];
    const manifests: Record<string, string> = {};
    await Promise.all(
      candidates.map(async (relative) => {
        const content = await this.deps.provider
          .downloadFile(args.sandboxId, `${args.buildRoot}/${relative}`)
          .catch(() => undefined);
        if (
          content &&
          SANDBOX_STRIPPED_PACKAGES.some((name) => content.includes(name))
        ) {
          manifests[relative] = content;
        }
      }),
    );
    return manifests;
  }

  private async appNamesFromRepo(args: {
    identity: Identity;
    projectId: string;
  }): Promise<string[]> {
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      const files = await repo.listFiles();
      const names = new Set<string>();
      const pattern = new RegExp(
        `^${APP_SOURCE_ROOT}/([a-z0-9][a-z0-9-]*)/package\\.json$`,
      );
      for (const file of files) {
        const match = pattern.exec(file);
        if (match?.[1]) names.add(match[1]);
      }
      return [...names].sort();
    } finally {
      await repo.dispose();
    }
  }

  private async ensureAppRow(args: {
    projectId: string;
    appName: string;
  }): Promise<string> {
    const row = await this.db
      .insertInto("apps")
      .values({ project_id: args.projectId, name: args.appName })
      .onConflict((conflict) =>
        conflict
          .columns(["project_id", "name"])
          .doUpdateSet({ updated_at: new Date() }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async pruneOldPreviews(args: {
    tenantId: string;
    projectId: string;
    appId: string;
  }): Promise<void> {
    const stale = await this.db
      .selectFrom("app_versions")
      .where("app_id", "=", args.appId)
      .where("kind", "=", "preview")
      .orderBy("created_at", "desc")
      .offset(PREVIEW_VERSIONS_KEPT)
      .select("id")
      .execute();
    for (const row of stale) {
      await this.deps.bundleStore.deletePrefix(
        appVersionPrefix({ ...args, versionId: row.id }),
      );
      await this.db
        .deleteFrom("app_versions")
        .where("id", "=", row.id)
        .execute();
    }
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    assertBuilder(identity, projectId);
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }
}

function mapVersion(
  row: Selectable<DB["app_versions"]>,
  appName: string,
): AppVersion {
  return {
    id: row.id,
    appId: row.app_id,
    appName,
    kind: row.kind as AppVersionKind,
    status: row.status as AppVersionStatus,
    commitSha: row.commit_sha,
    bundleBytes: row.bundle_bytes === null ? null : Number(row.bundle_bytes),
    allowedWorkflows: parseAllowedWorkflows(row.allowed_workflows),
    error: row.error,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    readyAt: row.ready_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

export interface AppWorkflowShape {
  inputSchema: unknown;
  outputSchema: unknown;
}

function parseWorkflowShapes(value: unknown): Record<string, AppWorkflowShape> {
  if (value == null) return {};
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const shapes: Record<string, AppWorkflowShape> = {};
  for (const [name, shape] of Object.entries(parsed)) {
    if (typeof shape !== "object" || shape === null) continue;
    const record = shape as Record<string, unknown>;
    shapes[name] = {
      inputSchema: record.inputSchema ?? {},
      outputSchema: record.outputSchema ?? {},
    };
  }
  return shapes;
}

function parseAllowedWorkflows(value: unknown): string[] | null {
  if (value == null) return null;
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : null;
}

function assertAppName(name: string): void {
  if (!APP_NAME_PATTERN.test(name) || name.length > 100) {
    throw new AppNotFoundError(name);
  }
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", String.raw`'\''`)}'`;
}
