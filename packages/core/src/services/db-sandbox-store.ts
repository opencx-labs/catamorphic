import type { DB } from "@catamorphic/db";
import type { SandboxStore } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";

type SandboxType = "execution" | "dev";

/**
 * `SandboxStore` over the `project_sandboxes` table. Dev sandboxes are keyed
 * by (project, external user); execution sandboxes by (project, commit).
 */
export class DbSandboxStore implements SandboxStore {
  constructor(private readonly db: Kysely<DB>) {}

  async findSandbox(opts: {
    projectId: string;
    sandboxType: SandboxType;
    commitSha?: string;
    userId?: string;
  }) {
    let query = this.db
      .selectFrom("project_sandboxes")
      .where("project_id", "=", opts.projectId)
      .where("sandbox_type", "=", opts.sandboxType);

    if (opts.commitSha !== undefined) {
      query = query.where("commit_sha", "=", opts.commitSha);
    }
    if (opts.userId !== undefined) {
      query = query.where("external_user_id", "=", opts.userId);
    }

    const row = await query.selectAll().executeTakeFirst();
    if (!row) return null;

    return {
      id: row.id,
      providerId: row.provider_id,
      projectId: row.project_id,
      sandboxType: row.sandbox_type as SandboxType,
      commitSha: row.commit_sha,
      userId: row.external_user_id,
      status: row.status,
    };
  }

  async insertSandbox(record: {
    projectId: string;
    providerId: string;
    sandboxType: SandboxType;
    commitSha: string | null;
    userId: string | null;
    status: string;
  }) {
    const row = await this.db
      .insertInto("project_sandboxes")
      .values({
        project_id: record.projectId,
        provider_id: record.providerId,
        sandbox_type: record.sandboxType,
        commit_sha: record.commitSha,
        external_user_id: record.userId,
        status: record.status,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      providerId: row.provider_id,
      projectId: row.project_id,
      sandboxType: row.sandbox_type as SandboxType,
      commitSha: row.commit_sha,
      userId: row.external_user_id,
      status: row.status,
    };
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await this.db
      .updateTable("project_sandboxes")
      .set({ status })
      .where("id", "=", id)
      .execute();
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.db
      .updateTable("project_sandboxes")
      .set({ last_used_at: new Date() })
      .where("id", "=", id)
      .execute();
  }
}
