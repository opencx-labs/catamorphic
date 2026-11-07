import { expect, it } from "vitest";
import {
  inputDefaults,
  sanitizeActionInput,
  submittedInputValues,
} from "./action-input.js";

it("keeps typed repeated values and omits hidden controls", () => {
  const input = sanitizeActionInput({
    fields: [
      { name: "title", label: "Title", required: true },
      {
        name: "reminders",
        label: "Reminders",
        type: "repeat",
        minItems: 1,
        maxItems: 3,
        fields: [
          {
            name: "preset",
            label: "When",
            type: "select",
            options: [
              { label: "Two days", value: "2d" },
              { label: "Custom", value: "custom" },
            ],
          },
          {
            name: "days",
            label: "Days",
            type: "number",
            min: 1,
            when: { field: "preset", equals: "custom" },
          },
        ],
      },
    ],
  });
  if (!input) throw Error("No input");
  expect(inputDefaults(input.fields)).toEqual({
    title: "",
    reminders: [{ preset: "2d", days: null }],
  });
  expect(
    submittedInputValues(input.fields, {
      title: "Plan",
      reminders: [
        { preset: "2d", days: 9 },
        { preset: "custom", days: 3 },
      ],
    }),
  ).toEqual({
    title: "Plan",
    reminders: [{ preset: "2d" }, { preset: "custom", days: 3 }],
  });
});
it("submits empty optional numbers as null, including initial repeated values", () => {
  const input = sanitizeActionInput({
    fields: [
      { name: "count", label: "Count", type: "number" },
      {
        name: "entries",
        label: "Entries",
        type: "repeat",
        fields: [{ name: "amount", label: "Amount", type: "number" }],
        value: [{ amount: null }],
      },
    ],
  });
  if (!input) throw Error("No input");
  expect(
    submittedInputValues(input.fields, inputDefaults(input.fields)),
  ).toEqual({
    count: null,
    entries: [{ amount: null }],
  });
});
it("treats allowed field names as JSON keys rather than inherited object properties", () => {
  expect(
    inputDefaults([
      { name: "constructor", label: "Builder", value: "Team" },
      { name: "toString", label: "Caption" },
    ]),
  ).toEqual({ constructor: "Team", toString: "" });
});
it("rejects unknown types, duplicate names, nested repeats and conditional cycles", () => {
  for (const fields of [
    [{ name: "x", label: "X", type: "script" }],
    [
      { name: "x", label: "X" },
      { name: "x", label: "X" },
    ],
    [
      {
        name: "x",
        label: "X",
        type: "repeat",
        fields: [{ name: "y", label: "Y", type: "repeat", fields: [] }],
      },
    ],
    [
      {
        name: "x",
        label: "X",
        type: "repeat",
        minItems: 1,
        value: [],
        fields: [{ name: "y", label: "Y" }],
      },
    ],
    [
      { name: "a", label: "A", when: { field: "b", equals: "x" } },
      { name: "b", label: "B", when: { field: "a", equals: "x" } },
    ],
  ])
    expect(() => sanitizeActionInput({ fields })).toThrow("Action input");
});
