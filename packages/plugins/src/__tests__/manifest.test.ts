import { describe, expect, it } from "vitest";
import { PluginManifestSchema, parsePluginPackageJson } from "../manifest.js";

const OPENCX_PACKAGE_JSON = {
  name: "@acme/example-sdk",
  version: "0.0.1",
  catamorphic: {
    displayName: "OpenCX",
    description: "Trigger payloads and actions for OpenCX workflows.",
    secrets: [
      {
        name: "EXAMPLE_API_KEY",
        label: "OpenCX API Key",
        description: "Bearer token from the OpenCX dashboard.",
        required: true,
      },
      {
        name: "EXAMPLE_API_URL",
        label: "OpenCX API URL",
        description: "Override the default base URL.",
        required: false,
        default: "https://api.example.com",
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
    expect(parsed.name).toBe("@acme/example-sdk");
    expect(parsed.catamorphic.displayName).toBe("OpenCX");
    expect(parsed.catamorphic.secrets).toHaveLength(2);
    expect(parsed.catamorphic.secrets[0]?.required).toBe(true);
    expect(parsed.catamorphic.secrets[1]?.default).toBe("https://api.example.com");
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

  it("validates versioned batch source and sink capabilities", () => {
    const parsed = PluginManifestSchema.parse({
      displayName: "Data connector",
      batch: {
        contractVersion: 1,
        sources: [
          {
            id: "feedback",
            displayName: "Feedback",
            exportName: "feedbackSource",
            execution: "sandbox",
            consistency: ["snapshot"],
            schemas: {
              config: "schemas/feedback-config.json",
              item: "schemas/feedback-item.json",
              cursor: "schemas/feedback-cursor.json",
              snapshot: "schemas/feedback-snapshot.json",
            },
          },
        ],
        sinks: [
          {
            id: "csv",
            displayName: "CSV",
            exportName: "csvSink",
            execution: "sandbox",
            schemas: {
              result: "schemas/csv-result.json",
              state: "schemas/csv-state.json",
              artifact: "schemas/csv-artifact.json",
            },
          },
        ],
      },
    });

    expect(parsed.batch?.contractVersion).toBe(1);
    expect(parsed.batch?.sources[0]?.consistency).toEqual(["snapshot"]);
    expect(parsed.batch?.sinks[0]?.id).toBe("csv");
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

  it("rejects secret names in the reserved runtime namespace", () => {
    expect(() =>
      PluginManifestSchema.parse({
        displayName: "Bad",
        secrets: [
          {
            name: "CATAMORPHIC_WORKFLOW_NAME",
            label: "Override",
            required: true,
          },
        ],
      }),
    ).toThrow(/reserved CATAMORPHIC_/);
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
