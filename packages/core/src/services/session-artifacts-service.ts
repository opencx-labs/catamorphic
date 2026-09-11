import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import {
  fetchRemote,
  type ProjectManager,
  type ProjectRepo,
  push,
  type RemoteBackend,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { parseProject } from "@catamorphic/parser";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import type { ControlledTransaction, Kysely, Selectable } from "kysely";
import { type Identity, identityCovers } from "../identity.js";
import { appScaffold } from "../seeds.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import type { AppBundleStore } from "./app-bundle-store.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { requireTenantProject } from "./projects-service.js";

type SnapshotResources = {
  repo: ProjectRepo;
  remote: Pick<RemoteBackend, "withOrigin">;
};

type ArtifactRow = Selectable<DB["session_artifacts"]>;
export type SessionArtifactKind = "app" | "workflow";

export interface SessionArtifact {
  id: string;
  projectId: string;
  sessionId: string | null;
  kind: SessionArtifactKind;
  name: string;
  title: string;
  sourcePath: string;
  remoteBranch: string;
  commitSha: string;
  revision: number;
  status: "active" | "discarded";
  /** Stable ordinary app address, qualified by this artifact's identity. */
  appName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionArtifactAddress {
  identity: Identity;
  projectId: string;
  artifactId: string;
}

export class SessionArtifactNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super("Session artifact is unavailable");
    this.name = "SessionArtifactNotFoundError";
  }
}

export class SessionArtifactConflictError extends Error {
  readonly statusCode = 409;
}
export class SessionArtifactValidationError extends Error {
  readonly statusCode = 400;
}

const tracer = getTracer("@catamorphic/core");
const author = { name: "Catamorphic", email: "artifacts@catamorphic.dev" };
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;

