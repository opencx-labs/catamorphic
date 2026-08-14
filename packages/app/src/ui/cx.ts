/** Joins class names, skipping falsy entries. The kit's only "utility". */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
