import { describe, expect, it } from "vitest";
import { PluginManifestSchema, parsePluginPackageJson } from "../manifest.js";

const ACME_PACKAGE_JSON = {
  name: "@acme/example-sdk",
  version: "0.0.1",
  catamorphic: {
    displayName: "Acme",
    description: "Trigger payloads and actions for Acme workflows.",
    secrets: [
      {
        name: "EXAMPLE_API_KEY",
        label: "Acme API Key",
        description: "Bearer token from the host dashboard.",
        required: true,
      },
      {
        name: "EXAMPLE_API_URL",
        label: "Acme API URL",
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
  it("accepts a host manifest", () => {
    const parsed = parsePluginPackageJson(ACME_PACKAGE_JSON);
    expect(parsed.name).toBe("@acme/example-sdk");
    expect(parsed.catamorphic.displayName).toBe("Acme");
    expect(parsed.catamorphic.secrets).toHaveLength(2);
    expect(parsed.catamorphic.secrets[0]?.required).toBe(true);
    expect(parsed.catamorphic.secrets[1]?.default).toBe(
      "https://api.example.com",
    );
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

  it("parses capability requirements with defaults", () => {
    const manifest = PluginManifestSchema.parse({
      displayName: "Acme DB",
      requires: [{ name: "acme.database" }],
    });
    expect(manifest.requires).toEqual([
      { name: "acme.database", description: "", optional: false },
    ]);
  });

  it("defaults requires to an empty list", () => {
    const manifest = PluginManifestSchema.parse({ displayName: "Plain" });
    expect(manifest.requires).toEqual([]);
  });

  it("rejects capability names that are not dot-namespaced lowercase", () => {
    for (const name of ["Database", "acme", "acme.", "acme.DB", "a b.c"]) {
      expect(() =>
        PluginManifestSchema.parse({
          displayName: "Bad",
          requires: [{ name }],
        }),
      ).toThrow(/dot-namespaced/);
    }
  });
});
