import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Identity } from "../identity.js";
import {
  DocumentConflictError,
  type DocumentEntry,
  DocumentNotFoundError,
  type DocumentsService,
  type DocumentVersion,
  normalizeDocumentPath,
} from "./documents-service.js";

/**
 * Store sync (ADR 0055): a folder is a working copy of the scoped tree a
 * documents surface serves — program paths (read-only here)
 * and `store/…` paths (read/write, versioned per write). Two verbs:
 *
 * - **sync** pulls: new/changed remote files land locally; a remote change
 *   to a store file the user also edited is kept BESIDE the local edit as
 *   `<name> (server v<N>).<ext>` and reported — no merge UI, no branches;
 *   files that vanished remotely are removed locally when unmodified.
 * - **ship** pushes: local edits and new files under `store/` go up with
 *   `ifVersion` = the version last synced; a 409 means someone wrote
 *   first — the server's copy is fetched beside the local one and
 *   reported; local deletions delete remotely. Edits outside `store/`
 *   are reported as not shippable (the program changes by commit/PR).
 *
 * State lives in `.catamorphic/remote-sync.json` in the folder: per path,
 * what was last synced (source, version/digest, content hash). Local
 * modification = current hash ≠ manifest hash.
 *
 * Two clients drive it: the desktop's HTTP client against a hosting
 * backend, and — on the server itself — {@link documentsClientFor}, which
 * lets an agent's working copy pull/ship `store/` around every turn AS THE
 * CALLER (so a member's agent writing `store/customers/acme/notes.md` in
 * its folder lands in the store with the right author, and never anything
 * the member may not write).
 */

/** The documents surface's own shapes; one definition, wherever it travels. */
export type RemoteDocumentEntry = DocumentEntry;
export type RemoteDocumentVersion = DocumentVersion;

/** The slice of the documents API the engine needs; injectable for tests. */
export interface RemoteDocumentsClient {
  /** Which sources `list()` covers; absent = both. Prunes only within. */
  readonly sources?: ReadonlyArray<"program" | "store">;
  list(): Promise<RemoteDocumentEntry[]>;
  readBytes(
    path: string,
    version?: number,
  ): Promise<{ bytes: Uint8Array; entry: RemoteDocumentEntry }>;
  write(input: {
    path: string;
    bytes: Uint8Array;
    contentType?: string;
    ifVersion?: number;
  }): Promise<
    | { ok: true; entry: RemoteDocumentEntry }
    | { ok: false; conflict: true; currentVersion: number }
  >;
  delete(input: {
    path: string;
    ifVersion?: number;
  }): Promise<
    | { ok: true; version: number }
    | { ok: false; conflict: true; currentVersion: number }
    | { ok: false; notFound: true }
  >;
  history(path: string): Promise<RemoteDocumentVersion[]>;
}

interface ManifestEntry {
  conflict?: { serverCopy: string; serverVersion: number };
  source: "program" | "store";
  version?: number;
  digest?: string;
  hash: string;
  /**
   * The local file's stat when it last matched `hash` (after a pull or a
   * ship). Lets `localStatus` skip re-hashing untouched files: same
   * size + mtime = unchanged; anything else falls back to the hash.
   */
  stat?: { size: number; mtimeMs: number };
}

interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
  serverCopies?: string[];
}

export const MANIFEST_PATH = ".catamorphic/remote-sync.json";
export const STORE_PREFIX = "store/";

export interface SyncReport {
  pulled: string[];
  removed: string[];
  /** Remote changed AND local changed: server copy written beside. */
  conflicts: Array<{ path: string; serverCopy: string; serverVersion: number }>;
  unchanged: number;
}

export interface ShipReport {
  shipped: string[];
  deleted: string[];
  conflicts: Array<{
    path: string;
    serverCopy: string;
    currentVersion: number;
  }>;
  /** Local edits to program paths: cannot ship (propose a change instead). */
  notShippable: string[];
  /** Writes/deletes the server refused (not authorized, invalid path…). */
  failed: Array<{ path: string; error: string }>;
}

export interface LocalStatus {
  /** Unresolved server versions. Uploading requires an explicit resolution. */
  conflicts: Array<{ path: string; serverCopy: string; serverVersion: number }>;
  /** Store paths edited or created locally since the last sync. */
  modified: string[];
  /** Store paths deleted locally since the last sync. */
  deleted: string[];
  /** Program paths edited locally (read-only through the store). */
  programEdits: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readManifest(root: string): Manifest {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, MANIFEST_PATH), "utf8"),
    ) as Partial<Manifest>;
    if (raw.version === 1 && raw.files && typeof raw.files === "object") {
      return {
        version: 1,
        files: raw.files,
        serverCopies: raw.serverCopies ?? [],
      };
    }
  } catch {
    // Absent or unreadable: first sync.
  }
  return { version: 1, files: {} };
}

