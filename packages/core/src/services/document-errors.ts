/** No live document at the path. */
export class DocumentNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Document '${path}' not found`);
    this.name = "DocumentNotFoundError";
  }
}

/**
 * A local store path spelled otherwise than the names on disk (ADR 0335).
 * A filesystem that ignores case or Unicode form (APFS) would find the
 * file another spelling names, so only the spelling on disk reaches it.
 */
export class LocalDocumentSpellingError extends Error {
  constructor(readonly path: string) {
    super(
      `Document '${path}' is spelled otherwise on disk: store paths must match the names on disk exactly, in case and Unicode form`,
    );
    this.name = "LocalDocumentSpellingError";
  }
}
