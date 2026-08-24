import type { PluginResolver, ResolvedPlugin } from "@catamorphic/plugins";
import type { RunPluginPayload } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import type { CapabilityRegistry } from "./capability-providers.js";
import type { PluginsService } from "./plugins-service.js";
import type { RunStage, SecretsService } from "./secrets-service.js";

export interface RunPluginBundle {
  plugins: RunPluginPayload[];
  /**
   * The run's injected env: the bindings chain resolved per ADR 0046 —
   * capability provider values override stored secrets, which override
   * manifest defaults.
   */
  secrets: Record<string, string>;
  missingRequiredSecrets: string[];
}

/**
 * Produce a snapshot of the plugin files + env bindings that should be
 * materialized inside the sandbox for a single run. Decouples the
 * `PluginResolver` (I/O against disk / registry / git) from the run executor.
 */
export class RunPluginsLoader {
  constructor(
    private readonly plugins: PluginsService,
    private readonly secrets: SecretsService,
    private readonly resolver: PluginResolver,
    private readonly capabilities?: CapabilityRegistry,
  ) {}

  async load(opts: {
    identity: Identity;
    projectId: string;
    stage: RunStage;
    workflowName?: string;
  }): Promise<RunPluginBundle> {
    const { identity, projectId, stage, workflowName } = opts;
    const attached = await this.plugins.loadAttachedResolved(projectId);
    const payloads = await Promise.all(
      attached.map((plugin) => this.buildPayload(plugin)),
    );
    const { values, missingRequired } = await this.secrets.loadForRun({
      identity,
      projectId,
      stage,
    });

    const capabilityEnv = await this.resolveCapabilities({
      attached,
      identity,
      projectId,
      stage,
      workflowName,
    });

    return {
      plugins: payloads,
      secrets: { ...values, ...capabilityEnv },
      // A provider that mints a declared secret's value (e.g. DB_URL both
      // declared by the plugin and fulfilled by the host) satisfies it.
      missingRequiredSecrets: missingRequired.filter(
        (name) => capabilityEnv[name] === undefined,
      ),
    };
  }

  private async resolveCapabilities(args: {
    attached: ResolvedPlugin[];
    identity: Identity;
    projectId: string;
    stage: RunStage;
    workflowName?: string;
  }): Promise<Record<string, string>> {
    if (!this.capabilities) return {};
    const requirements = new Map<
      string,
      ResolvedPlugin["manifest"]["requires"][number]
    >();
    for (const plugin of args.attached) {
      for (const requirement of plugin.manifest.requires) {
        const existing = requirements.get(requirement.name);
        if (!existing || (existing.optional && !requirement.optional)) {
          requirements.set(requirement.name, requirement);
        }
      }
    }
    if (requirements.size === 0) return {};
    return this.capabilities.resolveAll(requirements.values(), {
      tenantId: args.identity.tenantId,
      externalUserId: args.identity.externalUserId,
      projectId: args.projectId,
      stage: args.stage,
      workflowName: args.workflowName,
    });
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
