import type { Json } from "@catamorphic/db";
import { unsupportedHoleErrors } from "@catamorphic/parser";

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
  /**
   * May contain `x-catamorphic-hole` positions (ADR 0042): a parameterized
   * kind leaves those open and each bound workflow's input type fills them.
   * The matching validator accepts anything at a hole — the per-run input
   * validation enforces the workflow's own derived schema there.
   */
  payloadJsonSchema: Json;
  configJsonSchema: Json;
  /**
   * Output template the kind demands of subscribed workflows (may contain
   * holes). Enforced at authoring time by the generated types; surfaced
   * here for introspection and codegen.
   */
  outputJsonSchema?: Json;
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
  outputJsonSchema?: Json;
}

export function triggerKindInfo(kind: TriggerKindRuntime): TriggerKindInfo {
  return {
    name: kind.name,
    description: kind.description,
    display: kind.display,
    modes: kind.modes ?? ["sync", "async"],
    payloadJsonSchema: kind.payloadJsonSchema,
    configJsonSchema: kind.configJsonSchema,
    ...(kind.outputJsonSchema !== undefined
      ? { outputJsonSchema: kind.outputJsonSchema }
      : {}),
  };
}

/**
 * The shared poll tool every Catamorphic MCP surface serves beside its real
 * tools. Reserved: a binding's effective tool name may not claim it (the
 * scan rejects the commit). Duplicated by hand in `@catamorphic/app`'s
 * guest adapter, which cannot depend on core.
 */
export const MCP_POLL_RUN_TOOL = "catamorphic_poll_run";

/** Tool metadata an MCP surface derives from a binding's constant config. */
export interface McpToolMetadata {
  /** Tool name; defaults to the bound workflow's name. */
  name?: string;
  /** The description the model reads. */
  description: string;
  /** MCP tool annotations (readOnlyHint, destructiveHint, …). */
  annotations?: Record<string, Json>;
}

/**
 * Declares that bindings of a trigger kind are AI-callable tools, and how
 * to read tool metadata out of each binding's config. Hosts register these
 * beside their kinds; the per-project MCP endpoint serves one tool per
 * binding of every registered tool kind.
 */
export interface McpToolKindSpec {
  kind: string;
  tool(config: Json): McpToolMetadata;
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
    // Fail at registration, not per binding: a hole the scan could never
    // resolve (union arm, additionalProperties, …) is a kind-authoring
    // error, and the generated types would still render it as Hole<>.
    for (const error of [
      ...unsupportedHoleErrors(kind.payloadJsonSchema),
      ...(kind.outputJsonSchema !== undefined
        ? unsupportedHoleErrors(kind.outputJsonSchema)
        : []),
    ]) {
      throw new Error(`Trigger kind '${kind.name}': ${error}`);
    }
    registry.set(kind.name, kind);
  }
  return registry;
}
