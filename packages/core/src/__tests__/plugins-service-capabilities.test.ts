import type { DB } from "@catamorphic/db";
import type { PluginResolver } from "@catamorphic/plugins";
import { parsePluginPackageJson } from "@catamorphic/plugins";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { UnfulfilledCapabilityError } from "../services/capability-providers.js";
import { PluginsService } from "../services/plugins-service.js";

function resolverFor(manifest: Record<string, unknown>): PluginResolver {
  const parsed = parsePluginPackageJson({
    name: "@acme/db-sdk",
    catamorphic: { displayName: "Acme DB", ...manifest },
  });
  return {
    source: "local",
    list: async () => [],
    resolve: async () => ({
      packageName: parsed.name,
      version: "1.0.0",
      manifest: parsed.catamorphic,
      rootDir: "/nowhere",
    }),
    listPluginFiles: async () => ({}),
  } as unknown as PluginResolver;
}

/** Attach must fail closed before ever touching the database. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `Database reached during failed-closed attach (accessed '${String(property)}')`,
      );
    },
  },
) as Kysely<DB>;

describe("PluginsService capability validation (ADR 0046)", () => {
  it("rejects attach when a required capability has no provider", async () => {
    const service = new PluginsService(
      untouchableDb,
      resolverFor({ requires: [{ name: "acme.database" }] }),
      new Set(),
    );
    await expect(service.attach("p1", "@acme/db-sdk")).rejects.toThrow(
      UnfulfilledCapabilityError,
    );
  });

  it("names every unfulfilled capability in the error", async () => {
    const service = new PluginsService(
      untouchableDb,
      resolverFor({
        requires: [
          { name: "acme.database" },
          { name: "acme.cache" },
          { name: "acme.metrics", optional: true },
        ],
      }),
      new Set(["acme.cache"]),
    );
    const error = await service
      .attach("p1", "@acme/db-sdk")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnfulfilledCapabilityError);
    expect((error as UnfulfilledCapabilityError).capabilities).toEqual([
      "acme.database",
    ]);
  });

  it("does not block attach on optional unfulfilled capabilities", async () => {
    const service = new PluginsService(
      untouchableDb,
      resolverFor({ requires: [{ name: "acme.metrics", optional: true }] }),
      new Set(),
    );
    // Validation passes and the service proceeds to the DB layer, which is
    // deliberately unreachable in this unit test.
    await expect(service.attach("p1", "@acme/db-sdk")).rejects.toThrow(
      /Database reached/,
    );
  });
});
