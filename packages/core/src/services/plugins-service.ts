import type { DB } from "@catamorphic/db";
import type {
  PluginManifest,
  PluginResolver,
  PluginSecret,
  ResolvedPlugin,
} from "@catamorphic/plugins";
import { PluginResolutionError } from "@catamorphic/plugins";
import type { Kysely } from "kysely";

/**
 * Public shape used by API responses. Wraps {@link PluginManifest} with the
 * resolved package metadata so clients don't need to know about the resolver.
 */
export interface PluginInfo {
  packageName: string;
  version: string | null;
  source: "local" | "npm" | "git";
  displayName: string;
  description: string;
  secrets: Array<{
    name: string;
    label: string;
    description: string;
    required: boolean;
    default: string | null;
  }>;
}

export interface AttachedPluginInfo extends PluginInfo {
  attachedAt: string;
  secretStatus: Array<{
    name: string;
    hasValue: boolean;
    required: boolean;
  }>;
}

export class PluginNotAttachedError extends Error {
  constructor(
    readonly projectId: string,
    readonly packageName: string,
  ) {
    super(`Plugin '${packageName}' is not attached to project '${projectId}'.`);
    this.name = "PluginNotAttachedError";
  }
}

export class UndeclaredSecretError extends Error {
  constructor(readonly secretName: string) {
    super(
      `Secret '${secretName}' is not declared by any attached plugin's manifest.`,
    );
    this.name = "UndeclaredSecretError";
  }
}

/**
 * Service that bridges the {@link PluginResolver} (file-system / future
 * registries) and the per-project plugin + secret tables.
 */
export class PluginsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly resolver: PluginResolver,
  ) {}

  async listCatalog(): Promise<PluginInfo[]> {
    const plugins = await this.resolver.list();
    return plugins.map((p) => this.toInfo(p));
  }

  async listAttached(projectId: string): Promise<AttachedPluginInfo[]> {
    const rows = await this.db
      .selectFrom("project_plugins")
      .where("project_id", "=", projectId)
      .selectAll()
      .execute();

    const attached: AttachedPluginInfo[] = [];
    for (const row of rows) {
      const resolved = await this.safeResolve(row.package_name);
      if (!resolved) continue;
      const secretStatus = await this.getSecretStatus(
        projectId,
        resolved.manifest.secrets,
      );
      attached.push({
        ...this.toInfo(resolved),
        attachedAt: row.created_at.toISOString(),
        secretStatus,
      });
    }
    return attached;
  }

  async attach(
    projectId: string,
    packageName: string,
  ): Promise<AttachedPluginInfo> {
    const resolved = await this.resolver.resolve(packageName);

    await this.db
      .insertInto("project_plugins")
      .values({
        project_id: projectId,
        package_name: resolved.packageName,
        source: this.resolver.source,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "package_name"]).doNothing(),
      )
      .execute();

    const row = await this.db
      .selectFrom("project_plugins")
      .where("project_id", "=", projectId)
      .where("package_name", "=", resolved.packageName)
      .selectAll()
      .executeTakeFirstOrThrow();

    const secretStatus = await this.getSecretStatus(
      projectId,
      resolved.manifest.secrets,
    );

    return {
      ...this.toInfo(resolved),
      attachedAt: row.created_at.toISOString(),
      secretStatus,
    };
  }

  async detach(projectId: string, packageName: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("project_plugins")
      .where("project_id", "=", projectId)
      .where("package_name", "=", packageName)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async loadAttachedResolved(projectId: string): Promise<ResolvedPlugin[]> {
    const rows = await this.db
      .selectFrom("project_plugins")
      .where("project_id", "=", projectId)
      .select("package_name")
      .execute();
    const resolved: ResolvedPlugin[] = [];
    for (const row of rows) {
      const plugin = await this.safeResolve(row.package_name);
      if (plugin) resolved.push(plugin);
    }
    return resolved;
  }

  async getDeclaredSecrets(
    projectId: string,
  ): Promise<Map<string, PluginSecret>> {
    const plugins = await this.loadAttachedResolved(projectId);
    const declared = new Map<string, PluginSecret>();
    for (const plugin of plugins) {
      for (const secret of plugin.manifest.secrets) {
        if (!declared.has(secret.name)) declared.set(secret.name, secret);
      }
    }
    return declared;
  }

  private async safeResolve(
    packageName: string,
  ): Promise<ResolvedPlugin | null> {
    try {
      return await this.resolver.resolve(packageName);
    } catch (err) {
      if (err instanceof PluginResolutionError) return null;
      throw err;
    }
  }

  private toInfo(plugin: ResolvedPlugin): PluginInfo {
    return {
      packageName: plugin.packageName,
      version: plugin.version,
      source: this.resolver.source,
      displayName: plugin.manifest.displayName,
      description: plugin.manifest.description,
      secrets: plugin.manifest.secrets.map(toSecretDto),
    };
  }

  private async getSecretStatus(
    projectId: string,
    secrets: PluginManifest["secrets"],
  ): Promise<AttachedPluginInfo["secretStatus"]> {
    if (secrets.length === 0) return [];
    const names = secrets.map((s) => s.name);
    const rows = await this.db
      .selectFrom("project_secrets")
      .where("project_id", "=", projectId)
      .where("environment", "=", "production")
      .where("name", "in", names)
      .select(["name"])
      .execute();
    const present = new Set(rows.map((r) => r.name));
    return secrets.map((s) => ({
      name: s.name,
      hasValue: present.has(s.name),
      required: s.required,
    }));
  }
}

function toSecretDto(secret: PluginSecret) {
  return {
    name: secret.name,
    label: secret.label,
    description: secret.description,
    required: secret.required,
    default: secret.default ?? null,
  };
}
