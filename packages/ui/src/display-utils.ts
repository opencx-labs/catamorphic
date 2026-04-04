const FRIENDLY_TYPES: Record<string, string> = {
  string: "Text",
  number: "Number",
  boolean: "True or False",
  "string[]": "Text List",
  "number[]": "Number List",
  "boolean[]": "True/False List",
  object: "Object",
  "Record<string, string>": "Key-Value Map",
  Date: "Date",
  "string | null": "Text (optional)",
  "number | null": "Number (optional)",
  "boolean | null": "True or False (optional)",
};

export function friendlyType(rawType: string): string {
  const direct = FRIENDLY_TYPES[rawType];
  if (direct) return direct;

  if (rawType.endsWith("[]")) {
    const inner = rawType.slice(0, -2);
    const friendlyInner = FRIENDLY_TYPES[inner] ?? inner;
    return `${friendlyInner} List`;
  }

  if (rawType.startsWith("Array<") && rawType.endsWith(">")) {
    const inner = rawType.slice(6, -1);
    const friendlyInner = FRIENDLY_TYPES[inner] ?? inner;
    return `${friendlyInner} List`;
  }

  return rawType;
}

export function friendlyParamName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettyCondition(raw: string): string {
  return raw
    .replace(/\s*===\s*/g, " is ")
    .replace(/\s*!==\s*/g, " is not ")
    .replace(/\s*&&\s*/g, " and ")
    .replace(/\s*\|\|\s*/g, " or ")
    .replace(/\s*>=\s*/g, " ≥ ")
    .replace(/\s*<=\s*/g, " ≤ ")
    .replace(
      /\.includes\(([^)]+)\)/g,
      (_, arg) => ` contains ${arg.replace(/['"]/g, "")}`,
    )
    .replace(
      /\.startsWith\(([^)]+)\)/g,
      (_, arg) => ` starts with ${arg.replace(/['"]/g, "")}`,
    )
    .replace(
      /\.endsWith\(([^)]+)\)/g,
      (_, arg) => ` ends with ${arg.replace(/['"]/g, "")}`,
    )
    .replace(/\.length/g, ".count")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDefaultValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value;
}
