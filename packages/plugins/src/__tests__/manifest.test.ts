import { describe, expect, it } from "vitest";
import { PluginManifestSchema, parsePluginPackageJson } from "../manifest.js";

const OPENCX_PACKAGE_JSON = {
  name: "@opencx/workflow-sdk",
  version: "0.0.1",
  catamorphic: {
    displayName: "OpenCX",
    description: "Trigger payloads and actions for OpenCX workflows.",
    secrets: [
      {
        name: "OPENCX_API_KEY",
        label: "OpenCX API Key",
        description: "Bearer token from the OpenCX dashboard.",
        required: true,
      },
      {
        name: "OPENCX_API_URL",
        label: "OpenCX API URL",
        description: "Override the default base URL.",
        required: false,
        default: "https://api.open.cx",
      },
    ],
    docs: {
      readme: "README.md",
      types: "dist/index.d.ts",
    },
  },
};

describe("PluginManifestSchema", () => {
  it("accepts the OpenCX manifest", () => {
    const parsed = parsePluginPackageJson(OPENCX_PACKAGE_JSON);
    expect(parsed.name).toBe("@opencx/workflow-sdk");
    expect(parsed.catamorphic.displayName).toBe("OpenCX");
    expect(parsed.catamorphic.secrets).toHaveLength(2);
    expect(parsed.catamorphic.secrets[0]?.required).toBe(true);
    expect(parsed.catamorphic.secrets[1]?.default).toBe("https://api.open.cx");
  });

  it("fills defaults for optional docs fields", () => {
    const parsed = PluginManifestSchema.parse({
      displayName: "Something",
    });
    expect(parsed.docs).toEqual({
      readme: "README.md",
      types: "dist/index.d.ts",
    });
    expect(parsed.description).toBe("");
    expect(parsed.secrets).toEqual([]);
  });

  it("rejects secret names that are not SCREAMING_SNAKE_CASE", () => {
    expect(() =>
      PluginManifestSchema.parse({
        displayName: "Bad",
        secrets: [
          {
            name: "lowerCase",
            label: "Lower",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects manifests without a displayName", () => {
    expect(() =>
      PluginManifestSchema.parse({
        secrets: [],
      }),
    ).toThrow();
  });

  it("rejects package.json without a name", () => {
    expect(() =>
      parsePluginPackageJson({
        catamorphic: { displayName: "foo" },
      }),
    ).toThrow();
  });
});
