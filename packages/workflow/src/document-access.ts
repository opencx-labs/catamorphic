/**
 * A project store path a workflow's runs read or write (ADR 0335). A path
 * ending in `/` is a folder and covers everything under it; any other path
 * names one document. `write` also reads. Turning the workflow on shows
 * the list, and its runs reach nothing else of the store.
 */
export interface WorkflowDocumentAccess {
  readonly path: `store/${string}`;
  readonly access: "read" | "write";
}

/** The project store's root segment; every declared path starts with it. */
const STORE = "store";

/**
 * Why a declared document path is not a plain project store path, or
 * undefined when it is one. Shared by the parser, the capability check and
 * the host, so all three refuse the same paths with the same words.
 */
export function workflowDocumentPathError(path: string): string | undefined {
  if (path.length === 0) return "is empty";
  if (path.length > 1024) return "is longer than 1024 characters";
  if (path.startsWith("/")) return "must be relative, such as store/notes/";
  if (path !== path.trim()) return "has spaces at its start or end";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in paths is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return "contains control characters";
  if (path.includes("\\")) return "must use / between folders";
  if (path.normalize("NFC") !== path)
    return "must be written in Unicode NFC form, as the store names it";
  if (/[*?[\]{}]/.test(path))
    return "must name a document or a folder, not a pattern: end a folder with /";
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  if (segments[0] !== STORE)
    return "must be in the project store: start it with store/";
  for (const segment of segments) {
    if (segment === "") return "has an empty folder name (//)";
    if (segment === "." || segment === "..")
      return `may not contain '${segment}'`;
  }
  if (segments.length === 1 && !path.endsWith("/"))
    return "names the store itself: write store/ for all of it";
  return undefined;
}

/** Whether a declared path is a folder (it ends in `/`). */
export function isWorkflowDocumentFolder(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Whether `outer` covers `inner`: the same document, or `inner` under the
 * folder `outer`, with at least `inner`'s access. A folder never covers a
 * sibling with a longer name: `store/a/` does not cover `store/ab`.
 */
export function workflowDocumentCovers(
  outer: { path: string; access: "read" | "write" },
  inner: { path: string; access: "read" | "write" },
): boolean {
  if (inner.access === "write" && outer.access !== "write") return false;
  if (outer.path === inner.path) return true;
  return (
    isWorkflowDocumentFolder(outer.path) && inner.path.startsWith(outer.path)
  );
}

/**
 * The declaration as the host keeps it: unique paths, sorted, `write`
 * winning over `read` for the same path. Throws on a path
 * {@link workflowDocumentPathError} refuses.
 */
export function normalizeWorkflowDocuments(
  documents: ReadonlyArray<{ path: string; access: string }>,
): Array<{ path: string; access: "read" | "write" }> {
  const byPath = new Map<string, "read" | "write">();
  for (const document of documents) {
    const error = workflowDocumentPathError(document.path);
    if (error) throw new Error(`Workflow document '${document.path}' ${error}`);
    if (document.access !== "read" && document.access !== "write")
      throw new Error(
        `Workflow document '${document.path}' needs access: "read" or "write"`,
      );
    if (byPath.get(document.path) !== "write")
      byPath.set(document.path, document.access);
  }
  return [...byPath]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, access]) => ({ path, access }));
}
