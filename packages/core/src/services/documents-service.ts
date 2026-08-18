import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql } from "kysely";
import {
  type DocumentRef,
  type Identity,
  isBuilder,
  scopeCovers,
} from "../identity.js";
import type { AppBundleStore } from "./app-bundle-store.js";
import { AccessDeniedError } from "./artifact-scope.js";
import {
  listProgramBlobs,
  readProgramFile,
  readProgramFiles,
  withProgram,
} from "./program-reader.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * The documents surface (ADR 0055): one path namespace, two backings.
 *
 * - Paths outside `store/` are the **program** — git, read at the shared
 *   origin `main` (the working tree on single-machine hosts). Builders read
 *   all of it; viewers exactly the document refs their scope grants.
 *   Read-only through this surface (the program changes by checkpoint,
 *   push and PR).
 * - Paths under `store/` are the **project store** — audience-partitioned
 *   data (customer notes, contracts, generated decks), versioned per write,
 *   never deployed. Reachable ONLY through document refs, builders included:
 *   "admin" is program access, not a licence to read every customer's
 *   contract. The root identity (a host's service calls, the desktop's own
 *   local projects) sees everything.
 *
 * Every store write is stamped with the caller. Search is the tree
 * primitives — list, read, grep, full-text — scope-filtered at the source;
 * semantic search is a project workflow that reads through this service.
 */

const tracer = getTracer("@catamorphic/core");

export const STORE_ROOT = "store";

/** Text kept inline (grep/full-text) up to this many bytes. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Hard cap on one document's size. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export type DocumentSource = "program" | "store";

export interface DocumentEntry {
  path: string;
  source: DocumentSource;
  contentType: string;
  size: number;
  /** Store only. */
  version?: number;
  writtenBy?: string;
  writtenAt?: string;
  /** Program only: a content digest (`git:<oid>` / `sha256:<hex>`) so a
   * syncing client can skip unchanged files without fetching them. */
  digest?: string;
}

export interface DocumentContent extends DocumentEntry {
  /** UTF-8 text when the document is text-like; absent for binaries. */
  text?: string;
  /** Raw bytes (always present when read via `readBytes`). */
  bytes?: Uint8Array;
}

export interface DocumentVersion {
  version: number;
  deleted: boolean;
  contentType: string;
  size: number;
  writtenBy: string;
  writtenAt: string;
}

export interface DocumentMatch {
  path: string;
  source: DocumentSource;
  /** Matching lines (1-based), capped per document. */
  lines: Array<{ line: number; text: string }>;
}

