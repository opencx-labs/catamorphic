import type {
  CapabilityContext,
  CapabilityProviderRuntime,
  ConnectionProvider,
  HostCallFunction,
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
 * `calls` (ADR 0055) are host functions a workflow reaches as
 * `context.host.<name>.<fn>(args)`: each runs on the host with the run's
 * caller attached by core (`{ caller, projectId, runId, workflowName }`) —
 * a workflow cannot claim to be anyone — and its result feeds the next
 * step. Either or both of `resolve` / `calls` may be given.
 *
 * Register the result under `createCatamorphic({ capabilityProviders })`,
 * or bundle it into a `definePlugin` host half.
 */
export function defineCapability(args: {
  /** Dot-namespaced name, e.g. "acme.database". */
  name: string;
  description?: string;
  resolve?: (
    context: CapabilityContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
  calls?: Record<string, HostCallFunction>;
}): CapabilityProviderRuntime {
  return {
    name: args.name,
    description: args.description,
    ...(args.resolve ? { resolve: args.resolve } : {}),
    ...(args.calls ? { calls: args.calls } : {}),
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
  /** Host-side credential providers contributed by this plugin. */
  connections?: readonly ConnectionProvider[];
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
  connectionProviders: readonly ConnectionProvider[];
}): {
  capabilityProviders: CapabilityProviderRuntime[];
  projectHooks: ProjectLifecycleHooks[];
  triggerKinds: TriggerKindRuntime[];
  mcpToolKinds: McpToolKindSpec[];
  connectionProviders: ConnectionProvider[];
} {
  const capabilityProviders = [...args.capabilityProviders];
  const projectHooks = [...args.projectHooks];
  const triggerKinds = [...args.triggerKinds];
  const mcpToolKinds = [...args.mcpToolKinds];
  const connectionProviders = [...args.connectionProviders];
  const capabilityNames = new Set(capabilityProviders.map((p) => p.name));
  const kindNames = new Set(triggerKinds.map((k) => k.name));
  const connectionKinds = new Set(connectionProviders.map((p) => p.kind));

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
    for (const provider of plugin.connections ?? []) {
      if (connectionKinds.has(provider.kind)) {
        throw new DuplicatePluginContributionError({
          kind: "connection provider",
          name: provider.kind,
          plugin: plugin.name,
        });
      }
      connectionKinds.add(provider.kind);
      connectionProviders.push(provider);
    }
    if (plugin.projectHooks) projectHooks.push(plugin.projectHooks);
    mcpToolKinds.push(...(plugin.mcpToolKinds ?? []));
  }

  return {
    capabilityProviders,
    projectHooks,
    triggerKinds,
    mcpToolKinds,
    connectionProviders,
  };
}