function writeManifest(root: string, manifest: Manifest): void {
  const target = path.join(root, MANIFEST_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sorted: Manifest = {
    version: 1,
    serverCopies: manifest.serverCopies ?? [],
    files: Object.fromEntries(
      Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function localPath(root: string, relative: string): string {
  normalizeDocumentPath(relative);
  if (relative === MANIFEST_PATH)
    throw new Error("The synchronization manifest is local state");
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error(`Path escapes the project: ${relative}`);
  const canonicalRoot = fs.realpathSync(root);
  let ancestor = target;
  while (ancestor !== path.resolve(root)) {
    if (fs.existsSync(ancestor)) {
      const canonical = fs.realpathSync(ancestor);
      if (
        canonical !== canonicalRoot &&
        !canonical.startsWith(`${canonicalRoot}${path.sep}`)
      )
        throw new Error(`Path follows a link outside the project: ${relative}`);
    }
    ancestor = path.dirname(ancestor);
  }
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(
      `Refusing to write outside the project folder: ${relative}`,
    );
  }
  return target;
}

function readLocal(root: string, relative: string): Uint8Array | null {
  try {
    return new Uint8Array(fs.readFileSync(localPath(root, relative)));
  } catch {
    return null;
  }
}

function writeLocal(root: string, relative: string, bytes: Uint8Array): void {
  const target = localPath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

/** The local file's stat, for the manifest's cheap unchanged check. */
function statLocal(
  root: string,
  relative: string,
): ManifestEntry["stat"] | undefined {
  try {
    const stat = fs.statSync(localPath(root, relative));
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Whether a local file is unchanged since its manifest entry, cheaply
 * when the stat matches, by content hash otherwise. */
function unchangedLocally(
  root: string,
  relative: string,
  entry: ManifestEntry,
): boolean {
  if (entry.stat) {
    const stat = statLocal(root, relative);
    if (
      stat &&
      stat.size === entry.stat.size &&
      stat.mtimeMs === entry.stat.mtimeMs
    ) {
      return true;
    }
  }
  const bytes = readLocal(root, relative);
  return bytes !== null && sha256(bytes) === entry.hash;
}

/** `store/customers/acme/notes.md` → `store/customers/acme/notes (server v3).md` */
export function serverCopyPath(relative: string, version: number): string {
  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  return `${base} (server v${version})${ext}`;
}

function writeServerCopy(
  root: string,
  manifest: Manifest,
  relative: string,
  version: number,
  bytes: Uint8Array,
): string {
  const initial = serverCopyPath(relative, version);
  let copy = initial;
  for (let suffix = 2; ; suffix++) {
    const existing = readLocal(root, copy);
    if (!existing || sha256(existing) === sha256(bytes)) break;
    const ext = path.extname(initial);
    copy = `${initial.slice(0, initial.length - ext.length)}-${suffix}${ext}`;
  }
  writeLocal(root, copy, bytes);
  manifest.serverCopies = [
    ...new Set([...(manifest.serverCopies ?? []), copy]),
  ];
  return copy;
}

/** Every file under `store/` in the folder, relative, forward-slashed. */
function walkStore(root: string): string[] {
  const out: string[] = [];
  const storeDir = path.join(root, STORE_PREFIX);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(storeDir);
  return out.sort();
}

/** What changed locally since the last sync, without touching the network. */
export function localStatus(root: string): LocalStatus {
  const manifest = readManifest(root);
  const modified: string[] = [];
  const deleted: string[] = [];
  const programEdits: string[] = [];
  const seen = new Set<string>();
  for (const relative of walkStore(root)) {
    // Server copies from a conflict are scratch, never shipped.
    if (manifest.serverCopies?.includes(relative)) continue;
    seen.add(relative);
    const entry = manifest.files[relative];
    if (!entry || !unchangedLocally(root, relative, entry)) {
      modified.push(relative);
    }
  }
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (entry.source === "store") {
      if (!seen.has(relative) && !fs.existsSync(localPath(root, relative))) {
        deleted.push(relative);
      }
      continue;
    }
    if (
      fs.existsSync(localPath(root, relative)) &&
      !unchangedLocally(root, relative, entry)
    ) {
      programEdits.push(relative);
    }
  }
  const conflicts = Object.entries(manifest.files).flatMap(([path, entry]) =>
    entry.conflict ? [{ path, ...entry.conflict }] : [],
  );
  return { modified, deleted, programEdits, conflicts };
}

const pendingOperations = new Map<string, Promise<unknown>>();
async function serializeSync<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = fs.realpathSync(root);
  const previous = pendingOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pendingOperations.set(key, current);
  try {
    return await current;
  } finally {
    if (pendingOperations.get(key) === current) pendingOperations.delete(key);
  }
}

export function syncRemoteProject(
  root: string,
  client: RemoteDocumentsClient,
): Promise<SyncReport> {
  return serializeSync(root, () => syncRemoteProjectInner(root, client));
}
export function shipRemoteProject(
  root: string,
  client: RemoteDocumentsClient,
  options?: { paths: readonly string[]; resolveConflicts?: readonly string[] },
): Promise<ShipReport> {
  return serializeSync(root, () =>
    shipRemoteProjectInner(root, client, options),
  );
}

/** Pull the scoped tree into the folder. */
async function syncRemoteProjectInner(
  root: string,
  client: RemoteDocumentsClient,
): Promise<SyncReport> {
  const manifest = readManifest(root);
  const remote = await client.list();
  const report: SyncReport = {
    pulled: [],
    removed: [],
    conflicts: [],
    unchanged: 0,
  };
  const remotePaths = new Set<string>();

  for (const entry of remote) {
    remotePaths.add(entry.path);
    const known = manifest.files[entry.path];
    const remoteMarker =
      entry.source === "store"
        ? String(entry.version ?? 0)
        : (entry.digest ?? "");
    const knownMarker =
      known?.source === "store"
        ? String(known.version ?? 0)
        : (known?.digest ?? "");
    if (known?.conflict) {
      report.conflicts.push({ path: entry.path, ...known.conflict });
      continue;
    }

    if (known && knownMarker === remoteMarker) {
      report.unchanged += 1;
      continue;
    }
    const { bytes } = await client.readBytes(entry.path);
    const local = readLocal(root, entry.path);
    const localModified =
      local !== null
        ? !known || sha256(local) !== known.hash
        : known !== undefined;
    if (localModified && (local === null || sha256(local) !== sha256(bytes))) {
      // Both sides moved: keep the user's edit, park the server's beside it
      // (program files too — a local program edit is a commit-in-waiting,
      // never something a pull may silently revert).
      const copy = writeServerCopy(
        root,
        manifest,
        entry.path,
        entry.version ?? 0,
        bytes,
      );
      report.conflicts.push({
        path: entry.path,
        serverCopy: copy,
        serverVersion: entry.version ?? 0,
      });
      // The manifest now knows the server state; the local edit still
      // differs from it, so `ship` will offer it (and 409 if it lost again).
      manifest.files[entry.path] = {
        source: entry.source,
        ...(entry.source === "store"
          ? { version: entry.version }
          : { digest: entry.digest }),
        hash: sha256(bytes),
        conflict: { serverCopy: copy, serverVersion: entry.version ?? 0 },
      };
      continue;
    }
    writeLocal(root, entry.path, bytes);
    manifest.files[entry.path] = {
      source: entry.source,
      ...(entry.source === "store"
        ? { version: entry.version }
        : { digest: entry.digest }),
      hash: sha256(bytes),
      stat: statLocal(root, entry.path),
    };
    writeManifest(root, manifest);
    report.pulled.push(entry.path);
  }

  // Gone remotely: remove locally unless the user changed it since. Only
  // for sources this client lists — a store-only client must never prune
  // program files an earlier full sync recorded.
  const covered = new Set(client.sources ?? ["program", "store"]);
  for (const [relative, known] of Object.entries(manifest.files)) {
    if (remotePaths.has(relative)) continue;
    if (!covered.has(known.source)) continue;
    const local = readLocal(root, relative);
    if (local && sha256(local) === known.hash) {
      fs.rmSync(localPath(root, relative), { force: true });
      report.removed.push(relative);
    }
    delete manifest.files[relative];
  }

  writeManifest(root, manifest);
  return report;
}

/** Push local store changes. */
async function shipRemoteProjectInner(
  root: string,
  client: RemoteDocumentsClient,
  options?: { paths: readonly string[]; resolveConflicts?: readonly string[] },
): Promise<ShipReport> {
  const manifest = readManifest(root);
  const status = localStatus(root);
  const report: ShipReport = {
    shipped: [],
    deleted: [],
    conflicts: [],
    notShippable: status.programEdits,
    failed: [],
  };
  const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  const selected = options
    ? new Set(options.paths.map(normalizeDocumentPath))
    : null;
  const resolutions = new Set(options?.resolveConflicts ?? []);
  const mayUpload = (relative: string): boolean => {
    if (selected && !selected.has(relative)) return false;
    const conflict = manifest.files[relative]?.conflict;
    if (conflict && !resolutions.has(relative)) {
      report.conflicts.push({
        path: relative,
        serverCopy: conflict.serverCopy,
        currentVersion: conflict.serverVersion,
      });
      return false;
    }
    return true;
  };
  for (const relative of status.modified) {
    if (!mayUpload(relative)) continue;
    const bytes = readLocal(root, relative);
    if (!bytes) continue;
    const known = manifest.files[relative];
    let result: Awaited<ReturnType<RemoteDocumentsClient["write"]>>;
    try {
      result = await client.write({
        path: relative,
        bytes,
        ifVersion: known?.version ?? 0,
      });
    } catch (error) {
      // One refused file must not strand the rest (or the manifest).
      report.failed.push({ path: relative, error: describe(error) });
      continue;
    }
    if (result.ok) {
      manifest.files[relative] = {
        source: "store",
        version: result.entry.version,
        hash: sha256(bytes),
      };
      writeManifest(root, manifest);
      report.shipped.push(relative);
      continue;
    }
    // Someone wrote first: fetch theirs beside ours, remember their version
    // so the next ship (after the user reconciles) can win. A conflict
    // against a tombstone (they deleted it) has nothing to fetch: just
    // remember the version so the retry supersedes the deletion.
    const theirs = await client.readBytes(relative).catch(() => null);
    const copy = theirs
      ? writeServerCopy(
          root,
          manifest,
          relative,
          result.currentVersion,
          theirs.bytes,
        )
      : serverCopyPath(relative, result.currentVersion);
    manifest.files[relative] = {
      source: "store",
      version: result.currentVersion,
      hash: theirs ? sha256(theirs.bytes) : "",
      conflict: { serverCopy: copy, serverVersion: result.currentVersion },
    };
    report.conflicts.push({
      path: relative,
      serverCopy: copy,
      currentVersion: result.currentVersion,
    });
  }

  for (const relative of status.deleted) {
    if (!mayUpload(relative)) continue;
    const known = manifest.files[relative];
    let result: Awaited<ReturnType<RemoteDocumentsClient["delete"]>>;
    try {
      result = await client.delete({
        path: relative,
        ifVersion: known?.version,
      });
    } catch (error) {
      report.failed.push({ path: relative, error: describe(error) });
      continue;
    }
    if (result.ok || !("conflict" in result)) {
      delete manifest.files[relative];
      writeManifest(root, manifest);
      report.deleted.push(relative);
      continue;
    }
    // Deleted here, edited there: bring theirs back beside nothing — the
    // user sees the server copy and decides.
    const theirs = await client.readBytes(relative).catch(() => null);
    const copy = theirs
      ? writeServerCopy(
          root,
          manifest,
          relative,
          result.currentVersion,
          theirs.bytes,
        )
      : serverCopyPath(relative, result.currentVersion);
    manifest.files[relative] = {
      source: "store",
      version: result.currentVersion,
      hash: theirs ? sha256(theirs.bytes) : "",
      conflict: { serverCopy: copy, serverVersion: result.currentVersion },
    };
    report.conflicts.push({
      path: relative,
      serverCopy: copy,
      currentVersion: result.currentVersion,
    });
  }

  writeManifest(root, manifest);
  return report;
}

/**
 * A {@link RemoteDocumentsClient} over the in-process documents surface,
 * bound to one identity — what the server uses around agent turns.
 */
export function documentsClientFor(
  documents: DocumentsService,
  identity: Identity,
  projectId: string,
  opts?: { source?: "program" | "store" },
): RemoteDocumentsClient {
  return {
    ...(opts?.source ? { sources: [opts.source] } : {}),
    list: () =>
      documents.list({
        identity,
        projectId,
        ...(opts?.source ? { source: opts.source } : {}),
      }),
    async readBytes(relative, version) {
      const doc = await documents.readBytes({
        identity,
        projectId,
        path: relative,
        ...(version !== undefined ? { version } : {}),
      });
      const { bytes, ...entry } = doc;
      return { bytes, entry };
    },
    async write(input) {
      try {
        const entry = await documents.write({
          identity,
          projectId,
          path: input.path,
          content: input.bytes,
          ...(input.contentType ? { contentType: input.contentType } : {}),
          ...(input.ifVersion !== undefined
            ? { ifVersion: input.ifVersion }
            : {}),
        });
        return { ok: true, entry };
      } catch (error) {
        if (error instanceof DocumentConflictError) {
          return {
            ok: false,
            conflict: true,
            currentVersion: error.currentVersion,
          };
        }
        throw error;
      }
    },
    async delete(input) {
      try {
        const result = await documents.delete({
          identity,
          projectId,
          path: input.path,
          ...(input.ifVersion !== undefined
            ? { ifVersion: input.ifVersion }
            : {}),
        });
        return { ok: true, version: result.version };
      } catch (error) {
        if (error instanceof DocumentConflictError) {
          return {
            ok: false,
            conflict: true,
            currentVersion: error.currentVersion,
          };
        }
        if (error instanceof DocumentNotFoundError)
          return { ok: false, notFound: true };
        throw error;
      }
    },
    history: (relative) =>
      documents.history({ identity, projectId, path: relative }),
  };
}