export class DocumentNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Document '${path}' not found`);
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentConflictError extends Error {
  constructor(
    readonly path: string,
    readonly currentVersion: number,
  ) {
    super(
      `Document '${path}' is at version ${currentVersion}; write again with that version`,
    );
    this.name = "DocumentConflictError";
  }
}

export class DocumentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentPathError";
  }
}

export class DocumentTooLargeError extends Error {
  constructor(readonly path: string) {
    super(
      `Document '${path}' exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB limit`,
    );
    this.name = "DocumentTooLargeError";
  }
}

/** Blob backend for store bytes; the same contract as {@link AppBundleStore}. */
export type DocumentBlobStore = AppBundleStore;

type DocumentRow = Selectable<DB["store_documents"]>;

/** Rejects anything but a clean, relative, `/`-separated project path. */
export function normalizeDocumentPath(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/");
  if (!path) throw new DocumentPathError("Path is empty");
  if (path.startsWith("/"))
    throw new DocumentPathError("Path must be relative");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in paths is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new DocumentPathError("Path contains control characters");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new DocumentPathError(`Path segment "${segment}" is not allowed`);
    }
  }
  if (segments[0] === ".git")
    throw new DocumentPathError("Path is not allowed");
  return segments.join("/");
}

export function isStorePath(path: string): boolean {
  return path === STORE_ROOT || path.startsWith(`${STORE_ROOT}/`);
}

/** MIME type by extension; `application/octet-stream` when unknown. */
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonc: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "application/sql",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

function isTextType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    /^application\/(json|yaml|toml|xml|sql|javascript|typescript)$/.test(
      contentType,
    ) ||
    contentType === "image/svg+xml"
  );
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The text of content that is text-like, valid UTF-8 and small enough. */
function textOf(bytes: Uint8Array, contentType: string): string | undefined {
  if (!isTextType(contentType) || bytes.byteLength > MAX_TEXT_BYTES) {
    return undefined;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Whether an identity may reach a path with the given access. Root: yes.
 * Program paths: builders read; viewers need a covering read ref; nobody
 * writes through this surface. Store paths: a covering document ref, for
 * everyone — a builder's project ref does not count.
 */
export function documentAccessAllowed(
  identity: Identity,
  projectId: string,
  path: string,
  access: "read" | "write",
): boolean {
  if (identity.scope === undefined) return true;
  const store = isStorePath(path);
  if (!store) {
    if (access === "write") return false;
    if (isBuilder(identity, projectId)) return true;
  }
  const ref: DocumentRef = { kind: "document", projectId, path, access };
  return scopeCovers(identity.scope, ref);
}

export interface DocumentsServiceDeps {
  projectManager: ProjectManager;
  /** Where store bytes go when content is not text; inline in Postgres otherwise. */
  blobStore?: DocumentBlobStore;
}

export class DocumentsService {
  private readonly projectManager: ProjectManager;
  private readonly blobStore?: DocumentBlobStore;

  constructor(
    private readonly db: Kysely<DB>,
    deps: DocumentsServiceDeps,
  ) {
    this.projectManager = deps.projectManager;
    this.blobStore = deps.blobStore;
  }

  /**
   * Files under a prefix (`""` = whole tree), program and store together,
   * filtered to what the caller may read. Store tombstones are omitted.
   */
  async list(args: {
    identity: Identity;
    projectId: string;
    prefix?: string;
    source?: DocumentSource;
  }): Promise<DocumentEntry[]> {
    await this.requireProject(args.identity, args.projectId);
    const prefix = args.prefix ? `${normalizeDocumentPath(args.prefix)}/` : "";
    if (!this.mayReadAnythingUnder(args.identity, args.projectId, prefix)) {
      return [];
    }
    const entries: DocumentEntry[] = [];
    const wantsProgram =
      args.source !== "store" && !isStorePath(prefix.replace(/\/$/, ""));
    const wantsStore =
      args.source !== "program" &&
      (prefix === "" ||
        isStorePath(prefix.replace(/\/$/, "")) ||
        `${STORE_ROOT}/`.startsWith(prefix));

    if (wantsProgram) {
      const blobs = await withProgram(
        this.projectManager,
        args.identity.tenantId,
        args.projectId,
        (repo, ref) => listProgramBlobs(repo, ref, prefix),
      );
      for (const { path, digest } of blobs) {
        if (isStorePath(path)) continue; // gitignored by convention; never program
        if (
          !documentAccessAllowed(args.identity, args.projectId, path, "read")
        ) {
          continue;
        }
        entries.push({
          path,
          source: "program",
          contentType: contentTypeFor(path),
          size: -1,
          digest,
        });
      }
    }
    if (wantsStore) {
      const storePrefix = prefix.startsWith(`${STORE_ROOT}/`)
        ? prefix
        : `${STORE_ROOT}/`;
      const rows = await this.db
        .selectFrom("store_documents")
        .where("project_id", "=", args.projectId)
        .where("deleted", "=", false)
        .where("path", "like", `${escapeLike(storePrefix)}%`)
        .select([
          "path",
          "content_type",
          "size",
          "version",
          "written_by",
          "written_at",
        ])
        .orderBy("path", "asc")
        .execute();
      for (const row of rows) {
        if (
          !documentAccessAllowed(
            args.identity,
            args.projectId,
            row.path,
            "read",
          )
        ) {
          continue;
        }
        entries.push({
          path: row.path,
          source: "store",
          contentType: row.content_type,
          size: Number(row.size),
          version: row.version,
          writtenBy: row.written_by,
          writtenAt: row.written_at.toISOString(),
        });
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Metadata + text (when text-like) of one document. */
  async read(args: {
    identity: Identity;
    projectId: string;
    path: string;
    version?: number;
  }): Promise<DocumentContent> {
    const content = await this.readBytes(args);
    const { bytes, ...rest } = content;
    const text = bytes ? textOf(bytes, content.contentType) : undefined;
    return { ...rest, ...(text !== undefined ? { text } : {}) };
  }

  /** Metadata + raw bytes of one document (a version, for store paths). */
  async readBytes(args: {
    identity: Identity;
    projectId: string;
    path: string;
    version?: number;
  }): Promise<DocumentContent & { bytes: Uint8Array }> {
    await this.requireProject(args.identity, args.projectId);
    const path = normalizeDocumentPath(args.path);
    this.assertAccess(args.identity, args.projectId, path, "read");

    if (!isStorePath(path)) {
      const text = await withProgram(
        this.projectManager,
        args.identity.tenantId,
        args.projectId,
        (repo, ref) => readProgramFile(repo, ref, path),
      );
      if (text === null) throw new DocumentNotFoundError(path);
      const bytes = new TextEncoder().encode(text);
      return {
        path,
        source: "program",
        contentType: contentTypeFor(path),
        size: bytes.byteLength,
        bytes,
      };
    }

    const doc = await this.db
      .selectFrom("store_documents")
      .where("project_id", "=", args.projectId)
      .where("path", "=", path)
      .selectAll()
      .executeTakeFirst();
    if (!doc) throw new DocumentNotFoundError(path);
    if (args.version === undefined) {
      if (doc.deleted) throw new DocumentNotFoundError(path);
      return { ...this.entryOf(doc), bytes: await this.bytesOf(doc) };
    }
    const version = await this.db
      .selectFrom("store_document_versions")
      .where("document_id", "=", doc.id)
      .where("version", "=", args.version)
      .selectAll()
      .executeTakeFirst();
    if (!version || version.deleted) throw new DocumentNotFoundError(path);
    return {
      path,
      source: "store",
      contentType: version.content_type,
      size: Number(version.size),
      version: version.version,
      writtenBy: version.written_by,
      writtenAt: version.written_at.toISOString(),
      bytes: await this.bytesOf(version),
    };
  }

  /**
   * Write a store document: a new version, stamped with the caller. With
   * `ifVersion`, the write only lands when the document is at that version
   * (0 = must not exist yet); otherwise last write wins.
   */
  async write(args: {
    identity: Identity;
    projectId: string;
    path: string;
    content: Uint8Array | string;
    contentType?: string;
    ifVersion?: number;
  }): Promise<DocumentEntry> {
    return withSpan(
      {
        tracer,
        name: "documents.write",
        attributes: {
          "catamorphic.project.id": args.projectId,
          "catamorphic.tenant.id": args.identity.tenantId,
        },
      },
      () => this.writeInner(args),
    );
  }

  private async writeInner(args: {
    identity: Identity;
    projectId: string;
    path: string;
    content: Uint8Array | string;
    contentType?: string;
    ifVersion?: number;
  }): Promise<DocumentEntry> {
    await this.requireProject(args.identity, args.projectId);
    const path = normalizeDocumentPath(args.path);
    if (!isStorePath(path) || path === STORE_ROOT) {
      throw new DocumentPathError(
        `Only paths under ${STORE_ROOT}/ are writable; the program changes by commit`,
      );
    }
    this.assertAccess(args.identity, args.projectId, path, "write");
    const bytes =
      typeof args.content === "string"
        ? new TextEncoder().encode(args.content)
        : args.content;
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new DocumentTooLargeError(path);
    }
    const contentType = args.contentType ?? contentTypeFor(path);
    const text = textOf(bytes, contentType);
    const writtenBy = args.identity.externalUserId;

    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("store_documents")
        .where("project_id", "=", args.projectId)
        .where("path", "=", path)
        .forUpdate()
        .selectAll()
        .executeTakeFirst();
      const currentVersion = current?.version ?? 0;
      if (args.ifVersion !== undefined && args.ifVersion !== currentVersion) {
        throw new DocumentConflictError(path, currentVersion);
      }
      const version = currentVersion + 1;
      const documentId =
        current?.id ??
        (
          await trx
            .insertInto("store_documents")
            .values({
              project_id: args.projectId,
              path,
              version: 0,
              content_type: contentType,
              size: 0,
              written_by: writtenBy,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;

      // Where the bytes live: inline text, the blob backend, or inline bytes.
      let blobKey: string | null = null;
      let inlineBytes: Buffer | null = null;
      if (text === undefined) {
        if (this.blobStore) {
          blobKey = blobKeyFor(
            args.identity.tenantId,
            args.projectId,
            documentId,
            version,
          );
          await this.blobStore.put(blobKey, bytes);
        } else {
          inlineBytes = Buffer.from(bytes);
        }
      }
      const writtenAt = new Date();
      await trx
        .insertInto("store_document_versions")
        .values({
          document_id: documentId,
          version,
          deleted: false,
          content_type: contentType,
          size: bytes.byteLength,
          text_content: text ?? null,
          bytes: inlineBytes,
          blob_key: blobKey,
          written_by: writtenBy,
          written_at: writtenAt,
        })
        .execute();
      await trx
        .updateTable("store_documents")
        .set({
          version,
          deleted: false,
          content_type: contentType,
          size: bytes.byteLength,
          text_content: text ?? null,
          bytes: inlineBytes,
          blob_key: blobKey,
          written_by: writtenBy,
          written_at: writtenAt,
        })
        .where("id", "=", documentId)
        .execute();
      return {
        path,
        source: "store",
        contentType,
        size: bytes.byteLength,
        version,
        writtenBy,
        writtenAt: writtenAt.toISOString(),
      };
    });
  }

  /** Delete a store document: a tombstone version; history stays readable. */
  async delete(args: {
    identity: Identity;
    projectId: string;
    path: string;
    ifVersion?: number;
  }): Promise<{ version: number }> {
    await this.requireProject(args.identity, args.projectId);
    const path = normalizeDocumentPath(args.path);
    if (!isStorePath(path)) {
      throw new DocumentPathError(
        `Only paths under ${STORE_ROOT}/ can be deleted here`,
      );
    }
    this.assertAccess(args.identity, args.projectId, path, "write");
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("store_documents")
        .where("project_id", "=", args.projectId)
        .where("path", "=", path)
        .forUpdate()
        .selectAll()
        .executeTakeFirst();
      if (!current || current.deleted) throw new DocumentNotFoundError(path);
      if (args.ifVersion !== undefined && args.ifVersion !== current.version) {
        throw new DocumentConflictError(path, current.version);
      }
      const version = current.version + 1;
      const writtenAt = new Date();
      await trx
        .insertInto("store_document_versions")
        .values({
          document_id: current.id,
          version,
          deleted: true,
          content_type: current.content_type,
          size: 0,
          written_by: args.identity.externalUserId,
          written_at: writtenAt,
        })
        .execute();
      await trx
        .updateTable("store_documents")
        .set({
          version,
          deleted: true,
          size: 0,
          text_content: null,
          bytes: null,
          blob_key: null,
          written_by: args.identity.externalUserId,
          written_at: writtenAt,
        })
        .where("id", "=", current.id)
        .execute();
      return { version };
    });
  }

  /** A store document's versions, newest first. */
  async history(args: {
    identity: Identity;
    projectId: string;
    path: string;
  }): Promise<DocumentVersion[]> {
    await this.requireProject(args.identity, args.projectId);
    const path = normalizeDocumentPath(args.path);
    this.assertAccess(args.identity, args.projectId, path, "read");
    if (!isStorePath(path)) return [];
    const doc = await this.db
      .selectFrom("store_documents")
      .where("project_id", "=", args.projectId)
      .where("path", "=", path)
      .select("id")
      .executeTakeFirst();
    if (!doc) throw new DocumentNotFoundError(path);
    const rows = await this.db
      .selectFrom("store_document_versions")
      .where("document_id", "=", doc.id)
      .select([
        "version",
        "deleted",
        "content_type",
        "size",
        "written_by",
        "written_at",
      ])
      .orderBy("version", "desc")
      .execute();
    return rows.map((row) => ({
      version: row.version,
      deleted: row.deleted,
      contentType: row.content_type,
      size: Number(row.size),
      writtenBy: row.written_by,
      writtenAt: row.written_at.toISOString(),
    }));
  }

  /**
   * Search text documents the caller may read. `grep` = case-insensitive
   * literal substring; `text` = full-text (words, any order). Results carry
   * matching lines, capped per document and overall.
   */
  async search(args: {
    identity: Identity;
    projectId: string;
    query: string;
    mode?: "grep" | "text";
    prefix?: string;
    limit?: number;
  }): Promise<DocumentMatch[]> {
    await this.requireProject(args.identity, args.projectId);
    const query = args.query.trim();
    if (!query) return [];
    const mode = args.mode ?? "grep";
    const prefix = args.prefix ? `${normalizeDocumentPath(args.prefix)}/` : "";
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    if (!this.mayReadAnythingUnder(args.identity, args.projectId, prefix)) {
      return [];
    }
    const matches: DocumentMatch[] = [];
    const matcher = mode === "grep" ? grepMatcher(query) : textMatcher(query);

    // Program side: read the files under the prefix and match in process.
    if (!isStorePath(prefix.replace(/\/$/, ""))) {
      const files = await withProgram(
        this.projectManager,
        args.identity.tenantId,
        args.projectId,
        (repo, ref) => readProgramFiles(repo, ref, prefix),
      );
      for (const [path, content] of Object.entries(files)) {
        if (matches.length >= limit) break;
        if (isStorePath(path) || !isTextType(contentTypeFor(path))) continue;
        if (
          !documentAccessAllowed(args.identity, args.projectId, path, "read")
        ) {
          continue;
        }
        const lines = matcher(content);
        if (lines.length > 0) matches.push({ path, source: "program", lines });
      }
    }

    // Store side: let Postgres narrow, then compute lines from the text.
    if (matches.length < limit) {
      const storePrefix = prefix.startsWith(`${STORE_ROOT}/`)
        ? prefix
        : `${STORE_ROOT}/`;
      let q = this.db
        .selectFrom("store_documents")
        .where("project_id", "=", args.projectId)
        .where("deleted", "=", false)
        .where("text_content", "is not", null)
        .where("path", "like", `${escapeLike(storePrefix)}%`);
      q =
        mode === "grep"
          ? q.where("text_content", "ilike", `%${escapeLike(query)}%`)
          : q.where(
              sql<boolean>`search_vector @@ plainto_tsquery('simple', ${query})`,
            );
      const rows = await q
        .select(["path", "text_content"])
        .orderBy("path", "asc")
        .limit(limit * 4)
        .execute();
      for (const row of rows) {
        if (matches.length >= limit) break;
        if (
          !documentAccessAllowed(
            args.identity,
            args.projectId,
            row.path,
            "read",
          )
        ) {
          continue;
        }
        const lines = matcher(row.text_content ?? "");
        if (lines.length > 0)
          matches.push({ path: row.path, source: "store", lines });
      }
    }
    return matches;
  }

  private assertAccess(
    identity: Identity,
    projectId: string,
    path: string,
    access: "read" | "write",
  ): void {
    if (!documentAccessAllowed(identity, projectId, path, access)) {
      throw new AccessDeniedError();
    }
  }

  /**
   * Cheap pre-check for listing/search: a scoped identity with no document
   * ref (and no builder ref, for program prefixes) under this prefix gets
   * an empty answer without touching git or the store.
   */
  private mayReadAnythingUnder(
    identity: Identity,
    projectId: string,
    prefix: string,
  ): boolean {
    if (identity.scope === undefined) return true;
    if (
      !isStorePath(prefix.replace(/\/$/, "")) &&
      isBuilder(identity, projectId)
    ) {
      return true;
    }
    return identity.scope.some((ref) => {
      if (ref.kind !== "document" || ref.projectId !== projectId) return false;
      const refDir = ref.path.endsWith("/**")
        ? ref.path.slice(0, -2)
        : ref.path;
      return refDir.startsWith(prefix) || prefix.startsWith(refDir);
    });
  }

  private entryOf(doc: DocumentRow): DocumentEntry {
    return {
      path: doc.path,
      source: "store",
      contentType: doc.content_type,
      size: Number(doc.size),
      version: doc.version,
      writtenBy: doc.written_by,
      writtenAt: doc.written_at.toISOString(),
    };
  }

  private async bytesOf(row: {
    text_content: string | null;
    bytes: Buffer | null;
    blob_key: string | null;
    path?: string;
  }): Promise<Uint8Array> {
    if (row.text_content !== null)
      return new TextEncoder().encode(row.text_content);
    if (row.bytes) return new Uint8Array(row.bytes);
    if (row.blob_key && this.blobStore) {
      const blob = await this.blobStore.get(row.blob_key);
      if (blob) return blob.data;
    }
    return new Uint8Array();
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }
}

function blobKeyFor(
  tenantId: string,
  projectId: string,
  documentId: string,
  version: number,
): string {
  return `store/${tenantId}/${projectId}/${documentId}/${version}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const MAX_LINES_PER_DOC = 5;

function grepMatcher(query: string): (text: string) => DocumentMatch["lines"] {
  const needle = query.toLowerCase();
  return (text) =>
    matchLines(text, (line) => line.toLowerCase().includes(needle));
}

function textMatcher(query: string): (text: string) => DocumentMatch["lines"] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return (text) => {
    // A document matches when every word appears somewhere; the lines shown
    // are those carrying any of the words.
    const lower = text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) return [];
    return matchLines(text, (line) => {
      const l = line.toLowerCase();
      return words.some((w) => l.includes(w));
    });
  };
}

function matchLines(
  text: string,
  test: (line: string) => boolean,
): DocumentMatch["lines"] {
  const out: DocumentMatch["lines"] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_LINES_PER_DOC; i++) {
    const line = lines[i] ?? "";
    if (test(line)) out.push({ line: i + 1, text: line.slice(0, 400) });
  }
  return out;
}
