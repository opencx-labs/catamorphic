import fs from "node:fs/promises";
import path from "node:path";
import type { AppBundleStore } from "@catamorphic/core";

/**
 * Filesystem-backed app-bundle store for single-machine hosts (desktop app,
 * local development) where S3-compatible object storage is overkill.
 */
export class FsBundleStore implements AppBundleStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const target = path.join(this.root, key);
    if (!target.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid bundle key: ${key}`);
    }
    return target;
  }

  async get(key: string) {
    try {
      const data = await fs.readFile(this.resolve(key));
      return { data: new Uint8Array(data), etag: "fs" };
    } catch {
      return null;
    }
  }

  async put(key: string, data: Uint8Array) {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async deletePrefix(prefix: string) {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}
