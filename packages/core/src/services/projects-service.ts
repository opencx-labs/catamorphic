import type { DB } from "@catamorphic/db";
import type {
  GitCredentials,
  ProjectManager,
  ProjectRepo,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable } from "kysely";
import { authorFor, type Identity } from "../identity.js";
import { SEED_SKILLS } from "../seeds.js";
import { assertProjectSurface } from "./app-audience.js";

const tracer = getTracer("@catamorphic/core");

type ProjectRow = Selectable<DB["projects"]>;

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  storageType: "managed" | "remote";
  remoteUrl: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  /**
   * Absolute directory the working copy should live in. Library-direct only —
   * deliberately not exposed over HTTP, since a remote client must never pick
   * server filesystem paths. Hosts that use it (e.g. the desktop app) own the
   * projectId → path mapping and supply a matching `projectPathResolver` to
   * their storage config.
   */
  rootPath?: string;
  /** Adopt the folder's existing contents instead of scaffolding. */
  importExisting?: boolean;
  /**
   * Populate the project by cloning a network git remote instead of
   * scaffolding. Library-direct only (like `rootPath`) — HTTP callers go
   * through the GitHub surface, which resolves credentials server-side.
   */
  cloneFrom?: {
    url: string;
    credentials?: GitCredentials;
    branch?: string;
  };
}

export interface UpdateProjectInput {
  name?: string;
}

export interface ListProjectsInput {
  limit?: number;
  offset?: number;
}

export interface ListProjectsResult {
  items: Project[];
  total: number;
}

export interface WriteFileInput {
  content: string;
  commitMessage?: string;
}

