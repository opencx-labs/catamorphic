import type {
  SidebarActionInput,
  SidebarInputField,
  SidebarInputValues,
} from "./sidebar.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const scalarRecord = (
  value: unknown,
): value is Record<string, string | number | boolean | null> =>
  record(value) && Object.values(value).every((v) => v === null || scalar(v));
const fail = (message: string): never => {
  throw new Error(`Action input: ${message}`);
};

/** The same bounded form is accepted from layouts, sources and chips. */
export function sanitizeActionInput(
  raw: unknown,
): SidebarActionInput | undefined {
  if (raw === undefined) return undefined;
  if (!record(raw)) return fail("expected fields.");
  let count = 0;
  const fields = (raw: unknown, repeated = false): SidebarInputField[] => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16)
      return fail("use one to sixteen fields.");
    const names = new Set<string>();
    const result = raw.map((field): SidebarInputField => {
      if (
        ++count > 32 ||
        !record(field) ||
        typeof field.name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(field.name) ||
        names.has(field.name) ||
        typeof field.label !== "string" ||
        !field.label.trim()
      )
        return fail("each field needs a unique name and label.");
      names.add(field.name);
      const base = {
        name: field.name,
        label: field.label.slice(0, 200),
        ...(typeof field.description === "string"
          ? { description: field.description.slice(0, 1000) }
          : {}),
        ...(field.when === undefined
          ? {}
          : {
              when:
                record(field.when) &&
                typeof field.when.field === "string" &&
                scalar(field.when.equals)
                  ? { field: field.when.field, equals: field.when.equals }
                  : fail("when needs a sibling field and scalar equals."),
            }),
      };
      const common = {
        ...base,
        ...(field.required === true ? { required: true } : {}),
        ...(typeof field.placeholder === "string"
          ? { placeholder: field.placeholder.slice(0, 1000) }
          : {}),
      };
      const number = (key: string, min?: number, max?: number) => {
        const v = field[key];
        if (v === undefined) return undefined;
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          (min !== undefined && v < min) ||
          (max !== undefined && v > max)
        )
          return fail(`${key} is out of range.`);
        return v;
      };
      switch (field.type) {
        case "repeat": {
          if (repeated) return fail("repeat groups cannot nest.");
          const minItems = number("minItems", 0, 20) ?? 0,
            maxItems = number("maxItems", minItems, 20) ?? 10;
          if (
            !Number.isInteger(minItems) ||
            !Number.isInteger(maxItems) ||
            maxItems < minItems
          )
            return fail("invalid repeat bounds.");
          const children = fields(field.fields, true).filter(
            (f) => f.type !== "repeat",
          );
          const value = field.value;
          if (
            value !== undefined &&
            (!Array.isArray(value) ||
              value.length < minItems ||
              value.length > maxItems ||
              !value.every(scalarRecord) ||
              value.some((v) =>
                Object.keys(v).some((k) => !children.some((f) => f.name === k)),
              ))
          )
            return fail("invalid repeat values.");
          return {
            ...base,
            type: "repeat",
            fields: children,
            minItems,
            maxItems,
            ...(value === undefined ? {} : { value }),
            ...(typeof field.addLabel === "string"
              ? { addLabel: field.addLabel.slice(0, 200) }
              : {}),
          };
        }
        case "select": {
          if (
            !Array.isArray(field.options) ||
            !field.options.length ||
            field.options.length > 100
          )
            return fail("select needs one to one hundred options.");
          const seen = new Set<string>();
          const options = field.options.map((o) => {
            if (
              !record(o) ||
              typeof o.label !== "string" ||
              !o.label ||
              typeof o.value !== "string" ||
              o.value.length > 1000 ||
              seen.has(o.value)
            )
              return fail("invalid or duplicate select option.");
            seen.add(o.value);
            return {
              label: o.label.slice(0, 200),
              value: o.value,
              ...(o.disabled === true ? { disabled: true } : {}),
            };
          });
          if (
            field.value !== undefined &&
            (typeof field.value !== "string" || !seen.has(field.value))
          )
            return fail("select value must match an option.");
          return {
            ...common,
            type: "select",
            options,
            ...(typeof field.value === "string" ? { value: field.value } : {}),
          };
        }
        case "checkbox":
          if (field.value !== undefined && typeof field.value !== "boolean")
            return fail("checkbox value must be boolean.");
          return {
            ...common,
            type: "checkbox",
            ...(typeof field.value === "boolean" ? { value: field.value } : {}),
          };
        case "number": {
          const min = number("min"),
            max = number("max"),
            step = number("step", Number.MIN_VALUE),
            value = number("value");
          if (min !== undefined && max !== undefined && min > max)
            return fail("min exceeds max.");
          return { ...common, type: "number", min, max, step, value };
        }
        case undefined:
        case "text":
        case "textarea":
        case "date":
        case "time":
        case "datetime": {
          if (field.value !== undefined && typeof field.value !== "string")
            return fail("text/date values must be strings.");
          const minLength = number("minLength", 0, 8192),
            maxLength = number("maxLength", minLength ?? 0, 8192);
          return {
            ...common,
            ...(field.type === undefined ? {} : { type: field.type }),
            ...(typeof field.value === "string"
              ? { value: field.value.slice(0, 8192) }
              : {}),
            minLength,
            maxLength,
          };
        }
        default:
          return fail(`unknown field type ${String(field.type)}.`);
      }
    });
    for (const f of result)
      if (
        f.when &&
        (!names.has(f.when.field) ||
          f.when.field === f.name ||
          result.find((s) => s.name === f.when?.field)?.when)
      )
        fail("conditions must name an unconditional sibling.");
    return result;
  };
  return {
    fields: fields(raw.fields),
    ...(typeof raw.title === "string"
      ? { title: raw.title.slice(0, 200) }
      : {}),
    ...(typeof raw.submit === "string"
      ? { submit: raw.submit.slice(0, 100) }
      : {}),
  };
}

export function inputDefaults(
  fields: SidebarInputField[],
  initial: SidebarInputValues = {},
): SidebarInputValues {
  return Object.fromEntries(
    fields.map((f) => [
      f.name,
      (Object.hasOwn(initial, f.name) ? initial[f.name] : undefined) ??
        (f.type === "repeat"
          ? (
              f.value ?? Array.from({ length: f.minItems ?? 0 }, () => ({}))
            ).map((v) => inputDefaults(f.fields, v))
          : (f.value ??
            (f.type === "checkbox"
              ? false
              : f.type === "select"
                ? (f.options.find((o) => !o.disabled)?.value ?? "")
                : f.type === "number"
                  ? null
                  : ""))),
    ]),
  );
}
export const inputFieldVisible = (
  f: SidebarInputField,
  values: SidebarInputValues,
) => !f.when || values[f.when.field] === f.when.equals;
export function submittedInputValues(
  fields: SidebarInputField[],
  values: SidebarInputValues,
): SidebarInputValues {
  return Object.fromEntries(
    fields
      .filter((f) => inputFieldVisible(f, values))
      .map((f) => {
        const value = Object.hasOwn(values, f.name)
          ? values[f.name]
          : undefined;
        return [
          f.name,
          f.type === "repeat"
            ? (Array.isArray(value) ? value : []).map((v) =>
                submittedInputValues(f.fields, v),
              )
            : f.type === "number" && value === ""
              ? null
              : (value ?? null),
        ];
      }),
  );
}
