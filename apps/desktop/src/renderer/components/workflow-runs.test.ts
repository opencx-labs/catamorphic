// @vitest-environment jsdom
import type { ParameterInfo } from "@catamorphic/react/types";
import { describe, expect, it } from "vitest";
import { parseWorkflowInput } from "./workflow-runs.js";

const parameters: ParameterInfo[] = [
  { name: "name", displayName: "Recipient", type: "string", optional: false },
  { name: "count", type: "number", optional: false },
  { name: "enabled", type: "boolean", optional: false },
  { name: "labels", type: "string[]", optional: true },
  {
    name: "mode",
    type: "string",
    schema: { enum: ["draft", "send"] },
    optional: true,
  },
];
describe("workflow run inputs", () => {
  it("preserves typed values and omits optional empty inputs", () => {
    expect(
      parseWorkflowInput({
        parameters,
        values: { name: "Ada", count: "0", enabled: "false" },
      }),
    ).toEqual({ name: "Ada", count: 0, enabled: false });
  });
  it("parses collection values and rejects malformed JSON before running", () => {
    const values = {
      name: "Ada",
      count: "3",
      enabled: "true",
      labels: '["review"]',
    };
    expect(parseWorkflowInput({ parameters, values })).toMatchObject({
      labels: ["review"],
    });
    expect(() =>
      parseWorkflowInput({ parameters, values: { ...values, labels: "[" } }),
    ).toThrow("valid JSON");
  });
  it("reports missing fields, non-finite numbers, and invalid choices", () => {
    expect(() => parseWorkflowInput({ parameters, values: {} })).toThrow(
      "Recipient",
    );
    const values = { name: "Ada", count: "Infinity", enabled: "true" };
    expect(() => parseWorkflowInput({ parameters, values })).toThrow("number");
    expect(() =>
      parseWorkflowInput({
        parameters,
        values: { ...values, count: "1", mode: "other" },
      }),
    ).toThrow("Choose");
  });
});
