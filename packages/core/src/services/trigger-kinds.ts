import type { Json } from "@catamorphic/db";

/** How a host wants a trigger kind rendered in workflow graphs. */
export interface TriggerKindDisplay {
  label?: string;
  /** Icon name resolved against the UI's icon set (e.g. "zap", "bell"). */
  icon?: string;
  /** CSS color for the kind's badge/accents. */
  color?: string;
}

export type TriggerMode = "sync" | "async";

export type TriggerValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * A host-registered trigger kind, in core's dependency-neutral shape.
 * `@catamorphic/server-sdk` builds these from zod schemas via
 * `defineTriggerKind`; hosts may also hand-roll one.
 *
 * The JSON Schemas serve double duty: runtime metadata for HTTP surfaces,
 * and the source for the generated `catamorphic-triggers.d.ts` that project
 * workspaces type-check `trigger()` calls against.
 */
export interface TriggerKindRuntime {
  /** Unique kind name, e.g. "ticket.created". */
  name: string;
  description?: string;
  display?: TriggerKindDisplay;
  /** Fire modes the host allows for this kind. Defaults to both. */
  modes?: readonly TriggerMode[];
  payloadJsonSchema: Json;
  configJsonSchema: Json;
  validatePayload(value: Json): TriggerValidationResult;
  validateConfig(value: Json): TriggerValidationResult;
  /** Derives an enrollment correlation key from the payload (ADR 0027). */
  correlationKey?(payload: Json): string | undefined;
}

/** Static kind metadata, safe to serve over HTTP (no functions). */
export interface TriggerKindInfo {
  name: string;
  description?: string;
  display?: TriggerKindDisplay;
  modes: readonly TriggerMode[];
  payloadJsonSchema: Json;
  configJsonSchema: Json;
}

export function triggerKindInfo(kind: TriggerKindRuntime): TriggerKindInfo {
  return {
    name: kind.name,
    description: kind.description,
    display: kind.display,
    modes: kind.modes ?? ["sync", "async"],
    payloadJsonSchema: kind.payloadJsonSchema,
    configJsonSchema: kind.configJsonSchema,
  };
}

export function buildTriggerKindRegistry(
  kinds: readonly TriggerKindRuntime[],
): Map<string, TriggerKindRuntime> {
  const registry = new Map<string, TriggerKindRuntime>();
  for (const kind of kinds) {
    if (!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(kind.name)) {
      throw new Error(
        `Trigger kind name '${kind.name}' must be 1-200 characters of letters, digits, '.', '_' or '-'`,
      );
    }
    if (registry.has(kind.name)) {
      throw new Error(`Trigger kind '${kind.name}' is registered twice`);
    }
    registry.set(kind.name, kind);
  }
  return registry;
}
