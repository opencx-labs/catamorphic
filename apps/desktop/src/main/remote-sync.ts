import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Remote project sync (ADR 0055): a local folder is a working copy of the
 * scoped tree a hosting backend serves — program paths (read-only here)
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
 */

export interface RemoteDocumentEntry {
  path: string;
  source: "program" | "store";
  contentType: string;
  size: number;
  version?: number;
  writtenBy?: string;
  writtenAt?: string;
  digest?: string;
}

export interface RemoteDocumentVersion {
  version: number;
  deleted: boolean;
  contentType: string;
  size: number;
  writtenBy: string;
  writtenAt: string;
}

/** The slice of the documents API the engine needs; injectable for tests. */
export interface RemoteDocumentsClient {
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
  source: "program" | "store";
  version?: number;
  digest?: string;
  hash: string;
}

interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
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
}

export interface LocalStatus {
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
      return { version: 1, files: raw.files };
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
    files: Object.fromEntries(
      Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  fs.writeFileSync(target, `${JSON.stringify(sorted, null, 2)}\n`);
}

function localPath(root: string, relative: string): string {
  const target = path.resolve(root, relative);
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

/** `store/customers/acme/notes.md` → `store/customers/acme/notes (server v3).md` */
export function serverCopyPath(relative: string, version: number): string {
  const ext = path.extname(relative);
  const base = relative.slice(0, relative.length - ext.length);
  return `${base} (server v${version})${ext}`;
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
    if (/ \(server v\d+\)(\.[^/]*)?$/.test(relative)) continue;
    seen.add(relative);
    const bytes = readLocal(root, relative);
    if (!bytes) continue;
    const entry = manifest.files[relative];
    if (!entry || entry.hash !== sha256(bytes)) modified.push(relative);
  }
  for (const [relative, entry] of Object.entries(manifest.files)) {
    if (entry.source === "store") {
      if (!seen.has(relative) && !fs.existsSync(localPath(root, relative))) {
        deleted.push(relative);
      }
      continue;
    }
    const bytes = readLocal(root, relative);
    if (bytes && sha256(bytes) !== entry.hash) programEdits.push(relative);
  }
  return { modified, deleted, programEdits };
}

/** Pull the scoped tree into the folder. */
export async function syncRemoteProject(
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
    const local = readLocal(root, entry.path);
    const localModified =
      known !== undefined && local !== null && sha256(local) !== known.hash;

    if (known && knownMarker === remoteMarker && local !== null) {
      report.unchanged += 1;
      continue;
    }
    const { bytes } = await client.readBytes(entry.path);
    if (localModified && entry.source === "store") {
      // Both sides moved: keep the user's edit, park the server's beside it.
      const copy = serverCopyPath(entry.path, entry.version ?? 0);
      writeLocal(root, copy, bytes);
      report.conflicts.push({
        path: entry.path,
        serverCopy: copy,
        serverVersion: entry.version ?? 0,
      });
      // The manifest now knows the server version; the local edit still
      // differs from it, so `ship` will offer it (and 409 if it lost again).
      manifest.files[entry.path] = {
        source: "store",
        version: entry.version,
        hash: sha256(bytes),
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
    };
    report.pulled.push(entry.path);
  }

  // Gone remotely: remove locally unless the user changed it since.
  for (const [relative, known] of Object.entries(manifest.files)) {
    if (remotePaths.has(relative)) continue;
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
export async function shipRemoteProject(
  root: string,
  client: RemoteDocumentsClient,
): Promise<ShipReport> {
  const manifest = readManifest(root);
  const status = localStatus(root);
  const report: ShipReport = {
    shipped: [],
    deleted: [],
    conflicts: [],
    notShippable: status.programEdits,
  };

  for (const relative of status.modified) {
    const bytes = readLocal(root, relative);
    if (!bytes) continue;
    const known = manifest.files[relative];
    const result = await client.write({
      path: relative,
      bytes,
      ifVersion: known?.version ?? 0,
    });
    if (result.ok) {
      manifest.files[relative] = {
        source: "store",
        version: result.entry.version,
        hash: sha256(bytes),
      };
      report.shipped.push(relative);
      continue;
    }
    // Someone wrote first: fetch theirs beside ours, remember their version
    // so the next ship (after the user reconciles) can win.
    const theirs = await client.readBytes(relative);
    const copy = serverCopyPath(relative, result.currentVersion);
    writeLocal(root, copy, theirs.bytes);
    manifest.files[relative] = {
      source: "store",
      version: result.currentVersion,
      hash: sha256(theirs.bytes),
    };
    report.conflicts.push({
      path: relative,
      serverCopy: copy,
      currentVersion: result.currentVersion,
    });
  }

  for (const relative of status.deleted) {
    const known = manifest.files[relative];
    const result = await client.delete({
      path: relative,
      ifVersion: known?.version,
    });
    if (result.ok || !("conflict" in result)) {
      delete manifest.files[relative];
      report.deleted.push(relative);
      continue;
    }
    // Deleted here, edited there: bring theirs back beside nothing — the
    // user sees the server copy and decides.
    const theirs = await client.readBytes(relative);
    const copy = serverCopyPath(relative, result.currentVersion);
    writeLocal(root, copy, theirs.bytes);
    manifest.files[relative] = {
      source: "store",
      version: result.currentVersion,
      hash: sha256(theirs.bytes),
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

/** An HTTP client for a hosting backend's documents routes. */
export function httpDocumentsClient(args: {
  serverUrl: string;
  token: string;
  projectId: string;
  fetch?: typeof fetch;
}): RemoteDocumentsClient {
  const doFetch = args.fetch ?? fetch;
  const base = `${args.serverUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(args.projectId)}/documents`;
  const headers = { authorization: `Bearer ${args.token}` };
  const q = (params: Record<string, string | number | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&");
  const fail = async (response: Response, what: string): Promise<never> => {
    let detail = "";
    try {
      detail = ((await response.json()) as { error?: string }).error ?? "";
    } catch {
      // no body
    }
    throw new Error(
      `${what} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  };
  return {
    async list() {
      const response = await doFetch(base, { headers });
      if (!response.ok) return fail(response, "Listing documents");
      return (await response.json()) as RemoteDocumentEntry[];
    },
    async readBytes(relative, version) {
      const response = await doFetch(
        `${base}/raw?${q({ path: relative, version })}`,
        {
          headers,
        },
      );
      if (!response.ok) return fail(response, `Reading ${relative}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const versionHeader = response.headers.get(
        "x-catamorphic-document-version",
      );
      const source = response.headers.get("x-catamorphic-document-source");
      return {
        bytes,
        entry: {
          path: relative,
          source: source === "store" ? "store" : "program",
          contentType:
            response.headers.get("content-type") ?? "application/octet-stream",
          size: bytes.byteLength,
          ...(versionHeader ? { version: Number(versionHeader) } : {}),
        },
      };
    },
    async write(input) {
      const response = await doFetch(`${base}/content`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          path: input.path,
          base64: Buffer.from(input.bytes).toString("base64"),
          ...(input.contentType ? { contentType: input.contentType } : {}),
          ...(input.ifVersion !== undefined
            ? { ifVersion: input.ifVersion }
            : {}),
        }),
      });
      if (response.status === 409) {
        const body = (await response.json()) as { currentVersion: number };
        return {
          ok: false,
          conflict: true,
          currentVersion: body.currentVersion,
        };
      }
      if (!response.ok) return fail(response, `Writing ${input.path}`);
      return {
        ok: true,
        entry: (await response.json()) as RemoteDocumentEntry,
      };
    },
    async delete(input) {
      const response = await doFetch(
        `${base}/content?${q({ path: input.path, ifVersion: input.ifVersion })}`,
        { method: "DELETE", headers },
      );
      if (response.status === 409) {
        const body = (await response.json()) as { currentVersion: number };
        return {
          ok: false,
          conflict: true,
          currentVersion: body.currentVersion,
        };
      }
      if (response.status === 404) return { ok: false, notFound: true };
      if (!response.ok) return fail(response, `Deleting ${input.path}`);
      return {
        ok: true,
        version: ((await response.json()) as { version: number }).version,
      };
    },
    async history(relative) {
      const response = await doFetch(
        `${base}/history?${q({ path: relative })}`,
        {
          headers,
        },
      );
      if (!response.ok) return fail(response, `History of ${relative}`);
      return (await response.json()) as RemoteDocumentVersion[];
    },
  };
}
