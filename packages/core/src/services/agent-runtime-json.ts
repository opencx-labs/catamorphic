import type { Json } from "@catamorphic/db";

/** JSONB's durable representation: undefined properties do not exist. */
export function canonicalRuntimeJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value));
}

/** Compare exactly the canonical JSON value written to the event/request row. */
export function sameCanonicalRuntimeJson(left: Json, right: Json): boolean {
  return canonicalRuntimeJsonString(left) === canonicalRuntimeJsonString(right);
}

function canonicalRuntimeJsonString(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalRuntimeJsonString(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const values = Object.entries(value).reduce<string[]>(
      (parts, [key, item]) => {
        if (item !== undefined) {
          parts.push(
            `${JSON.stringify(key)}:${canonicalRuntimeJsonString(item)}`,
          );
        }
        return parts;
      },
      [],
    );
    values.sort();
    return `{${values.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Expected canonical JSON value");
  return encoded;
}