/** One retained source lifecycle for temporary apps and workflows. */
export class SessionArtifactsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly bundleStore?: AppBundleStore,
  ) {}

  async create(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    kind: SessionArtifactKind;
    name: string;
    title?: string;
    /** App: component exporting default. Workflow: ordinary defineWorkflow source. */
    source: string;
    /** Additional explicit workspace files, including project-local libraries. */
    files?: Record<string, string>;
  }): Promise<SessionArtifact> {
    return withSpan(
      {
        tracer,
        name: "session_artifact.create",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.agent.session.id": input.sessionId,
        },
      },
      async () => {
        await this.assertSession(input);
        if (!NAME.test(input.name))
          throw new SessionArtifactValidationError("Invalid artifact name");
        if (input.kind === "app" && !/^[a-z][a-z0-9-]*$/.test(input.name)) {
          throw new SessionArtifactValidationError(
            "App names must use lowercase letters, digits and hyphens",
          );
        }
        const id = randomUUID();
        const sourcePath =
          input.kind === "app"
            ? `apps/${input.name}/src/App.tsx`
            : `workflows/src/artifacts/${id}.ts`;
        const remoteBranch = `catamorphic/artifacts/${id}`;
        const defaults =
          input.kind === "app"
            ? {
                ...appScaffold({ name: input.name }),
                "package.json": JSON.stringify({
                  private: true,
                  type: "module",
                  workspaces: ["apps/*", "packages/*", "contracts"],
                }),
                "contracts/package.json": JSON.stringify({
                  name: "@project/contracts",
                  private: true,
                  type: "module",
                  exports: { ".": "./src/index.ts" },
                }),
                "contracts/src/index.ts": "export {};\n",
                [`apps/${input.name}/src/main.tsx`]:
                  'import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
              }
            : {};
        const files = {
          ...defaults,
          ...input.files,
          [sourcePath]: input.source,
        };
        validateFiles(files);
        const snapshot = await this.snapshot({
          ...input,
          files,
          sourcePath,
          remoteBranch,
        });
        try {
          return await this.db.transaction().execute(async (trx) => {
            await this.assertSession(input, trx);
            const row = await trx
              .insertInto("session_artifacts")
              .values({
                id,
                project_id: input.projectId,
                session_id: input.sessionId,
                owner_external_user_id: input.identity.externalUserId,
                kind: input.kind,
                name: input.name,
                title: input.title ?? input.name,
                source_path: sourcePath,
                source_paths: JSON.stringify(snapshot.paths),
                remote_branch: remoteBranch,
                commit_sha: snapshot.commitSha,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await trx
              .insertInto("session_artifact_revisions")
              .values({
                artifact_id: id,
                commit_sha: snapshot.commitSha,
                source_paths: JSON.stringify(snapshot.paths),
              })
              .execute();
            return present(row);
          });
        } catch (error) {
          await this.removeRef(
            input.identity.tenantId,
            input.projectId,
            remoteBranch,
          );
          throw error;
        }
      },
    );
  }

  async list(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
  }): Promise<SessionArtifact[]> {
    await this.assertSession({ ...input, allowClosed: true });
    const rows = await this.db
      .selectFrom("session_artifacts")
      .where("project_id", "=", input.projectId)
      .where("session_id", "=", input.sessionId)
      .where("owner_external_user_id", "=", input.identity.externalUserId)
      .orderBy("created_at", "desc")
      .selectAll()
      .execute();
    return rows.map(present);
  }

  async get(input: SessionArtifactAddress): Promise<SessionArtifact> {
    return present(await this.row(input));
  }

  async files(
    input: SessionArtifactAddress & { commitSha?: string },
  ): Promise<Record<string, string>> {
    const row = await this.row(input);
    if (!row.session_id) throw new SessionArtifactNotFoundError();
    await this.assertSession({
      ...input,
      sessionId: row.session_id,
      allowClosed: true,
    });
    const revision = await this.db
      .selectFrom("session_artifact_revisions")
      .select("source_paths")
      .where("artifact_id", "=", row.id)
      .where("commit_sha", "=", input.commitSha ?? row.commit_sha)
      .executeTakeFirstOrThrow();
    const repo = await this.projectManager.openEphemeral({
      tenantId: input.identity.tenantId,
      projectId: input.projectId,
    });
    try {
      await this.fetch(
        repo,
        input.identity.tenantId,
        input.projectId,
        row.remote_branch,
      );
      // The artifact's named ref must retain this revision. An arbitrary SHA
      // supplied by a guest is never accepted by a public route.
      const files = await repo.readAllFilesAtRef(
        input.commitSha ?? row.commit_sha,
      );
      return Object.fromEntries(
        Object.entries(files).filter(([path]) =>
          pathsOf(revision.source_paths).includes(path),
        ),
      );
    } finally {
      await repo.dispose();
    }
  }

  async update(
    input: SessionArtifactAddress & {
      revision: number;
      files: Record<string, string | null>;
      title?: string;
    },
  ): Promise<SessionArtifact> {
    return withSpan(
      {
        tracer,
        name: "session_artifact.update",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.artifact.id": input.artifactId,
        },
      },
      async () => {
        validateFiles(input.files);
        await this.row(input);
        let transaction: ControlledTransaction<DB> | undefined;
        try {
          const result = await this.withSnapshotResources(
            input,
            async (resources) => {
              const trx = await this.db.startTransaction().execute();
              transaction = trx;
              const row = await this.row(input, trx, true);
              if (!row.session_id) throw new SessionArtifactNotFoundError();
              await this.assertSession(
                { ...input, sessionId: row.session_id },
                trx,
              );
              if (row.revision !== input.revision)
                throw new SessionArtifactConflictError(
                  "Artifact changed. Read the latest revision before editing.",
                );
              const snapshot = await this.snapshot({
                ...input,
                kind: artifactKind(row.kind),
                name: row.name,
                sourcePath: row.source_path,
                remoteBranch: row.remote_branch,
                previousSha: row.commit_sha,
                resources,
              });
              const paths = [
                ...new Set(
                  [...pathsOf(row.source_paths), ...snapshot.paths].filter(
                    (path) => input.files[path] !== null,
                  ),
                ),
              ];
              await trx
                .insertInto("session_artifact_revisions")
                .values({
                  artifact_id: row.id,
                  commit_sha: snapshot.commitSha,
                  source_paths: JSON.stringify(paths),
                })
                .onConflict((conflict) => conflict.doNothing())
                .execute();
              const updated = await trx
                .updateTable("session_artifacts")
                .set({
                  commit_sha: snapshot.commitSha,
                  revision: row.revision + 1,
                  source_paths: JSON.stringify(paths),
                  title: input.title ?? row.title,
                  updated_at: new Date(),
                })
                .where("id", "=", row.id)
                .returningAll()
                .executeTakeFirstOrThrow();
              return present(updated);
            },
          );
          // withOrigin can publish buffered remote writes after its callback.
          // Commit the row only once that publication has succeeded.
          await transaction?.commit().execute();
          return result;
        } catch (error) {
          if (
            transaction &&
            !transaction.isCommitted &&
            !transaction.isRolledBack
          )
            await transaction.rollback().execute();
          throw error;
        }
      },
    );
  }

  async discard(input: SessionArtifactAddress): Promise<SessionArtifact> {
    return withSpan(
      {
        tracer,
        name: "session_artifact.discard",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.artifact.id": input.artifactId,
        },
      },
      async () => {
        const row = await this.row(input, this.db, false, true);
        if (row.session_id)
          await this.assertSession({
            ...input,
            sessionId: row.session_id,
            allowClosed: true,
          });
        const updated = await this.db
          .updateTable("session_artifacts")
          .set({
            status: "discarded",
            discarded_at: new Date(),
            updated_at: new Date(),
          })
          .where("id", "=", input.artifactId)
          .where("status", "=", "active")
          .returningAll()
          .executeTakeFirst();
        return present(updated ?? row);
      },
    );
  }

  async assertActive(input: SessionArtifactAddress): Promise<void> {
    const row = await this.row(input);
    if (!row.session_id) throw new SessionArtifactNotFoundError();
    await this.assertSession({ ...input, sessionId: row.session_id });
  }

  /** Reclaim retired source only after all runs at its retained ref settle. */
  async cleanup(): Promise<void> {
    const rows = await this.db
      .selectFrom("session_artifacts as artifact")
      .innerJoin("projects", "projects.id", "artifact.project_id")
      .where(({ or, eb }) =>
        or([
          eb("artifact.status", "=", "discarded"),
          eb("artifact.session_id", "is", null),
        ]),
      )
      .where("artifact.ref_deleted_at", "is", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("workflow_runs as run")
              .whereRef("run.session_artifact_id", "=", "artifact.id")
              .where("run.status", "not in", [
                "completed",
                "failed",
                "canceled",
              ])
              .select("run.id"),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("app_versions")
              .innerJoin("apps", "apps.id", "app_versions.app_id")
              .whereRef("apps.session_artifact_id", "=", "artifact.id")
              .where("app_versions.status", "=", "building")
              .select("app_versions.id"),
          ),
        ),
      )
      .select([
        "artifact.id",
        "artifact.project_id",
        "artifact.remote_branch",
        "projects.tenant_id",
      ])
      .limit(50)
      .execute();
    for (const row of rows) {
      try {
        const apps = await this.db
          .selectFrom("apps")
          .select("id")
          .where("session_artifact_id", "=", row.id)
          .execute();
        if (apps.length && !this.bundleStore) continue;
        for (const app of apps)
          await this.bundleStore?.deletePrefix(
            `apps/${row.tenant_id}/${row.project_id}/${app.id}/`,
          );
        await this.db
          .deleteFrom("apps")
          .where("session_artifact_id", "=", row.id)
          .execute();
        await this.removeRef(row.tenant_id, row.project_id, row.remote_branch);
        await this.db
          .updateTable("session_artifacts")
          .set({ ref_deleted_at: new Date(), last_error: null })
          .where("id", "=", row.id)
          .execute();
      } catch (error) {
        await this.db
          .updateTable("session_artifacts")
          .set({
            last_error: error instanceof Error ? error.message : String(error),
          })
          .where("id", "=", row.id)
          .execute();
      }
    }
  }

  private async row(
    input: SessionArtifactAddress,
    db = this.db,
    lock = false,
    includeDiscarded = false,
  ): Promise<ArtifactRow> {
    await requireTenantProject(db, input.identity.tenantId, input.projectId);
    let query = db
      .selectFrom("session_artifacts")
      .selectAll()
      .where("id", "=", input.artifactId)
      .where("project_id", "=", input.projectId)
      .where("owner_external_user_id", "=", input.identity.externalUserId);
    if (!includeDiscarded)
      query = query
        .where("status", "=", "active")
        .where("session_id", "is not", null);
    const row = await (lock ? query.forUpdate() : query).executeTakeFirst();
    if (!row) throw new SessionArtifactNotFoundError();
    if (
      row.session_id &&
      !identityCovers(input.identity, {
        kind: "app",
        projectId: input.projectId,
        name: `session-${row.id}`,
      })
    ) {
      await this.assertSession(
        {
          ...input,
          sessionId: row.session_id,
          allowClosed: true,
        },
        db,
      );
    }
    return row;
  }

  private async assertSession(
    input: {
      identity: Identity;
      projectId: string;
      sessionId: string;
      allowClosed?: boolean;
    },
    db = this.db,
  ): Promise<void> {
    await requireTenantProject(db, input.identity.tenantId, input.projectId);
    const row = await db
      .selectFrom("agent_sessions")
      .select(["status", "external_user_id", "agent_id"])
      .where("project_id", "=", input.projectId)
      .where("id", "=", input.sessionId)
      .executeTakeFirst();
    if (!row || row.external_user_id !== input.identity.externalUserId)
      throw new AccessDeniedError();
    assertAgentSessionAccess({
      identity: input.identity,
      projectId: input.projectId,
      externalUserId: row.external_user_id,
      agentId: row.agent_id,
    });
    if (!input.allowClosed && row.status !== "active")
      throw new SessionArtifactConflictError("Session is closed");
  }

  private async snapshot(input: {
    identity: Identity;
    projectId: string;
    kind: SessionArtifactKind;
    name: string;
    files: Record<string, string | null>;
    sourcePath: string;
    remoteBranch: string;
    previousSha?: string;
    resources?: SnapshotResources;
  }): Promise<{ commitSha: string; paths: string[] }> {
    if (!input.resources)
      return this.withSnapshotResources(input, (resources) =>
        this.snapshot({ ...input, resources }),
      );
    const { repo, remote } = input.resources;
    if (input.previousSha) {
      // A previous process may have pushed then died before its DB commit.
      // The row is locked by update: only its accepted revision is authoritative.
      await remote.withOrigin(
        input.identity.tenantId,
        input.projectId,
        async (origin) => {
          const ref = `refs/heads/${input.remoteBranch}`;
          const head = await origin.resolveRef(ref);
          if (head && head !== input.previousSha && input.previousSha)
            await origin.updateRef({
              ref,
              sha: input.previousSha,
              expected: head,
            });
        },
      );
      await fetchRemote({
        dev: repo,
        remote,
        tenantId: input.identity.tenantId,
        projectId: input.projectId,
        remoteBranch: input.remoteBranch,
      });
      await repo.moveBranch("main", input.previousSha);
      await repo.checkout("main");
    }
    const files = { ...input.files };
    if (
      input.kind === "workflow" &&
      !(await repo.listFiles()).includes("package.json") &&
      !("package.json" in files)
    ) {
      files["package.json"] = JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
      });
    }
    const existingPaths = new Set(await repo.listFiles());
    for (const [file, content] of Object.entries(files)) {
      await assertNoSymlink(repo.repoPath, file);
      if (content === null) {
        if (existingPaths.has(file)) await repo.deleteFile(file);
      } else await repo.writeFile(file, content);
    }
    const parsed = parseProject(await repo.readAllFiles());
    // App helpers also execute by export name. A selected helper must not
    // collide with a workflow elsewhere in the retained project snapshot.
    const ambiguous = parsed.workflows.find(
      (workflow) =>
        workflow.filePath in files &&
        parsed.workflows.filter(
          (candidate) => candidate.functionName === workflow.functionName,
        ).length > 1,
    );
    if (ambiguous && input.kind === "app") {
      throw new SessionArtifactValidationError(
        `Workflow export ${ambiguous.functionName} is ambiguous in this snapshot`,
      );
    }
    if (input.kind === "workflow") {
      if (
        parsed.errors.length ||
        !parsed.workflows.some(
          (workflow) =>
            workflow.functionName === input.name &&
            workflow.filePath === input.sourcePath,
        )
      ) {
        throw new SessionArtifactValidationError(
          `Invalid workflow source: ${parsed.errors.map((error) => error.message).join("\n") || `source must export ${input.name}`}`,
        );
      }
      if (
        parsed.workflows.some(
          (workflow) =>
            workflow.functionName === input.name &&
            workflow.filePath !== input.sourcePath,
        )
      ) {
        throw new SessionArtifactValidationError(
          `Workflow name '${input.name}' already exists in committed project source`,
        );
      }
    }
    const paths = Object.keys(files);
    const commitSha = await repo.commit(
      `Update session ${input.kind} ${input.name}`,
      author,
      { paths },
    );
    await push({
      dev: repo,
      remote,
      tenantId: input.identity.tenantId,
      projectId: input.projectId,
      remoteBranch: input.remoteBranch,
      localSha: commitSha,
    });
    return { commitSha, paths };
  }

  /** Resolve host storage before taking the database connection or revision lock. */
  private async withSnapshotResources<T>(
    input: { identity: Identity; projectId: string },
    run: (resources: SnapshotResources) => Promise<T>,
  ): Promise<T> {
    const remote = this.projectManager.remoteBackend;
    if (!remote) throw new Error("Artifact storage is unavailable");
    const repo = await this.projectManager.openEphemeral({
      tenantId: input.identity.tenantId,
      projectId: input.projectId,
    });
    try {
      return await remote.withOrigin(
        input.identity.tenantId,
        input.projectId,
        (origin) =>
          run({
            repo,
            remote: {
              withOrigin: async (_tenantId, _projectId, use) => use(origin),
            },
          }),
      );
    } finally {
      await repo.dispose();
    }
  }

  private async fetch(
    repo: Awaited<ReturnType<ProjectManager["openEphemeral"]>>,
    tenantId: string,
    projectId: string,
    remoteBranch: string,
  ) {
    const remote = this.projectManager.remoteBackend;
    if (!remote) throw new Error("Artifact storage is unavailable");
    await fetchRemote({ dev: repo, remote, tenantId, projectId, remoteBranch });
  }

  private async removeRef(
    tenantId: string,
    projectId: string,
    remoteBranch: string,
  ): Promise<void> {
    const remote = this.projectManager.remoteBackend;
    if (!remote) throw new Error("Artifact storage is unavailable");
    await remote.withOrigin(tenantId, projectId, (origin) =>
      origin.deleteRef({ ref: `refs/heads/${remoteBranch}` }),
    );
  }
}

