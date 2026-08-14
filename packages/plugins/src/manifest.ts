import { z } from "zod";

/**
 * Schema for a single secret declared by a plugin package. Catamorphic uses
 * these entries to render per-plugin secret forms in the dashboard and to
 * validate incoming secret writes.
 */
export const PluginSecretSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[A-Z][A-Z0-9_]*$/,
      "Secret names must be SCREAMING_SNAKE_CASE env-var style.",
    )
    .refine(
      (name) => !name.startsWith("CATAMORPHIC_"),
      "Secret names must not use the reserved CATAMORPHIC_ prefix.",
    ),
  label: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export type PluginSecret = z.infer<typeof PluginSecretSchema>;

/**
 * Schema for the `docs` block that tells the coding agent where to find the
 * package's human-readable narrative and TypeScript declarations.
 */
export const PluginDocsSchema = z.object({
  readme: z.string().default("README.md"),
  types: z.string().default("dist/index.d.ts"),
});

export type PluginDocs = z.infer<typeof PluginDocsSchema>;

const PluginBatchSchemaPathsSchema = z.record(z.string(), z.string().min(1));

export const PluginBatchSourceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(""),
  exportName: z.string().min(1),
  execution: z.enum(["host", "sandbox"]),
  consistency: z.array(z.enum(["snapshot", "bounded", "best_effort"])).min(1),
  schemas: PluginBatchSchemaPathsSchema,
});

export const PluginBatchSinkSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(""),
  exportName: z.string().min(1),
  execution: z.enum(["host", "sandbox"]),
  schemas: PluginBatchSchemaPathsSchema,
});

export const PluginBatchCapabilitiesSchema = z.object({
  contractVersion: z.literal(1),
  sources: z.array(PluginBatchSourceSchema).default([]),
  sinks: z.array(PluginBatchSinkSchema).default([]),
});

export type PluginBatchSource = z.infer<typeof PluginBatchSourceSchema>;
export type PluginBatchSink = z.infer<typeof PluginBatchSinkSchema>;
export type PluginBatchCapabilities = z.infer<
  typeof PluginBatchCapabilitiesSchema
>;

/**
 * A capability the plugin's sandbox code needs the host to fulfill at run
 * time (ADR 0046). Names are dot-namespaced like trigger kinds
 * ("acme.database"). The host registers a matching capability provider at
 * boot; attaching a plugin whose non-optional requirement has no registered
 * provider fails closed.
 */
export const CapabilityRequirementSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
      "Capability names must be dot-namespaced lowercase, e.g. 'acme.database'.",
    ),
  description: z.string().default(""),
  /**
   * Optional requirements don't block attach when unregistered; the plugin's
   * code must degrade gracefully when the capability's env is absent.
   */
  optional: z.boolean().default(false),
});

export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

/**
 * Schema for the `catamorphic` field on a plugin's `package.json`. This is the
 * only contract a plugin package has to honor to be usable inside Catamorphic.
 */
export const PluginManifestSchema = z.object({
  displayName: z.string().min(1),
  description: z.string().default(""),
  secrets: z.array(PluginSecretSchema).default([]),
  requires: z.array(CapabilityRequirementSchema).default([]),
  batch: PluginBatchCapabilitiesSchema.optional(),
  docs: PluginDocsSchema.default({
    readme: "README.md",
    types: "dist/index.d.ts",
  }),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * Shape of the relevant bits of a plugin's `package.json`. Catamorphic reads
 * `name` to identify the package and `catamorphic` for the manifest.
 */
export const PluginPackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  catamorphic: PluginManifestSchema,
});

export type PluginPackageJson = z.infer<typeof PluginPackageJsonSchema>;

export function parsePluginPackageJson(input: unknown): PluginPackageJson {
  return PluginPackageJsonSchema.parse(input);
}
