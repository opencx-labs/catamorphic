import { describe, expect, it } from "vitest";
import {
  buildTriggerKindRegistry,
  type TriggerKindRuntime,
} from "../services/trigger-kinds.js";

function kind(
  partial: Pick<TriggerKindRuntime, "name"> & Partial<TriggerKindRuntime>,
): TriggerKindRuntime {
  return {
    payloadJsonSchema: { type: "object", properties: {} },
    configJsonSchema: { type: "object", properties: {} },
    validatePayload: () => ({ ok: true }),
    validateConfig: () => ({ ok: true }),
    ...partial,
  };
}

describe("buildTriggerKindRegistry", () => {
  it("accepts holes in plain property and item positions", () => {
    const registry = buildTriggerKindRegistry([
      kind({
        name: "ai.tool-call",
        payloadJsonSchema: { "x-catamorphic-hole": "Args" },
      }),
      kind({
        name: "http.request",
        payloadJsonSchema: {
          type: "object",
          properties: { body: { "x-catamorphic-hole": "Body" } },
        },
        outputJsonSchema: {
          type: "object",
          properties: { body: { "x-catamorphic-hole": "Response" } },
        },
      }),
    ]);
    expect([...registry.keys()]).toEqual(["ai.tool-call", "http.request"]);
  });

  it("rejects holes in unresolvable positions at registration", () => {
    expect(() =>
      buildTriggerKindRegistry([
        kind({
          name: "bad.union",
          payloadJsonSchema: {
            anyOf: [{ type: "string" }, { "x-catamorphic-hole": "V" }],
          },
        }),
      ]),
    ).toThrow(/unsupported position/);
    expect(() =>
      buildTriggerKindRegistry([
        kind({
          name: "bad.record",
          outputJsonSchema: {
            type: "object",
            additionalProperties: { "x-catamorphic-hole": "V" },
          },
        }),
      ]),
    ).toThrow(/unsupported position/);
  });
});
