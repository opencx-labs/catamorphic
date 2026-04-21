import type { CatamorphicCore } from "@catamorphic/core";
import { createCatamorphicCore } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { TenantScopedClient } from "./scoped-client.js";

export interface CreateCatamorphicConfig {
  /**
   * Host-owned Kysely instance pointed at catamorphic's schema (usually
   * `catamorphic`). Catamorphic will never call `destroy()` on this; the host
   * owns the connection's lifetime.
   */
  db: Kysely<DB>;
  /**
   * Storage backend for project git repos. Typically
   * `new ProjectManager(new FsBackend(...), new FsRemoteBackend(...))`; more
   * backends (S3, Daytona volumes) can be dropped in without changes here.
   */
  projectManager: ProjectManager;
  /**
   * Required once the host uses run execution. v1 SDK surface doesn't call
   * into the sandbox, so this is optional for read-only embedders.
   */
  sandboxProvider?: SandboxProvider;
  /**
   * Required once the host uses plugins + secrets. v1 SDK surface doesn't
   * expose plugin mutations, so this is optional.
   */
  pluginResolver?: PluginResolver;
}

/**
 * Library-direct entry point for embedding catamorphic. Hosts construct this
 * once at boot and keep it around for the process lifetime. Identity is bound
 * per-request via `forTenant(orgId).forUser(userId)`.
 */
export class Catamorphic {
  readonly core: CatamorphicCore;

  constructor(config: CreateCatamorphicConfig | { core: CatamorphicCore }) {
    this.core = "core" in config ? config.core : createCatamorphicCore(config);
  }

  /**
   * Bind the tenant (host's org id). Returns an intermediate client that
   * still needs a user id via `.forUser(externalUserId)`.
   */
  forTenant(tenantId: string): TenantScopedClient {
    return new TenantScopedClient(this.core, tenantId);
  }
}

/**
 * Convenience factory so hosts can do
 * `const cat = createCatamorphic({ db, projectManager, ... })`.
 */
export function createCatamorphic(
  config: CreateCatamorphicConfig | { core: CatamorphicCore },
): Catamorphic {
  return new Catamorphic(config);
}
