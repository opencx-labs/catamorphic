import fs from "node:fs";
import path from "node:path";

/**
 * `chrome.storage.sync` for one profile's extensions (ADR 0203). Work has
 * no Chrome sync, so — as in Chrome while sync is off — the area keeps its
 * values on this machine with Chrome's quotas: one JSON file per extension
 * beside its package.
 */

export const SYNC_QUOTA = {
  bytes: 102400,
  bytesPerItem: 8192,
  items: 512,
} as const;

type Values = Record<string, unknown>;

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

const itemBytes = (name: string, value: unknown) =>
  Buffer.byteLength(name) + Buffer.byteLength(JSON.stringify(value) ?? "");

export class SyncStorage {
  private readonly cache = new Map<string, Values>();
  private readonly writes = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly fileFor: (
      profileId: string,
      extensionId: string,
    ) => string,
  ) {}

  private key(profileId: string, extensionId: string) {
    return `${profileId}:${extensionId}`;
  }

  private load(profileId: string, extensionId: string): Values {
    const id = this.key(profileId, extensionId);
    const cached = this.cache.get(id);
    if (cached) return cached;
    let values: Values = {};
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.fileFor(profileId, extensionId), "utf-8"),
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        values = parsed as Values;
    } catch {
      /* Nothing stored yet. */
    }
    this.cache.set(id, values);
    return values;
  }

  private save(profileId: string, extensionId: string): void {
    const id = this.key(profileId, extensionId);
    clearTimeout(this.writes.get(id));
    this.writes.set(
      id,
      setTimeout(() => {
        this.writes.delete(id);
        this.flush(profileId, extensionId);
      }, 200),
    );
  }

  private flush(profileId: string, extensionId: string): void {
    const values = this.cache.get(this.key(profileId, extensionId));
    if (!values) return;
    const file = this.fileFor(profileId, extensionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(values), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  /** `keys` as chrome.storage takes it: null, a key, keys, or defaults. */
  get(profileId: string, extensionId: string, keys: unknown): Values {
    const values = this.load(profileId, extensionId);
    if (keys === null || keys === undefined) return structuredClone(values);
    if (typeof keys === "string")
      return keys in values ? { [keys]: structuredClone(values[keys]) } : {};
    if (Array.isArray(keys)) {
      const out: Values = {};
      for (const name of keys)
        if (typeof name === "string" && name in values)
          out[name] = structuredClone(values[name]);
      return out;
    }
    if (typeof keys === "object") {
      const out: Values = {};
      for (const [name, fallback] of Object.entries(keys))
        out[name] = name in values ? structuredClone(values[name]) : fallback;
      return out;
    }
    throw new Error("Invalid keys.");
  }

  keys(profileId: string, extensionId: string): string[] {
    return Object.keys(this.load(profileId, extensionId));
  }

  bytesInUse(profileId: string, extensionId: string, keys: unknown): number {
    const values = this.load(profileId, extensionId);
    const names =
      keys === null || keys === undefined
        ? Object.keys(values)
        : typeof keys === "string"
          ? [keys]
          : Array.isArray(keys)
            ? keys.filter((name): name is string => typeof name === "string")
            : [];
    return names
      .filter((name) => name in values)
      .reduce((total, name) => total + itemBytes(name, values[name]), 0);
  }

  set(
    profileId: string,
    extensionId: string,
    items: unknown,
  ): Record<string, StorageChange> {
    if (!items || typeof items !== "object" || Array.isArray(items))
      throw new Error("Invalid items.");
    const values = this.load(profileId, extensionId);
    // Chrome stores the JSON form of each value.
    const incoming = JSON.parse(JSON.stringify(items)) as Values;
    const next = { ...values, ...incoming };
    for (const [name, value] of Object.entries(incoming))
      if (itemBytes(name, value) > SYNC_QUOTA.bytesPerItem)
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
    if (Object.keys(next).length > SYNC_QUOTA.items)
      throw new Error("MAX_ITEMS quota exceeded");
    const total = Object.entries(next).reduce(
      (sum, [name, value]) => sum + itemBytes(name, value),
      0,
    );
    if (total > SYNC_QUOTA.bytes) throw new Error("QUOTA_BYTES quota exceeded");
    const changes: Record<string, StorageChange> = {};
    for (const [name, value] of Object.entries(incoming)) {
      const before = values[name];
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      changes[name] = {
        ...(name in values ? { oldValue: before } : {}),
        newValue: value,
      };
      values[name] = value;
    }
    if (Object.keys(changes).length > 0) this.save(profileId, extensionId);
    return changes;
  }

  remove(
    profileId: string,
    extensionId: string,
    keys: unknown,
  ): Record<string, StorageChange> {
    const values = this.load(profileId, extensionId);
    const names =
      typeof keys === "string"
        ? [keys]
        : Array.isArray(keys)
          ? keys.filter((name): name is string => typeof name === "string")
          : [];
    const changes: Record<string, StorageChange> = {};
    for (const name of names) {
      if (!(name in values)) continue;
      changes[name] = { oldValue: values[name] };
      delete values[name];
    }
    if (Object.keys(changes).length > 0) this.save(profileId, extensionId);
    return changes;
  }

  clear(profileId: string, extensionId: string): Record<string, StorageChange> {
    const values = this.load(profileId, extensionId);
    return this.remove(profileId, extensionId, Object.keys(values));
  }

  forget(profileId: string, extensionId: string): void {
    const id = this.key(profileId, extensionId);
    clearTimeout(this.writes.get(id));
    this.writes.delete(id);
    this.cache.delete(id);
  }

  releaseProfile(profileId: string): void {
    for (const id of [...this.cache.keys()]) {
      if (!id.startsWith(`${profileId}:`)) continue;
      const extensionId = id.slice(profileId.length + 1);
      if (this.writes.has(id)) {
        clearTimeout(this.writes.get(id));
        this.writes.delete(id);
        this.flush(profileId, extensionId);
      }
      this.cache.delete(id);
    }
  }

  dispose(): void {
    for (const [id, timer] of this.writes) {
      clearTimeout(timer);
      const at = id.indexOf(":");
      this.flush(id.slice(0, at), id.slice(at + 1));
    }
    this.writes.clear();
  }
}
