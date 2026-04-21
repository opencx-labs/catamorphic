import type { DB } from "@catamorphic/db";
import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import type { Kysely, Selectable } from "kysely";
import { authorFor, type Identity } from "../identity.js";
import { findTemplate, type ProjectTemplate } from "../templates.js";

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
  templateId?: string;
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
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
  ) {}

  async create(
    identity: Identity,
    input: CreateProjectInput,
  ): Promise<Project> {
    const { tenantId } = identity;
    const template = input.templateId
      ? findTemplate(input.templateId)
      : undefined;
    if (input.templateId && !template) {
      throw new Error(`Template '${input.templateId}' not found`);
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

    await this.projectManager.create(tenantId, projectId, {
      name: input.name,
      initialFiles: template?.files,
    });

    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .selectAll()
      .executeTakeFirstOrThrow();

    return mapProject(row);
  }

  async list(
    identity: Identity,
    input: ListProjectsInput = {},
  ): Promise<ListProjectsResult> {
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
    await this.requireExists(identity, projectId);

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

export type { ProjectTemplate };
