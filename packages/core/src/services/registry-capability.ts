import { z } from "zod";
import { defineAgentCapability } from "./agent-capabilities-service.js";

/**
 * One installable pack in the shadcn registry item format: UI components,
 * or a project recipe such as pull request reviews, as files with their
 * targets, dependencies and docs (ADR 0262).
 */
export const RegistryItemSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    docs: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
    devDependencies: z.array(z.string()).optional(),
    registryDependencies: z.array(z.string()).optional(),
    files: z.array(
      z.object({
        path: z.string(),
        type: z.string(),
        target: z.string().optional(),
        content: z.string(),
      }),
    ),
  })
  .passthrough();
export type RegistryItem = z.infer<typeof RegistryItemSchema>;

/**
 * `registry.read`: the host's installable packs, listed or fetched by name
 * (ADR 0262). The host supplies its catalog (the `@catamorphic/registry`
 * build, its own packs, or both). It only reads: the agent copies the files
 * into the project or a temporary app, follows the docs, and adapts them.
 */
export function defineRegistryCapability(args: {
  catalog: () => Promise<readonly RegistryItem[]>;
}) {
  return defineAgentCapability({
    revision: "1",
    name: "registry.read",
    description:
      "List the installable packs (UI components, and project recipes such as pull request reviews and Slack threads), or fetch one by name with its files, dependencies and docs. Copy the files to their targets in the project, or into a temporary app, follow the docs, and adapt them; this reads and writes nothing.",
    effect: "read",
    inputSchema: z.object({ name: z.string().min(1).optional() }).strict(),
    outputSchema: z.union([
      z.array(
        RegistryItemSchema.pick({
          name: true,
          title: true,
          description: true,
          type: true,
        }),
      ),
      RegistryItemSchema,
    ]),
    authorize: () => true,
    execute: async (_context, input) => {
      const catalog = await args.catalog();
      if (!input.name)
        return catalog.map(({ name, title, description, type }) => ({
          name,
          type,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        }));
      const item = catalog.find((entry) => entry.name === input.name);
      if (!item)
        throw new Error(
          `No pack named '${input.name}'. Call registry.read with no name to list them.`,
        );
      return item;
    },
  });
}

/** Read and check a registry catalog file (`dist/catalog.json`). */
export function parseRegistryCatalog(raw: string): RegistryItem[] {
  return z.array(RegistryItemSchema).parse(JSON.parse(raw));
}
