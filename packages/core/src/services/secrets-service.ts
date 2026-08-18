import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { assertBuilder } from "./artifact-scope.js";
import {
  type PluginsService,
  UndeclaredSecretError,
} from "./plugins-service.js";
import { requireTenantProject } from "./projects-service.js";

export interface SecretStatus {
  name: string;
  hasValue: boolean;
  updatedAt: string | null;
  label?: string;
  description?: string;
  required: boolean;
  /** Where the declaration came from, for UI grouping. */
  source: "project" | "plugin";
}

export type SecretEnvironment = "test" | "production";

interface DeclaredSecretEntry {
  label?: string;
  description?: string;
  required: boolean;
  default?: string;
  source: "project" | "plugin";
}

/**
 * Resolves the secrets a project declares in its own code via `defineSecrets`.
 * Supplied by the host so this service stays free of git and parser concerns.
 */
export type ProjectSecretDeclarationsReader = (args: {
  identity: Identity;
  projectId: string;
}) => Promise<
  readonly {
    name: string;
    label?: string;
    description?: string;
    required: boolean;
    default?: string;
  }[]
>;

/**
 * Per-project secret store. Values are only read back through
 * {@link loadForRun}; the dashboard APIs expose presence metadata but never
 * the raw value.
 *
 * A secret must be declared before a value can be stored for it, either by an
 * attached plugin's manifest or by the project's own `defineSecrets` call.
 * Plugin declarations win on name conflict, since the plugin's code reads the
 * value and its manifest states the contract.
 */
export class SecretsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly plugins?: PluginsService,
    private readonly projectDeclarations?: ProjectSecretDeclarationsReader,
  ) {}

  private async declaredSecrets(args: {
    identity: Identity;
    projectId: string;
  }): Promise<Map<string, DeclaredSecretEntry>> {
    const { identity, projectId } = args;
    const declared = new Map<string, DeclaredSecretEntry>();

    for (const secret of (await this.projectDeclarations?.({
      identity,
      projectId,
    })) ?? []) {
      declared.set(secret.name, {
        label: secret.label,
        description: secret.description,
        required: secret.required,
        default: secret.default,
        source: "project",
      });
    }

    for (const [name, secret] of (await this.plugins?.getDeclaredSecrets(
      projectId,
    )) ?? new Map()) {
      declared.set(name, {
        label: secret.label,
        description: secret.description,
        required: secret.required,
        default: secret.default,
        source: "plugin",
      });
    }

    return declared;
  }

  async list(opts: {
    identity: Identity;
    projectId: string;
    environment: SecretEnvironment;
  }): Promise<SecretStatus[]> {
    assertBuilder(opts.identity, opts.projectId);
    const { identity, projectId, environment } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const declared = await this.declaredSecrets({ identity, projectId });
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
    return names.map((name) => {
      const entry = declared.get(name);
      return {
        name,
        hasValue: byName.has(name),
        updatedAt: byName.get(name)?.toISOString() ?? null,
        label: entry?.label,
        description: entry?.description,
        required: entry?.required ?? true,
        source: entry?.source ?? "project",
      };
    });
  }

  async upsert(opts: {
    identity: Identity;
    projectId: string;
    environment: SecretEnvironment;
    name: string;
    value: string;
  }): Promise<SecretStatus> {
    assertBuilder(opts.identity, opts.projectId);
    const { identity, projectId, environment, name, value } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const declared = await this.declaredSecrets({ identity, projectId });
    const entry = declared.get(name);
    if (!entry) {
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

    return {
      name,
      hasValue: true,
      updatedAt: now.toISOString(),
      label: entry.label,
      description: entry.description,
      required: entry.required,
      source: entry.source,
    };
  }

  async delete(opts: {
    identity: Identity;
    projectId: string;
    environment: SecretEnvironment;
    name: string;
  }): Promise<boolean> {
    assertBuilder(opts.identity, opts.projectId);
    const { identity, projectId, environment, name } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
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
   * declared `default` when the user hasn't set an explicit value. Required
   * secrets with no value + no default are returned as missing so the caller
   * can surface a clear error.
   */
  async loadForRun(opts: {
    identity: Identity;
    projectId: string;
    environment: SecretEnvironment;
  }): Promise<{
    values: Record<string, string>;
    missingRequired: string[];
  }> {
    const { identity, projectId, environment } = opts;
    const declared = await this.declaredSecrets({ identity, projectId });
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
