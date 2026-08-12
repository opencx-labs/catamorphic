type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { readonly [key: string]: Json }
  | readonly Json[];

/**
 * Validates a JSON value against the schema subset the parser's extractor
 * emits: type/object/properties/required/additionalProperties/items/enum/
 * const/anyOf. Anything outside that subset is treated as permissive —
 * consistent with the extractor's degrade-to-`{}` policy, and the reason
 * this stays hand-rolled instead of pulling in a full validator.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path = "input",
): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  const node = schema as Record<string, unknown>;
  const errors: string[] = [];

  if ("const" in node) {
    if (JSON.stringify(value) !== JSON.stringify(node.const)) {
      errors.push(`${path}: expected ${JSON.stringify(node.const)}`);
    }
    return errors;
  }
  if (Array.isArray(node.enum)) {
    const match = node.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    );
    if (!match) {
      errors.push(
        `${path}: expected one of ${node.enum
          .map((candidate) => JSON.stringify(candidate))
          .join(", ")}`,
      );
    }
    return errors;
  }
  if (Array.isArray(node.anyOf)) {
    const failures = node.anyOf.map((arm) =>
      validateAgainstSchema(value, arm, path),
    );
    if (!failures.some((armErrors) => armErrors.length === 0)) {
      errors.push(`${path}: matched no allowed variant`);
    }
    return errors;
  }

  switch (node.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected a string`);
      return errors;
    case "number":
      if (typeof value !== "number") errors.push(`${path}: expected a number`);
      return errors;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${path}: expected a boolean`);
      }
      return errors;
    case "null":
      if (value !== null) errors.push(`${path}: expected null`);
      return errors;
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected an array`);
        return errors;
      }
      if (node.items !== undefined) {
        value.forEach((item, index) => {
          errors.push(
            ...validateAgainstSchema(item, node.items, `${path}[${index}]`),
          );
        });
      }
      return errors;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected an object`);
        return errors;
      }
      const record = value as { [key: string]: Json };
      const properties =
        typeof node.properties === "object" &&
        node.properties !== null &&
        !Array.isArray(node.properties)
          ? (node.properties as Record<string, unknown>)
          : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((key): key is string => typeof key === "string")
        : [];
      for (const key of required) {
        if (!(key in record)) errors.push(`${path}.${key}: required`);
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in record) {
          errors.push(
            ...validateAgainstSchema(
              record[key] as Json,
              propertySchema,
              `${path}.${key}`,
            ),
          );
        }
      }
      if (
        node.additionalProperties !== undefined &&
        node.additionalProperties !== true &&
        node.additionalProperties !== false
      ) {
        for (const [key, entry] of Object.entries(record)) {
          if (!(key in properties)) {
            errors.push(
              ...validateAgainstSchema(
                entry,
                node.additionalProperties,
                `${path}.${key}`,
              ),
            );
          }
        }
      }
      return errors;
    }
    default:
      return errors;
  }
}
