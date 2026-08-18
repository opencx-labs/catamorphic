import { describe, expect, it } from "vitest";
import {
  holeSchemaErrors,
  isPermissiveSchema,
  resolveSchemaPath,
  schemaHoles,
} from "../holes.js";

const HOLE = (name: string) => ({ "x-catamorphic-hole": name });

describe("schemaHoles", () => {
  it("finds a whole-payload hole", () => {
    expect(schemaHoles(HOLE("Args"))).toEqual([
      { name: "Args", path: [], supported: true },
    ]);
  });

  it("finds holes nested under properties and items", () => {
    const schema = {
      type: "object",
      properties: {
        method: { type: "string" },
        body: HOLE("Body"),
        attachments: { type: "array", items: HOLE("Attachment") },
      },
    };
    expect(schemaHoles(schema)).toEqual([
      { name: "Body", path: ["body"], supported: true },
      { name: "Attachment", path: ["attachments", "[]"], supported: true },
    ]);
  });

  it("marks holes under unions and additionalProperties as unsupported", () => {
    expect(schemaHoles({ anyOf: [{ type: "string" }, HOLE("V")] })).toEqual([
      { name: "V", path: [], supported: false },
    ]);
    expect(
      schemaHoles({ type: "object", additionalProperties: HOLE("V") }),
    ).toEqual([{ name: "V", path: [], supported: false }]);
  });

  it("returns nothing for hole-free schemas", () => {
    expect(schemaHoles({ type: "object" })).toEqual([]);
    expect(schemaHoles({})).toEqual([]);
    expect(schemaHoles(null)).toEqual([]);
  });
});

describe("resolveSchemaPath", () => {
  const schema = {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: { orderId: { type: "string" } },
      },
      tags: { type: "array", items: { type: "string" } },
    },
  };

  it("resolves the root, property, and item paths", () => {
    expect(resolveSchemaPath(schema, [])).toBe(schema);
    expect(resolveSchemaPath(schema, ["body", "orderId"])).toEqual({
      type: "string",
    });
    expect(resolveSchemaPath(schema, ["tags", "[]"])).toEqual({
      type: "string",
    });
  });

  it("returns undefined for undeclared positions", () => {
    expect(resolveSchemaPath(schema, ["missing"])).toBeUndefined();
    expect(resolveSchemaPath({}, ["body"])).toBeUndefined();
  });
});

describe("isPermissiveSchema", () => {
  it("treats the extractor's degradations as permissive", () => {
    expect(isPermissiveSchema({})).toBe(true);
    expect(isPermissiveSchema(true)).toBe(true);
    expect(isPermissiveSchema({ description: "anything" })).toBe(true);
  });

  it("treats constrained schemas as concrete", () => {
    expect(isPermissiveSchema({ type: "object" })).toBe(false);
    expect(isPermissiveSchema({ enum: ["a"] })).toBe(false);
    expect(isPermissiveSchema({ anyOf: [{ type: "string" }] })).toBe(false);
  });
});

describe("holeSchemaErrors", () => {
  it("accepts holes that freeze to concrete schemas", () => {
    expect(
      holeSchemaErrors({
        payloadSchema: HOLE("Args"),
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }),
    ).toEqual([]);
  });

  it("rejects a hole the input never declares", () => {
    const errors = holeSchemaErrors({
      payloadSchema: {
        type: "object",
        properties: { method: { type: "string" }, body: HOLE("Body") },
      },
      inputSchema: {
        type: "object",
        properties: { method: { type: "string" } },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hole 'Body'");
    expect(errors[0]).toContain("not declared");
  });

  it("rejects a hole that freezes to a permissive schema", () => {
    const errors = holeSchemaErrors({
      payloadSchema: HOLE("Args"),
      inputSchema: {},
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("permissive");
  });

  it("is silent for kinds without holes", () => {
    expect(
      holeSchemaErrors({
        payloadSchema: { type: "object" },
        inputSchema: {},
      }),
    ).toEqual([]);
  });

  it("rejects holes in unsupported positions", () => {
    const errors = holeSchemaErrors({
      payloadSchema: { anyOf: [{ type: "string" }, HOLE("V")] },
      inputSchema: { type: "object" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unsupported");
  });
});
