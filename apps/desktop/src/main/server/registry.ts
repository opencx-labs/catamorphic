import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  defineRegistryCapability,
  parseRegistryCatalog,
} from "@catamorphic/core";

/** The packs the desktop ships: the `@catamorphic/registry` build (ADR 0262). */
export const registryCapability = defineRegistryCapability({
  catalog: async () =>
    parseRegistryCatalog(
      await readFile(
        createRequire(import.meta.url).resolve(
          "@catamorphic/registry/catalog.json",
        ),
        "utf8",
      ),
    ),
});
