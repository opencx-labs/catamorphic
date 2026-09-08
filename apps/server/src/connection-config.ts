import fs from "node:fs";
import type { ConnectionProvider } from "@catamorphic/core";
import { defineMcpConnectionProvider } from "@catamorphic/mcp";
import { z } from "zod";

const Config = z.array(
  z.strictObject({
    kind: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    displayName: z.string().min(1),
    url: z.url(),
    transport: z.enum(["http", "sse"]).default("http"),
  }),
);

/** Host-owned endpoints. Member grants and credentials remain in shared state. */
export function loadStockConnectionProviders(args: {
  path?: string;
}): readonly ConnectionProvider[] {
  if (!args.path) return [];
  return Config.parse(JSON.parse(fs.readFileSync(args.path, "utf8"))).map(
    (entry) => {
      const provider = defineMcpConnectionProvider({
        kind: entry.kind,
        displayName: entry.displayName,
        server: { transport: entry.transport, url: entry.url },
      });
      return {
        ...provider,
        listActions: async (
          input: Parameters<typeof provider.listActions>[0],
        ) =>
          (await provider.listActions(input)).map((action) => ({
            ...action,
            inputSchema: z.json().parse(action.inputSchema),
            annotations: action.annotations
              ? z.json().parse(action.annotations)
              : undefined,
          })),
        invoke: async (input: Parameters<typeof provider.invoke>[0]) =>
          z.json().parse(await provider.invoke(input)),
      };
    },
  );
}
