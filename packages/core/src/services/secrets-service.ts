import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { assertProjectPermission } from "./artifact-scope.js";
import type { CredentialVault } from "./credential-vault.js";
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

export type RunStage = "test" | "production";

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
  /** `run`: injecting into a run the caller may start, not managing values. */
  purpose: "manage" | "run";
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
 * {@link loadForRun} and {@link value}; the dashboard APIs expose presence
 * metadata but never the raw value. With a credential vault (ADR 0162) the
 * row holds only a vault reference, so database access alone reveals no
 * secret; rows written before sealing are sealed on first read.
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
    private readonly vault?: CredentialVault,
  ) {}

  /**
   * One stored value, unsealed for immediate use. Used by run injection and
   * webhook verification; never exposed through management APIs.
   */
  async value(opts: {
    tenantId: string;
    projectId: string;
    stage: RunStage;
    name: string;
  }): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", opts.projectId)
      .where("stage", "=", opts.stage)
      .where("name", "=", opts.name)
      .select(["name", "value", "credential_ref"])
      .executeTakeFirst();
    return row ? this.unseal({ ...opts, row }) : undefined;
  }

  private async unseal(args: {
    tenantId: string;
    projectId: string;
    stage: RunStage;
    row: { name: string; value: string | null; credential_ref: string | null };
  }): Promise<string> {
    const { row } = args;
    if (row.credential_ref) {
      if (!this.vault) throw new Error("Secret vault is not configured");
      return this.vault.withMaterial({
        tenantId: args.tenantId,
        ref: { id: row.credential_ref },
        use: (material) => new TextDecoder().decode(material),
      });
    }
    const value = row.value ?? "";
    if (this.vault) {
      await this.store({
        tenantId: args.tenantId,
        projectId: args.projectId,
        stage: args.stage,
        name: row.name,
        value,
        updatedAt: undefined,
      });
    }
    return value;
  }

  /** Write one value, sealed when a vault exists; drops a replaced record. */
  private async store(args: {
    tenantId: string;
    projectId: string;
    stage: RunStage;
    name: string;
    value: string;
    updatedAt: Date | undefined;
  }): Promise<void> {
    const sealed = this.vault
      ? await this.vault.put({
          tenantId: args.tenantId,
          material: new TextEncoder().encode(args.value),
        })
      : undefined;
    const columns = sealed
      ? { value: null, credential_ref: sealed.id }
      : { value: args.value, credential_ref: null };
    const previous = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", args.projectId)
      .where("stage", "=", args.stage)
      .where("name", "=", args.name)
      .select("credential_ref")
      .executeTakeFirst();
    await this.db
      .insertInto("project_secrets")
      .values({
        project_id: args.projectId,
        stage: args.stage,
        name: args.name,
        ...columns,
        ...(args.updatedAt ? { updated_at: args.updatedAt } : {}),
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "stage", "name"]).doUpdateSet({
          ...columns,
          ...(args.updatedAt ? { updated_at: args.updatedAt } : {}),
        }),
      )
      .execute();
    if (previous?.credential_ref && this.vault) {
      await this.vault.delete({
        tenantId: args.tenantId,
        ref: { id: previous.credential_ref },
      });
    }
  }

  private async declaredSecrets(args: {
    identity: Identity;
    projectId: string;
    purpose?: "manage" | "run";
  }): Promise<Map<string, DeclaredSecretEntry>> {
    const { identity, projectId } = args;
    const declared = new Map<string, DeclaredSecretEntry>();

    for (const secret of (await this.projectDeclarations?.({
      identity,
      projectId,
      purpose: args.purpose ?? "manage",
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
    stage: RunStage;
  }): Promise<SecretStatus[]> {
    assertProjectPermission(opts.identity, opts.projectId, "secrets:read");
    const { identity, projectId, stage } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const declared = await this.declaredSecrets({ identity, projectId });
    if (declared.size === 0) return [];

    const names = [...declared.keys()];
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("stage", "=", stage)
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
    stage: RunStage;
    name: string;
    value: string;
  }): Promise<SecretStatus> {
    assertProjectPermission(opts.identity, opts.projectId, "secrets:write");
    const { identity, projectId, stage, name, value } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const declared = await this.declaredSecrets({ identity, projectId });
    const entry = declared.get(name);
    if (!entry) {
      throw new UndeclaredSecretError(name);
    }

    const now = new Date();
    await this.store({
      tenantId: identity.tenantId,
      projectId,
      stage,
      name,
      value,
      updatedAt: now,
    });

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
    stage: RunStage;
    name: string;
  }): Promise<boolean> {
    assertProjectPermission(opts.identity, opts.projectId, "secrets:write");
    const { identity, projectId, stage, name } = opts;
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const removed = await this.db
      .deleteFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("stage", "=", stage)
      .where("name", "=", name)
      .returning("credential_ref")
      .executeTakeFirst();
    if (removed?.credential_ref && this.vault) {
      await this.vault.delete({
        tenantId: identity.tenantId,
        ref: { id: removed.credential_ref },
      });
    }
    return removed !== undefined;
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
    stage: RunStage;
  }): Promise<{
    values: Record<string, string>;
    missingRequired: string[];
  }> {
    const { identity, projectId, stage } = opts;
    const declared = await this.declaredSecrets({
      identity,
      projectId,
      purpose: "run",
    });
    if (declared.size === 0) {
      return { values: {}, missingRequired: [] };
    }

    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("stage", "=", stage)
      .where("name", "in", [...declared.keys()])
      .select(["name", "value", "credential_ref"])
      .execute();

    const stored = new Map<string, string>();
    for (const row of rows) {
      stored.set(
        row.name,
        await this.unseal({
          tenantId: identity.tenantId,
          projectId,
          stage,
          row,
        }),
      );
    }
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
