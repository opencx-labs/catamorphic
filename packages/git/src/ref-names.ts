/**
 * Git's rules for ref names (`git check-ref-format`), applied to every ref a
 * caller names before any backend reads it. A backend that stores refs as
 * files or keys must never see `..`, empty segments, or other forms that
 * could reach a ref outside the one named.
 */
export function isValidRefName(ref: string): boolean {
  if (!ref || ref === "@" || ref.endsWith("/") || ref.endsWith("."))
    return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{"))
    return false;
  // Control characters, space, and git's reserved punctuation.
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(char))
      return false;
  }
  return ref
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        !segment.startsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

/** A ref name that fails git's rules. */
export class InvalidRefNameError extends Error {
  constructor(ref: string) {
    super(`Invalid ref name: ${JSON.stringify(ref)}`);
    this.name = "InvalidRefNameError";
  }
}

export function assertValidRefName(ref: string): void {
  if (!isValidRefName(ref)) throw new InvalidRefNameError(ref);
}

/**
 * A name `resolveRef` may be given: `HEAD`, a full commit id, or a valid
 * branch or full ref name.
 */
export function assertResolvableRef(ref: string): void {
  if (ref === "HEAD" || /^[0-9a-f]{40}$/.test(ref)) return;
  assertValidRefName(ref);
}
