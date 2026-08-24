import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  CapabilityResolutionError,
  DuplicateCapabilityProviderError,
  ReservedCapabilityEnvError,
} from "../services/capability-providers.js";

const context = {
  tenantId: "t1",
  externalUserId: "alice",
  projectId: "p1",
  stage: "production" as const,
  workflowName: "welcome",
};

describe("CapabilityRegistry", () => {
  it("rejects duplicate provider names at construction", () => {
    expect(
      () =>
        new CapabilityRegistry([
          { name: "acme.database", resolve: () => ({}) },
          { name: "acme.database", resolve: () => ({}) },
        ]),
    ).toThrow(DuplicateCapabilityProviderError);
  });

  it("resolves requirements into one env map with full context", async () => {
    const seen: unknown[] = [];
    const registry = new CapabilityRegistry([
      {
        name: "acme.database",
        resolve: (ctx) => {
          seen.push(ctx);
          return { DB_URL: `postgres://db-${ctx.projectId}` };
        },
      },
      { name: "acme.cache", resolve: () => ({ CACHE_URL: "redis://x" }) },
    ]);
    const env = await registry.resolveAll(
      [
        { name: "acme.database", description: "", optional: false },
        { name: "acme.cache", description: "", optional: false },
      ],
      context,
    );
    expect(env).toEqual({
      DB_URL: "postgres://db-p1",
      CACHE_URL: "redis://x",
    });
    expect(seen).toEqual([context]);
  });

  it("skips optional requirements with no provider, fails non-optional ones", async () => {
    const registry = new CapabilityRegistry([]);
    await expect(
      registry.resolveAll(
        [{ name: "acme.optional", description: "", optional: true }],
        context,
      ),
    ).resolves.toEqual({});
    await expect(
      registry.resolveAll(
        [{ name: "acme.required", description: "", optional: false }],
        context,
      ),
    ).rejects.toThrow(CapabilityResolutionError);
  });

  it("wraps provider failures with the capability name", async () => {
    const registry = new CapabilityRegistry([
      {
        name: "acme.database",
        resolve: () => {
          throw new Error("vendor api down");
        },
      },
    ]);
    await expect(
      registry.resolveAll(
        [{ name: "acme.database", description: "", optional: false }],
        context,
      ),
    ).rejects.toThrow(/acme\.database.*vendor api down/);
  });

  it("rejects reserved CATAMORPHIC_ env names", async () => {
    const registry = new CapabilityRegistry([
      {
        name: "acme.database",
        resolve: () => ({ CATAMORPHIC_RUN_ID: "hijack" }),
      },
    ]);
    await expect(
      registry.resolveAll(
        [{ name: "acme.database", description: "", optional: false }],
        context,
      ),
    ).rejects.toThrow(ReservedCapabilityEnvError);
  });
});
