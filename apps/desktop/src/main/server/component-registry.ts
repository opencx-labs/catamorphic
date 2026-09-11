import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { defineAgentCapability } from "@catamorphic/core";
import { z } from "zod";

const Item = z
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

/** The same installable manifests served to shadcn, with no project writes. */
export async function readComponentRegistry({ name }: { name?: string }) {
  const require = createRequire(import.meta.url);
  const catalog = z
    .array(Item)
    .parse(
      JSON.parse(
        await readFile(
          require.resolve("@catamorphic/registry/catalog.json"),
          "utf8",
        ),
      ),
    );
  if (!name)
    return catalog.map(({ name, title, description, type }) => ({
      name,
      type,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    }));
  const item = catalog.find((item) => item.name === name);
  if (!item)
    throw new Error(
      `No component pack named '${name}'. List the registry to discover available items.`,
    );
  return item;
}

export const componentRegistryCapability = defineAgentCapability({
  name: "components.read",
  description:
    "List the host's installable component registry, or fetch a pack by name with editable source, dependencies and usage notes. For code reviews fetch code-review unless suitable project components already exist. Follow user/project registry instructions first. Copy and adapt files into a project or a temporary app's explicit source snapshot. This only reads shipped public components; it does not install, build or publish.",
  effect: "read",
  inputSchema: z.object({ name: z.string().min(1).optional() }).strict(),
  outputSchema: z.union([
    z.array(
      Item.pick({ name: true, title: true, description: true, type: true }),
    ),
    Item,
  ]),
  authorize: () => true,
  execute: (_context, input) => readComponentRegistry(input),
});
