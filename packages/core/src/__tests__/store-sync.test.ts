import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  localStatus,
  MANIFEST_PATH,
  type RemoteDocumentEntry,
  type RemoteDocumentsClient,
  serverCopyPath,
  shipRemoteProject,
  syncRemoteProject,
} from "../services/store-sync.js";

/** An in-memory hosting backend: program files by digest, store by version. */
class FakeServer implements RemoteDocumentsClient {
  program = new Map<string, string>();
  store = new Map<
    string,
    { version: number; text: string; deleted: boolean }
  >();
  readonly writes: string[] = [];

  async list(): Promise<RemoteDocumentEntry[]> {
    const entries: RemoteDocumentEntry[] = [];
    for (const [p, text] of this.program) {
      entries.push({
        path: p,
        source: "program",
        contentType: "text/markdown",
        size: -1,
        digest: `git:${text.length}:${text}`,
      });
    }
    for (const [p, doc] of this.store) {
      if (doc.deleted) continue;
      entries.push({
        path: p,
        source: "store",
        contentType: "text/markdown",
        size: doc.text.length,
        version: doc.version,
        writtenBy: "server",
      });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async readBytes(p: string) {
    const program = this.program.get(p);
    if (program !== undefined) {
      return {
        bytes: new TextEncoder().encode(program),
        entry: {
          path: p,
          source: "program" as const,
          contentType: "text/markdown",
          size: program.length,
        },
      };
    }
    const doc = this.store.get(p);
    if (!doc || doc.deleted) throw new Error(`Reading ${p} failed (404)`);
    return {
      bytes: new TextEncoder().encode(doc.text),
      entry: {
        path: p,
        source: "store" as const,
        contentType: "text/markdown",
        size: doc.text.length,
        version: doc.version,
      },
    };
  }
  async write(input: { path: string; bytes: Uint8Array; ifVersion?: number }) {
    const current = this.store.get(input.path);
    const currentVersion = current?.version ?? 0;
    if (input.ifVersion !== undefined && input.ifVersion !== currentVersion) {
      return { ok: false as const, conflict: true as const, currentVersion };
    }
    const version = currentVersion + 1;
    const text = new TextDecoder().decode(input.bytes);
    this.store.set(input.path, { version, text, deleted: false });
    this.writes.push(`${input.path}@${version}`);
    return {
      ok: true as const,
      entry: {
        path: input.path,
        source: "store" as const,
        contentType: "text/markdown",
        size: text.length,
        version,
      },
    };
  }
  async delete(input: { path: string; ifVersion?: number }) {
    const current = this.store.get(input.path);
    if (!current || current.deleted)
      return { ok: false as const, notFound: true as const };
    if (input.ifVersion !== undefined && input.ifVersion !== current.version) {
      return {
        ok: false as const,
        conflict: true as const,
        currentVersion: current.version,
      };
    }
    current.version += 1;
    current.deleted = true;
    return { ok: true as const, version: current.version };
  }
  async history() {
    return [];
  }
}

const read = (root: string, p: string) =>
  fs.readFileSync(path.join(root, p), "utf8");
const write = (root: string, p: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), text);
};

