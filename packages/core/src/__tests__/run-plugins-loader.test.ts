import type { PluginResolver, ResolvedPlugin } from "@catamorphic/plugins";
import { parsePluginPackageJson } from "@catamorphic/plugins";
import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../services/capability-providers.js";
import type { PluginsService } from "../services/plugins-service.js";
import { RunPluginsLoader } from "../services/run-plugins-loader.js";
import type { SecretsService } from "../services/secrets-service.js";

const identity = { tenantId: "t1", externalUserId: "alice" };

function resolvedPlugin(manifest: Record<string, unknown>): ResolvedPlugin {
  const parsed = parsePluginPackageJson({
    name: "@acme/db-sdk",
    catamorphic: { displayName: "Acme DB", ...manifest },
  });
  return {
    packageName: parsed.name,
    version: "1.0.0",
    manifest: parsed.catamorphic,
    rootDir: "/nowhere",
  };
}

function loaderWith(args: {
  plugins: ResolvedPlugin[];
  stored: Record<string, string>;
  missingRequired?: string[];
  registry?: CapabilityRegistry;
}): RunPluginsLoader {
  const plugins = {
    loadAttachedResolved: async () => args.plugins,
  } as unknown as PluginsService;
  const secrets = {
    loadForRun: async () => ({
      values: args.stored,
      missingRequired: args.missingRequired ?? [],
    }),
  } as unknown as SecretsService;
  const resolver = {
    listPluginFiles: async () => ({ "package.json": "{}" }),
  } as unknown as PluginResolver;
  return new RunPluginsLoader(plugins, secrets, resolver, args.registry);
}

describe("RunPluginsLoader bindings chain", () => {
  it("provider values override stored secrets (ADR 0046 precedence)", async () => {
    const loader = loaderWith({
      plugins: [
        resolvedPlugin({
          requires: [{ name: "acme.database" }],
        }),
      ],
      stored: { DB_URL: "postgres://stale-user-typed", OTHER: "kept" },
      registry: new CapabilityRegistry([
        {
          name: "acme.database",
          resolve: () => ({ DB_URL: "postgres://host-minted" }),
        },
      ]),
    });
    const bundle = await loader.load({
      identity,
      projectId: "p1",
      stage: "production",
      workflowName: "welcome",
    });
    expect(bundle.secrets).toEqual({
      DB_URL: "postgres://host-minted",
      OTHER: "kept",
    });
  });

  it("a provider-minted value satisfies a missing required secret", async () => {
    const loader = loaderWith({
      plugins: [
        resolvedPlugin({
          secrets: [{ name: "DB_URL", label: "Database URL" }],
          requires: [{ name: "acme.database" }],
        }),
      ],
      stored: {},
      missingRequired: ["DB_URL", "STILL_MISSING"],
      registry: new CapabilityRegistry([
        {
          name: "acme.database",
          resolve: () => ({ DB_URL: "postgres://host-minted" }),
        },
      ]),
    });
    const bundle = await loader.load({
      identity,
      projectId: "p1",
      stage: "production",
    });
    expect(bundle.missingRequiredSecrets).toEqual(["STILL_MISSING"]);
    expect(bundle.secrets.DB_URL).toBe("postgres://host-minted");
  });

  it("passes the run context (including workflowName) to providers", async () => {
    const contexts: unknown[] = [];
    const loader = loaderWith({
      plugins: [resolvedPlugin({ requires: [{ name: "acme.database" }] })],
      stored: {},
      registry: new CapabilityRegistry([
        {
          name: "acme.database",
          resolve: (ctx) => {
            contexts.push(ctx);
            return {};
          },
        },
      ]),
    });
    await loader.load({
      identity,
      projectId: "p1",
      stage: "production",
      workflowName: "welcome",
    });
    expect(contexts).toEqual([
      {
        tenantId: "t1",
        externalUserId: "alice",
        projectId: "p1",
        stage: "production",
        workflowName: "welcome",
      },
    ]);
  });

  it("loads without a registry when no plugin requires capabilities", async () => {
    const loader = loaderWith({
      plugins: [resolvedPlugin({})],
      stored: { KEY: "v" },
    });
    const bundle = await loader.load({
      identity,
      projectId: "p1",
      stage: "production",
    });
    expect(bundle.secrets).toEqual({ KEY: "v" });
  });
});
