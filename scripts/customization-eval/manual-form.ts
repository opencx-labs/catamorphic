import {
  inputDefaults,
  submittedInputValues,
} from "../../apps/desktop/src/shared/action-input.js";
import type {
  SidebarActionInput,
  SidebarInputField,
  SidebarInputValues,
} from "../../apps/desktop/src/shared/sidebar.js";

/** Choose by the public controls and visible options, never agent-specific field names. */
export function todoFormValues(
  input: SidebarActionInput,
  kind: "presets" | "custom",
  title: string,
): SidebarInputValues {
  const values = inputDefaults(input.fields);
  const titleField = input.fields.find(
    (f) => (!f.type || f.type === "text") && /title|name/i.test(f.label),
  );
  if (!titleField) throw Error("Add form has no title control.");
  values[titleField.name] = title;
  const repeat = input.fields.find((f) => f.type === "repeat");
  if (repeat?.type !== "repeat")
    throw Error("Add form has no repeatable reminder controls.");
  const preset = repeat.fields.find(
    (f) =>
      f.type === "select" &&
      f.options.some((o) => /2 days|two days|48 hours/i.test(o.label)),
  );
  if (preset?.type !== "select")
    throw Error("Reminder options do not include 2 days.");
  const make = (pattern: RegExp) => {
    const option = preset.options.find(
      (o) => pattern.test(o.label) && !o.disabled,
    );
    if (!option) throw Error(`No reminder option matching ${pattern}`);
    return { ...inputDefaults(repeat.fields), [preset.name]: option.value };
  };
  if (kind === "presets")
    values[repeat.name] = [
      make(/2 days|two days|48 hours/i),
      make(/one week|1 week|7 days/i),
    ];
  else {
    const custom = make(/custom/i);
    const number = repeat.fields.find((f) => f.type === "number");
    if (!number) throw Error("Custom timeout has no number control.");
    custom[number.name] = 1;
    const unit = repeat.fields.find(
      (f) =>
        f.type === "select" &&
        f !== preset &&
        f.options.some((o) => /minute/i.test(o.label)),
    );
    if (unit?.type !== "select") throw Error("Custom timeout has no units.");
    custom[unit.name] =
      unit.options.find((o) => /minute/i.test(o.label))?.value ?? "";
    values[repeat.name] = [custom];
  }
  return submittedInputValues(input.fields, values);
}

export function inputHasDateTime(fields: SidebarInputField[]): boolean {
  return fields.some(
    (f) =>
      f.type === "datetime" ||
      (f.type === "repeat" && inputHasDateTime(f.fields)),
  );
}
