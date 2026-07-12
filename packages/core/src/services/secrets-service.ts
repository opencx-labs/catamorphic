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

export type SecretEnvironment = "test" | "production";

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

  async list(opts: {
    projectId: string;
    environment: SecretEnvironment;
  }): Promise<SecretStatus[]> {
    const { projectId, environment } = opts;
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (declared.size === 0) return [];

    const names = [...declared.keys()];
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("environment", "=", environment)
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

  async upsert(opts: {
    projectId: string;
    environment: SecretEnvironment;
    name: string;
    value: string;
  }): Promise<SecretStatus> {
    const { projectId, environment, name, value } = opts;
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (!declared.has(name)) {
      throw new UndeclaredSecretError(name);
    }

    const now = new Date();
    await this.db
      .insertInto("project_secrets")
      .values({
        project_id: projectId,
        environment,
        name,
        value,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "environment", "name"]).doUpdateSet({
          value,
          updated_at: now,
        }),
      )
      .execute();

    return { name, hasValue: true, updatedAt: now.toISOString() };
  }

  async delete(opts: {
    projectId: string;
    environment: SecretEnvironment;
    name: string;
  }): Promise<boolean> {
    const { projectId, environment, name } = opts;
    const result = await this.db
      .deleteFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("environment", "=", environment)
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
  async loadForRun(opts: {
    projectId: string;
    environment: SecretEnvironment;
  }): Promise<{
    values: Record<string, string>;
    missingRequired: string[];
  }> {
    const { projectId, environment } = opts;
    const declared = await this.plugins.getDeclaredSecrets(projectId);
    if (declared.size === 0) {
      return { values: {}, missingRequired: [] };
    }

    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("environment", "=", environment)
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