function pathsOf(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((path): path is string => typeof path === "string")
    : [];
}

function artifactKind(kind: string): SessionArtifactKind {
  if (kind === "app" || kind === "workflow") return kind;
  throw new Error("Invalid artifact kind");
}

function present(row: ArtifactRow): SessionArtifact {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    kind: artifactKind(row.kind),
    name: row.name,
    title: row.title,
    sourcePath: row.source_path,
    remoteBranch: row.remote_branch,
    commitSha: row.commit_sha,
    revision: row.revision,
    status: row.status === "active" ? "active" : "discarded",
    appName: row.kind === "app" ? `session-${row.id}` : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validateFiles(files: Record<string, string | null>): void {
  const entries = Object.entries(files);
  if (entries.length > 256)
    throw new SessionArtifactValidationError(
      "An artifact update may contain at most 256 files",
    );
  let bytes = 0;
  for (const [file, content] of entries) {
    if (
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file
        .split("/")
        .some((segment) =>
          ["", ".", "..", ".git", "node_modules", "store"].includes(segment),
        )
    ) {
      throw new SessionArtifactValidationError(
        `Invalid artifact path: ${file}`,
      );
    }
    if (content !== null) bytes += Buffer.byteLength(content);
  }
  if (bytes > 5 * 1024 * 1024)
    throw new SessionArtifactValidationError("Artifact source exceeds 5 MiB");
}

/** Selected paths must not follow links supplied by committed repository code. */
async function assertNoSymlink(root: string, file: string): Promise<void> {
  const segments = file.split("/");
  for (let index = 1; index <= segments.length; index++) {
    const entry = await lstat(
      path.join(root, ...segments.slice(0, index)),
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink())
      throw new SessionArtifactValidationError(
        `Artifact path follows a symbolic link: ${file}`,
      );
  }
}
