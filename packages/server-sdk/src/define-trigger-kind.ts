import type {
  TriggerKindDisplay,
  TriggerKindRuntime,
  TriggerMode,
  TriggerValidationResult,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import { z } from "zod";

/**
 * A registered trigger kind carrying its payload and config types. Passing
 * the definition value (not its name) to `scoped.triggers.fire`/`list` is
 * what makes those calls typed by construction.
 */
export interface TriggerKindDefinition<Payload, Config>
  extends TriggerKindRuntime {
  /** Phantom carriers — never set at runtime. */
  readonly __payload?: Payload;
  readonly __config?: Config;
}

/**
 * Defines a custom trigger kind from zod schemas. The schemas are the single
 * source of truth: they validate payloads at fire time and configs at scan
 * time, and they generate the `catamorphic-triggers.d.ts` module that
 * project workspaces type-check `trigger()` calls against.
 */
export function defineTriggerKind<
  PayloadSchema extends z.ZodType,
  ConfigSchema extends z.ZodType = z.ZodObject<Record<string, never>>,
>(args: {
  /** Unique kind name, e.g. "ticket.created". */
  name: string;
  /** Shown to workflow authors in the generated types and to UIs. */
  description?: string;
  /** How graphs render workflows bound to this kind. */
  display?: TriggerKindDisplay;
  /** Fire modes the host allows. Defaults to both sync and async. */
  modes?: readonly TriggerMode[];
  /** What the host fires with — delivered verbatim as the workflow input. */
  payload: PayloadSchema;
  /** Per-workflow constant config the kind demands of subscribers. */
  config?: ConfigSchema;
  /** Derives an enrollment correlation key from a validated payload. */
  correlationKey?: (payload: z.output<PayloadSchema>) => string | undefined;
}): TriggerKindDefinition<z.output<PayloadSchema>, z.output<ConfigSchema>> {
  // Strict: a kind that declares no config should reject a workflow that
  // passes one — that binding is almost certainly a mistake.
  const configSchema: z.ZodType = args.config ?? z.strictObject({});
  return {
    name: args.name,
    description: args.description,
    display: args.display,
    modes: args.modes,
    payloadJsonSchema: toJsonSchema(args.payload),
    configJsonSchema: toJsonSchema(configSchema),
    validatePayload: (value) => validate(args.payload, value),
    validateConfig: (value) => validate(configSchema, value),
    correlationKey: args.correlationKey
      ? (payload) => args.correlationKey?.(payload as z.output<PayloadSchema>)
      : undefined,
  };
}

function toJsonSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: "input" }) as Json;
}

function validate(schema: z.ZodType, value: Json): TriggerValidationResult {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true };
  return {
    ok: false,
    errors: result.error.issues.map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    ),
  };
}
