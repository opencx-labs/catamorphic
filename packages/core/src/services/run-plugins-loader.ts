import type { PluginResolver, ResolvedPlugin } from "@catamorphic/plugins";
import type { RunPluginPayload } from "@catamorphic/sandbox";
import type { PluginsService } from "./plugins-service.js";
import type { SecretEnvironment, SecretsService } from "./secrets-service.js";

export interface RunPluginBundle {
  plugins: RunPluginPayload[];
  secrets: Record<string, string>;
  missingRequiredSecrets: string[];
}

/**
 * Produce a snapshot of the plugin files + secret env vars that should be
 * materialized inside the sandbox for a single run. Decouples the
 * `PluginResolver` (I/O against disk / registry / git) from the run executor.
 */
export class RunPluginsLoader {
  constructor(
    private readonly plugins: PluginsService,
    private readonly secrets: SecretsService,
    private readonly resolver: PluginResolver,
  ) {}

  async load(opts: {
    projectId: string;
    environment: SecretEnvironment;
  }): Promise<RunPluginBundle> {
    const { projectId, environment } = opts;
    const attached = await this.plugins.loadAttachedResolved(projectId);
    const payloads = await Promise.all(
      attached.map((plugin) => this.buildPayload(plugin)),
    );
    const { values, missingRequired } = await this.secrets.loadForRun({
      projectId,
      environment,
    });
    return {
      plugins: payloads,
      secrets: values,
      missingRequiredSecrets: missingRequired,
    };
  }

  private async buildPayload(
    plugin: ResolvedPlugin,
  ): Promise<RunPluginPayload> {
    const files = await this.resolver.listPluginFiles(plugin);
    return {
      packageName: plugin.packageName,
      files,
    };
  }
}
