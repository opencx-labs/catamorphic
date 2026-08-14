import type {
  CapabilityContext,
  CapabilityProviderRuntime,
  McpToolKindSpec,
  ProjectLifecycleHooks,
  TriggerKindRuntime,
} from "@catamorphic/core";

/**
 * Defines a host-side capability provider (ADR 0046): the fulfiller of a
 * plugin manifest's `requires` entry. `resolve` runs on the run-launch path
 * and returns env values that are merged into the run's environment and
 * never persisted — the place to mint short-lived, per-project credentials.
 *
 * Register the result under `createCatamorphic({ capabilityProviders })`,
 * or bundle it into a `definePlugin` host half.
 */
export function defineCapability(args: {
  /** Dot-namespaced name, e.g. "acme.database". */
  name: string;
  description?: string;
  resolve: (
    context: CapabilityContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
}): CapabilityProviderRuntime {
  return {
    name: args.name,
    description: args.description,
    resolve: args.resolve,
  };
}

/**
 * The host half of a plugin (ADR 0046): everything a plugin package
 * contributes that executes in the host process. Activated only by boot
 * registration — `createCatamorphic({ plugins: [myPlugin] })` — never by a
 * per-project attach. The sandbox half (client library, manifest, docs)
 * ships in the same npm package and is activated per project by attach.
 */
export interface HostPluginDefinition {
  /** Package name, used in boot-time collision errors. */
  name: string;
  capabilities?: readonly CapabilityProviderRuntime[];
  projectHooks?: ProjectLifecycleHooks;
  triggerKinds?: readonly TriggerKindRuntime[];
  mcpToolKinds?: readonly McpToolKindSpec[];
}

/**
 * Packages a plugin's host half under one name so embedders register one
 * value at boot and get providers, hooks, and trigger kinds together:
 *
 * ```ts
 * export const neonPlugin = (cfg: { apiKey: string }) =>
 *   definePlugin({
 *     name: "@acme/catamorphic-neon",
 *     capabilities: [
 *       defineCapability({
 *         name: "acme.database",
 *         resolve: async ({ projectId }) => ({
 *           DATABASE_URL: await mintScopedUrl(cfg.apiKey, projectId),
 *         }),
 *       }),
 *     ],
 *     projectHooks: {
 *       onProjectCreated: ({ project }) => provisionDb(cfg.apiKey, project.id),
 *       onProjectDeleted: ({ project }) => dropDb(cfg.apiKey, project.id),
 *     },
 *   });
 * ```
 */
export function definePlugin(
  definition: HostPluginDefinition,
): HostPluginDefinition {
  return definition;
}

export class DuplicatePluginContributionError extends Error {
  constructor(args: { kind: string; name: string; plugin: string }) {
    super(
      `Plugin '${args.plugin}' registers ${args.kind} '${args.name}', which is already registered`,
    );
    this.name = "DuplicatePluginContributionError";
  }
}

/**
 * Merge boot-time plugin host halves with the top-level config arrays.
 * Collisions (two plugins, or a plugin and the top-level config, claiming
 * the same capability or trigger-kind name) fail at boot.
 */
export function mergeHostPlugins(args: {
  plugins: readonly HostPluginDefinition[];
  capabilityProviders: readonly CapabilityProviderRuntime[];
  projectHooks: readonly ProjectLifecycleHooks[];
  triggerKinds: readonly TriggerKindRuntime[];
  mcpToolKinds: readonly McpToolKindSpec[];
}): {
  capabilityProviders: CapabilityProviderRuntime[];
  projectHooks: ProjectLifecycleHooks[];
  triggerKinds: TriggerKindRuntime[];
  mcpToolKinds: McpToolKindSpec[];
} {
  const capabilityProviders = [...args.capabilityProviders];
  const projectHooks = [...args.projectHooks];
  const triggerKinds = [...args.triggerKinds];
  const mcpToolKinds = [...args.mcpToolKinds];
  const capabilityNames = new Set(capabilityProviders.map((p) => p.name));
  const kindNames = new Set(triggerKinds.map((k) => k.name));

  for (const plugin of args.plugins) {
    for (const provider of plugin.capabilities ?? []) {
      if (capabilityNames.has(provider.name)) {
        throw new DuplicatePluginContributionError({
          kind: "capability provider",
          name: provider.name,
          plugin: plugin.name,
        });
      }
      capabilityNames.add(provider.name);
      capabilityProviders.push(provider);
    }
    for (const kind of plugin.triggerKinds ?? []) {
      if (kindNames.has(kind.name)) {
        throw new DuplicatePluginContributionError({
          kind: "trigger kind",
          name: kind.name,
          plugin: plugin.name,
        });
      }
      kindNames.add(kind.name);
      triggerKinds.push(kind);
    }
    if (plugin.projectHooks) projectHooks.push(plugin.projectHooks);
    mcpToolKinds.push(...(plugin.mcpToolKinds ?? []));
  }

  return { capabilityProviders, projectHooks, triggerKinds, mcpToolKinds };
}
