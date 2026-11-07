import { expect, it } from "vitest";
import { addTodoInput } from "../../apps/desktop/fixtures/customization-todos.js";
import { todoFormValues } from "./manual-form.js";

it("drives the checked real UI example without assuming action field names", () => {
  expect(todoFormValues(addTodoInput, "presets", "New task")).toEqual({
    title: "New task",
    notes: "",
    reminders: [{ preset: "2d" }, { preset: "1w" }],
  });
  expect(todoFormValues(addTodoInput, "custom", "Timed task")).toEqual({
    title: "Timed task",
    notes: "",
    reminders: [{ preset: "custom", amount: 1, unit: "minutes" }],
  });
});