describe("remote project sync (ADR 0055)", () => {
  let root: string;
  let server: FakeServer;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-remote-"));
    server = new FakeServer();
    server.program.set("docs/handbook.md", "# Handbook\n");
    server.store.set("store/customers/acme/notes.md", {
      version: 2,
      text: "Acme notes v2\n",
      deleted: false,
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("first sync materializes the scoped tree and records the manifest", async () => {
    const report = await syncRemoteProject(root, server);
    expect(report.pulled.sort()).toEqual([
      "docs/handbook.md",
      "store/customers/acme/notes.md",
    ]);
    expect(read(root, "docs/handbook.md")).toBe("# Handbook\n");
    expect(read(root, "store/customers/acme/notes.md")).toBe("Acme notes v2\n");
    const manifest = JSON.parse(read(root, MANIFEST_PATH)) as {
      files: Record<string, { source: string; version?: number }>;
    };
    expect(manifest.files["store/customers/acme/notes.md"]).toMatchObject({
      source: "store",
      version: 2,
    });
    // A second sync with nothing changed touches nothing.
    const again = await syncRemoteProject(root, server);
    expect(again.pulled).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  it("ship pushes local store edits and new files with the synced version; program edits are not shippable", async () => {
    await syncRemoteProject(root, server);
    write(root, "store/customers/acme/notes.md", "Acme notes v2 + my edit\n");
    write(root, "store/customers/acme/brief.md", "# Brief\n");
    write(root, "docs/handbook.md", "# Handbook (edited locally)\n");
    expect(localStatus(root)).toEqual({
      modified: [
        "store/customers/acme/brief.md",
        "store/customers/acme/notes.md",
      ],
      deleted: [],
      programEdits: ["docs/handbook.md"],
    });
    const report = await shipRemoteProject(root, server);
    expect(report.shipped.sort()).toEqual([
      "store/customers/acme/brief.md",
      "store/customers/acme/notes.md",
    ]);
    expect(report.notShippable).toEqual(["docs/handbook.md"]);
    expect(server.writes).toEqual([
      "store/customers/acme/brief.md@1",
      "store/customers/acme/notes.md@3",
    ]);
    // Clean after shipping: nothing left to ship.
    expect(localStatus(root).modified).toEqual([]);
  });

  it("ship conflict: someone wrote first → their copy lands beside ours, ours stays, next ship wins", async () => {
    await syncRemoteProject(root, server);
    write(root, "store/customers/acme/notes.md", "my edit\n");
    // Meanwhile the server moved to v3.
    server.store.set("store/customers/acme/notes.md", {
      version: 3,
      text: "their edit\n",
      deleted: false,
    });
    const report = await shipRemoteProject(root, server);
    expect(report.shipped).toEqual([]);
    const copy = serverCopyPath("store/customers/acme/notes.md", 3);
    expect(report.conflicts).toEqual([
      {
        path: "store/customers/acme/notes.md",
        serverCopy: copy,
        currentVersion: 3,
      },
    ]);
    expect(read(root, copy)).toBe("their edit\n");
    expect(read(root, "store/customers/acme/notes.md")).toBe("my edit\n");
    // The user reconciles (keeps theirs, say) and ships again: lands at v4.
    const again = await shipRemoteProject(root, server);
    expect(again.shipped).toEqual(["store/customers/acme/notes.md"]);
    expect(server.store.get("store/customers/acme/notes.md")?.version).toBe(4);
    // Server copies are never shipped themselves.
    expect(server.store.has(copy)).toBe(false);
  });

  it("sync conflict: remote changed and local changed → server copy beside, local kept", async () => {
    await syncRemoteProject(root, server);
    write(root, "store/customers/acme/notes.md", "my edit\n");
    server.store.set("store/customers/acme/notes.md", {
      version: 3,
      text: "their edit\n",
      deleted: false,
    });
    const report = await syncRemoteProject(root, server);
    const copy = serverCopyPath("store/customers/acme/notes.md", 3);
    expect(report.conflicts).toEqual([
      {
        path: "store/customers/acme/notes.md",
        serverCopy: copy,
        serverVersion: 3,
      },
    ]);
    expect(read(root, "store/customers/acme/notes.md")).toBe("my edit\n");
    expect(read(root, copy)).toBe("their edit\n");
    // Unmodified remote changes just land.
    server.program.set("docs/handbook.md", "# Handbook v2\n");
    const next = await syncRemoteProject(root, server);
    expect(next.pulled).toEqual(["docs/handbook.md"]);
    expect(read(root, "docs/handbook.md")).toBe("# Handbook v2\n");
  });

  it("deletions travel both ways, but never over someone's newer edit", async () => {
    await syncRemoteProject(root, server);
    // Local delete → remote tombstone.
    fs.rmSync(path.join(root, "store/customers/acme/notes.md"));
    expect(localStatus(root).deleted).toEqual([
      "store/customers/acme/notes.md",
    ]);
    const shipped = await shipRemoteProject(root, server);
    expect(shipped.deleted).toEqual(["store/customers/acme/notes.md"]);
    expect(server.store.get("store/customers/acme/notes.md")?.deleted).toBe(
      true,
    );
    // Remote delete of an unmodified local file → removed locally.
    server.store.set("store/customers/acme/plan.md", {
      version: 1,
      text: "plan\n",
      deleted: false,
    });
    await syncRemoteProject(root, server);
    expect(fs.existsSync(path.join(root, "store/customers/acme/plan.md"))).toBe(
      true,
    );
    server.store.get("store/customers/acme/plan.md")!.deleted = true;
    const report = await syncRemoteProject(root, server);
    expect(report.removed).toEqual(["store/customers/acme/plan.md"]);
    expect(fs.existsSync(path.join(root, "store/customers/acme/plan.md"))).toBe(
      false,
    );
  });
});