export interface ProjectFileEntry {
  path: string;
  size: number;
}

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' not found`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * Host-side project lifecycle hooks (ADR 0046), registered at boot
 * (`createCatamorphic({ projectHooks })` or a plugin's host half). Hooks are
 * awaited on the mutation path and must be idempotent: a rolled-back create
 * may re-run `onProjectCreated` for the same project id on retry.
 */
export interface ProjectLifecycleHooks {
  /**
   * Runs after the project row and repo exist. A throw fails the create and
   * rolls both back — a project whose provisioning failed never half-exists.
   */
  onProjectCreated?(args: {
    project: Project;
    identity: Identity;
  }): void | Promise<void>;
  /**
   * Runs before anything is deleted. A throw aborts the delete, so failed
   * deprovisioning is retryable instead of leaking orphaned infrastructure.
   */
  onProjectDeleted?(args: {
    project: Project;
    identity: Identity;
  }): void | Promise<void>;
}

export class ProjectProvisioningError extends Error {
  constructor(args: { projectId: string; cause: unknown }) {
    super(
      `Project '${args.projectId}' provisioning hook failed; the create was rolled back: ${
        args.cause instanceof Error ? args.cause.message : String(args.cause)
      }`,
      { cause: args.cause },
    );
    this.name = "ProjectProvisioningError";
  }
}

export class ProjectDeprovisioningError extends Error {
  constructor(args: { projectId: string; cause: unknown }) {
    super(
      `Project '${args.projectId}' deprovisioning hook failed; the delete was aborted and can be retried: ${
        args.cause instanceof Error ? args.cause.message : String(args.cause)
      }`,
      { cause: args.cause },
    );
    this.name = "ProjectDeprovisioningError";
  }
}

export class ProjectFileNotFoundError extends Error {
  constructor(
    readonly projectId: string,
    readonly filePath: string,
  ) {
    super(`File '${filePath}' not found in project '${projectId}'`);
    this.name = "ProjectFileNotFoundError";
  }
}

/**
 * CRUD + file I/O for catamorphic projects. Each mutating method upserts
 * `tenants(tenant_id)` on first use so embedders don't have to pre-register
 * their orgs with catamorphic — the tenant row materializes the moment a
 * project is created under it.
 */
export class ProjectsService {
  private readonly seedFiles: Record<string, string>;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly hooks: readonly ProjectLifecycleHooks[] = [],
    doctrine: {
      /**
       * The host-resolved per-project seed files (ADR 0049). Defaults to the
       * framework's `SEED_SKILLS`.
       */
      seedFiles?: Record<string, string>;
    } = {},
  ) {
    this.seedFiles = doctrine.seedFiles ?? SEED_SKILLS;
  }

  async create(
    identity: Identity,
    input: CreateProjectInput,
  ): Promise<Project> {
    assertProjectSurface(identity);
    return withSpan(
      {
        tracer,
        name: "project.create",
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
        },
      },
      () => this.createInner(identity, input),
    );
  }

  private async createInner(
    identity: Identity,
    input: CreateProjectInput,
  ): Promise<Project> {
    const { tenantId } = identity;
    if (input.rootPath !== undefined && !input.rootPath.startsWith("/")) {
      throw new Error("rootPath must be an absolute path");
    }

    const projectId = crypto.randomUUID();

    await this.ensureTenant(tenantId);

    await this.db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: tenantId,
        name: input.name,
        storage_type: "managed",
      })
      .execute();

    try {
      // New projects get the resolved seed skills (hidden reference
      // material — the agent knows the conventions from its first session)
      // but NO visible workspace scaffold; the workspace arrives on demand
      // via the catamorphic-projects skill (ADR 0043).
      await this.projectManager.create(tenantId, projectId, {
        name: input.name,
        initialFiles: this.seedFiles,
        rootPath: input.rootPath,
        importExisting: input.importExisting,
        cloneFrom: input.cloneFrom,
      });
    } catch (err) {
      await this.db
        .deleteFrom("projects")
        .where("id", "=", projectId)
        .execute()
        .catch(() => {});
      throw err;
    }

    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .selectAll()
      .executeTakeFirstOrThrow();

    const project = mapProject(row);

    // Provisioning hooks run only once row + repo exist, and a failure
    // rolls both back: the host must never observe a project whose
    // infrastructure was not provisioned (ADR 0046). Hooks are idempotent
    // by contract, so a retried create may safely re-run them.
    for (const hook of this.hooks) {
      if (!hook.onProjectCreated) continue;
      try {
        await hook.onProjectCreated({ project, identity });
      } catch (cause) {
        await this.db
          .deleteFrom("projects")
          .where("id", "=", projectId)
          .execute()
          .catch(() => {});
        await this.projectManager.delete(tenantId, projectId).catch(() => {});
        throw new ProjectProvisioningError({ projectId, cause });
      }
    }

    return project;
  }

  async list(
    identity: Identity,
    input: ListProjectsInput = {},
  ): Promise<ListProjectsResult> {
    assertProjectSurface(identity);
    const { tenantId } = identity;
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const rows = await this.db
      .selectFrom("projects")
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    const total = await this.db
      .selectFrom("projects")
      .where("tenant_id", "=", tenantId)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count));

    return { items: rows.map(mapProject), total };
  }

  async get(identity: Identity, projectId: string): Promise<Project> {
    const row = await this.getRow(identity, projectId);
    return mapProject(row);
  }

  async update(
    identity: Identity,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<Project> {
    const existing = await this.getRow(identity, projectId);

    const updated = await this.db
      .updateTable("projects")
      .set({
        name: input.name ?? existing.name,
        updated_at: new Date(),
      })
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapProject(updated);
  }

  async delete(identity: Identity, projectId: string): Promise<void> {
    const row = await this.getRow(identity, projectId);
    const project = mapProject(row);

    // Deprovisioning hooks run before anything is deleted: a throw aborts
    // the delete so the host can retry, instead of leaking infrastructure
    // for a project that no longer exists (ADR 0046).
    for (const hook of this.hooks) {
      if (!hook.onProjectDeleted) continue;
      try {
        await hook.onProjectDeleted({ project, identity });
      } catch (cause) {
        throw new ProjectDeprovisioningError({ projectId, cause });
      }
    }

    await this.db
      .deleteFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .execute();

    await this.projectManager
      .delete(identity.tenantId, projectId)
      .catch(() => {});
  }

  async listFiles(
    identity: Identity,
    projectId: string,
  ): Promise<ProjectFileEntry[]> {
    await this.requireExists(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      const filePaths = await repo.listFiles();
      return filePaths.map((p) => ({ path: p, size: 0 }));
    });
  }

  async readFile(
    identity: Identity,
    projectId: string,
    filePath: string,
  ): Promise<string> {
    await this.requireExists(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      try {
        return await repo.readFile(filePath);
      } catch {
        throw new ProjectFileNotFoundError(projectId, filePath);
      }
    });
  }

  async readAllFiles(
    identity: Identity,
    projectId: string,
  ): Promise<Record<string, string>> {
    await this.requireExists(identity, projectId);
    return this.withDev(identity, projectId, (repo) => repo.readAllFiles());
  }

  async writeFile(
    identity: Identity,
    projectId: string,
    filePath: string,
    input: WriteFileInput,
  ): Promise<string> {
    await this.requireExists(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      await repo.writeFile(filePath, input.content);
      if (input.commitMessage) {
        await repo.commit(
          input.commitMessage,
          authorFor(identity.externalUserId),
        );
      }
      return input.content;
    });
  }

  /**
   * Upsert the `tenants` row for this identity. Embedders typically pass their
   * host org id as `tenantId`; this makes it a valid FK target for the
   * upcoming `projects` insert without requiring explicit provisioning.
   */
  private async ensureTenant(tenantId: string): Promise<void> {
    await this.db
      .insertInto("tenants")
      .values({ id: tenantId, name: tenantId })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  }

  private async getRow(
    identity: Identity,
    projectId: string,
  ): Promise<ProjectRow> {
    assertProjectSurface(identity);
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .selectAll()
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
    return row;
  }

  private async requireExists(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    assertProjectSurface(identity);
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }

  private async withDev<T>(
    identity: Identity,
    projectId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    storageType: row.storage_type as "managed" | "remote",
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
