import type { CapabilityRequirement } from "@catamorphic/plugins";
import type { SecretEnvironment } from "./secrets-service.js";

/**
 * What a capability provider learns about the run it is minting values for.
 * Deliberately excludes a run id: providers resolve at launch, before the
 * run row is the run's identity (ADR 0046).
 */
export interface CapabilityContext {
  tenantId: string;
  externalUserId: string;
  projectId: string;
  environment: SecretEnvironment;
  workflowName?: string;
}

/**
 * Host-side fulfiller of a named capability (ADR 0046). Registered at boot
 * (`createCatamorphic({ capabilityProviders })` or via a plugin's host
 * half); resolved at run launch. Returned env values are merged into the
 * run's environment and never persisted. Build these with `defineCapability`
 * from `@catamorphic/server-sdk`, or hand-roll the shape.
 */
export interface CapabilityProviderRuntime {
  /** Dot-namespaced name matching a plugin manifest requirement. */
  name: string;
  description?: string;
  /**
   * Mint env values for one run. Called on the run-launch path — keep it
   * fast and safe to call repeatedly (retried launches resolve again).
   */
  resolve(
    context: CapabilityContext,
  ): Promise<Record<string, string>> | Record<string, string>;
}

export class DuplicateCapabilityProviderError extends Error {
  constructor(readonly capability: string) {
    super(`Capability provider '${capability}' is registered more than once`);
    this.name = "DuplicateCapabilityProviderError";
  }
}

export class UnfulfilledCapabilityError extends Error {
  constructor(
    readonly packageName: string,
    readonly capabilities: readonly string[],
  ) {
    super(
      `Plugin '${packageName}' requires capabilit${
        capabilities.length === 1 ? "y" : "ies"
      } with no registered provider: ${capabilities.join(", ")}. ` +
        "Register a provider at boot (createCatamorphic capabilityProviders " +
        "or a plugin's host half) before attaching.",
    );
    this.name = "UnfulfilledCapabilityError";
  }
}

export class CapabilityResolutionError extends Error {
  constructor(args: { capability: string; cause: unknown }) {
    super(
      `Capability provider '${args.capability}' failed to resolve: ${
        args.cause instanceof Error ? args.cause.message : String(args.cause)
      }`,
      { cause: args.cause },
    );
    this.name = "CapabilityResolutionError";
  }
}

export class ReservedCapabilityEnvError extends Error {
  constructor(
    readonly capability: string,
    readonly envName: string,
  ) {
    super(
      `Capability provider '${capability}' returned reserved env name ` +
        `'${envName}' (CATAMORPHIC_ prefix is runtime-owned)`,
    );
    this.name = "ReservedCapabilityEnvError";
  }
}

/**
 * The boot-time set of capability providers, keyed by name. Immutable after
 * construction; duplicate names fail at boot rather than shadowing.
 */
export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityProviderRuntime>();

  constructor(providers: readonly CapabilityProviderRuntime[] = []) {
    for (const provider of providers) {
      if (this.providers.has(provider.name)) {
        throw new DuplicateCapabilityProviderError(provider.name);
      }
      this.providers.set(provider.name, provider);
    }
  }

  get names(): ReadonlySet<string> {
    return new Set(this.providers.keys());
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Resolve a set of requirements into one env map. Non-optional
   * requirements without a provider throw (attach validation should make
   * this unreachable, but run launch fails closed regardless); optional ones
   * are skipped. Provider failures and reserved names surface as typed
   * errors so the run fails with a clear cause.
   */
  async resolveAll(
    requirements: Iterable<CapabilityRequirement>,
    context: CapabilityContext,
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const requirement of requirements) {
      const provider = this.providers.get(requirement.name);
      if (!provider) {
        if (requirement.optional) continue;
        throw new CapabilityResolutionError({
          capability: requirement.name,
          cause: new Error("no registered provider"),
        });
      }
      let values: Record<string, string>;
      try {
        values = await provider.resolve(context);
      } catch (cause) {
        throw new CapabilityResolutionError({
          capability: requirement.name,
          cause,
        });
      }
      for (const [name, value] of Object.entries(values)) {
        if (name.startsWith("CATAMORPHIC_")) {
          throw new ReservedCapabilityEnvError(requirement.name, name);
        }
        env[name] = value;
      }
    }
    return env;
  }
}
