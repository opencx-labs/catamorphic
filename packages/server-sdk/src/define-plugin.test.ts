import { describe, expect, it } from "vitest";
import {
  DuplicatePluginContributionError,
  defineCapability,
  definePlugin,
  mergeHostPlugins,
} from "./define-plugin.js";

const emptyBase = {
  capabilityProviders: [],
  projectHooks: [],
  triggerKinds: [],
  mcpToolKinds: [],
} as const;

describe("mergeHostPlugins", () => {
  it("merges plugin contributions with top-level config", () => {
    const plugin = definePlugin({
      name: "@acme/catamorphic-neon",
      capabilities: [
        defineCapability({
          name: "acme.database",
          resolve: () => ({ DB_URL: "postgres://x" }),
        }),
      ],
      projectHooks: { onProjectCreated: () => {} },
      triggerKinds: [
        {
          name: "acme.ticket",
          payloadJsonSchema: {},
          configJsonSchema: {},
          validatePayload: () => ({ ok: true }),
          validateConfig: () => ({ ok: true }),
        },
      ],
    });
    const merged = mergeHostPlugins({
      ...emptyBase,
      plugins: [plugin],
      capabilityProviders: [
        defineCapability({ name: "host.custom", resolve: () => ({}) }),
      ],
    });
    expect(merged.capabilityProviders.map((p) => p.name)).toEqual([
      "host.custom",
      "acme.database",
    ]);
    expect(merged.triggerKinds.map((k) => k.name)).toEqual(["acme.ticket"]);
    expect(merged.projectHooks).toHaveLength(1);
  });

  it("rejects capability collisions between plugins", () => {
    const provider = defineCapability({
      name: "acme.database",
      resolve: () => ({}),
    });
    expect(() =>
      mergeHostPlugins({
        ...emptyBase,
        plugins: [
          definePlugin({ name: "@acme/one", capabilities: [provider] }),
          definePlugin({ name: "@acme/two", capabilities: [provider] }),
        ],
      }),
    ).toThrow(DuplicatePluginContributionError);
  });

  it("rejects a plugin shadowing a top-level trigger kind", () => {
    const kind = {
      name: "ticket.created",
      payloadJsonSchema: {},
      configJsonSchema: {},
      validatePayload: () => ({ ok: true as const }),
      validateConfig: () => ({ ok: true as const }),
    };
    expect(() =>
      mergeHostPlugins({
        ...emptyBase,
        triggerKinds: [kind],
        plugins: [definePlugin({ name: "@acme/one", triggerKinds: [kind] })],
      }),
    ).toThrow(DuplicatePluginContributionError);
  });
});
