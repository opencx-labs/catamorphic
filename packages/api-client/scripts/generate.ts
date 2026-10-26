import { writeFile } from "node:fs/promises";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import ts from "typescript";

const ast = await openapiTS(new URL("../openapi.json", import.meta.url), {
  // Indexed references back into the same schema property are illegal in
  // TypeScript. Reuse the protocol's JSON value at this wire boundary.
  inject: 'import type { JsonValue } from "@catamorphic/agent-protocol";',
  transform(_schema, options) {
    if (
      /^#\/components\/schemas\/(?:Protocol)?JsonValue(?:Input)?$/.test(
        options.path ?? "",
      )
    )
      return ts.factory.createTypeReferenceNode("JsonValue");
  },
});

await writeFile(
  new URL("../src/schema.d.ts", import.meta.url),
  COMMENT_HEADER + astToString(ast),
);
