import { createHash } from "node:crypto";
import { type ObjectStore, PreconditionFailedError } from "./object-store.js";

/**
 * In-memory `ObjectStore` mirroring S3 conditional-write semantics. Intended
 * for unit tests (both catamorphic's and host apps').
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<
    string,
    { data: Uint8Array; etag: string }
  >();

  async get(key: string): Promise<{ data: Uint8Array; etag: string } | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { data: entry.data.slice(), etag: entry.etag };
  }

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<void> {
    const current = this.objects.get(key);
    if (opts?.ifNoneMatch === "*" && current) {
      throw new PreconditionFailedError(key);
    }
    if (opts?.ifMatch !== undefined) {
      if (!current || current.etag !== opts.ifMatch) {
        throw new PreconditionFailedError(key);
      }
    }
    const etag = `"${createHash("md5").update(data).digest("hex")}"`;
    this.objects.set(key, { data: data.slice(), etag });
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.list(prefix)) {
      this.objects.delete(key);
    }
  }
}
