import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import {
  type PluginsService,
  UndeclaredSecretError,
} from "./plugins-service.js";

export interface SecretStatus {
  name: string;
  hasValue: boolean;
  updatedAt: string | null;
}

/**
 * Per-project secret store. Values are only read back through
 * {@link loadForRun}; the dashboard APIs expose presence metadata but never
 * the raw value.
 */
export class SecretsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly plugins: PluginsService,
  ) {}

  async list(projectId: string): Promise<SecretStatus[]> {
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (declared.size === 0) return [];

    const names = [...declared.keys()];
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("name", "in", names)
      .select(["name", "updated_at"])
      .execute();

    const byName = new Map(rows.map((r) => [r.name, r.updated_at]));
    return names.map((name) => ({
      name,
      hasValue: byName.has(name),
      updatedAt: byName.get(name)?.toISOString() ?? null,
    }));
  }

  async upsert(
    projectId: string,
    name: string,
    value: string,
  ): Promise<SecretStatus> {
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (!declared.has(name)) {
      throw new UndeclaredSecretError(name);
    }

    const now = new Date();
    await this.db
      .insertInto("project_secrets")
      .values({
        project_id: projectId,
        name,
        value,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "name"]).doUpdateSet({
          value,
          updated_at: now,
        }),
      )
      .execute();

    return { name, hasValue: true, updatedAt: now.toISOString() };
  }

  async delete(projectId: string, name: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Materialize secret name/value pairs for run-time injection. Applies the
   * `default` declared by the plugin manifest when the user hasn't set an
   * explicit value. Required secrets with no value + no default are returned
   * as missing so the caller can surface a clear error.
   */
  async loadForRun(projectId: string): Promise<{
    values: Record<string, string>;
    missingRequired: string[];
  }> {
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (declared.size === 0) {
      return { values: {}, missingRequired: [] };
    }

    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .select(["name", "value"])
      .execute();

    const stored = new Map(rows.map((r) => [r.name, r.value]));
    const values: Record<string, string> = {};
    const missingRequired: string[] = [];

    for (const [name, secret] of declared) {
      const stored_ = stored.get(name);
      if (stored_ !== undefined) {
        values[name] = stored_;
        continue;
      }
      if (secret.default !== undefined) {
        values[name] = secret.default;
        continue;
      }
      if (secret.required) missingRequired.push(name);
    }

    return { values, missingRequired };
  }
}
