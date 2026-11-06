import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeNativeMessage,
  NATIVE_ERRORS,
  NativeMessageReader,
  resolveNativeHost,
} from "./native-messaging.js";
import { ExtensionRegistry, type InstalledExtension } from "./registry.js";
import { SyncStorage } from "./sync-storage.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-storage-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("storage.sync", () => {
  it("reads like chrome.storage and reports changes", () => {
    const storage = new SyncStorage((profileId, extensionId) =>
      path.join(dir, profileId, extensionId, "sync.json"),
    );
    expect(storage.set("p", ID, { a: 1, b: { c: [1, 2] } })).toEqual({
      a: { newValue: 1 },
      b: { newValue: { c: [1, 2] } },
    });
    expect(storage.set("p", ID, { a: 1 })).toEqual({});
    expect(storage.get("p", ID, "a")).toEqual({ a: 1 });
    expect(storage.get("p", ID, ["a", "missing"])).toEqual({ a: 1 });
    expect(storage.get("p", ID, { missing: "fallback", a: 0 })).toEqual({
      missing: "fallback",
      a: 1,
    });
    expect(storage.keys("p", ID).sort()).toEqual(["a", "b"]);
    expect(storage.remove("p", ID, "a")).toEqual({ a: { oldValue: 1 } });
    expect(storage.get("p", ID, null)).toEqual({ b: { c: [1, 2] } });
    storage.dispose();
    const reread = new SyncStorage((profileId, extensionId) =>
      path.join(dir, profileId, extensionId, "sync.json"),
    );
    expect(reread.get("p", ID, null)).toEqual({ b: { c: [1, 2] } });
  });

  it("keeps Chrome's quotas", () => {
    const storage = new SyncStorage(() => path.join(dir, "sync.json"));
    expect(() => storage.set("p", ID, { big: "x".repeat(9000) })).toThrow(
      "QUOTA_BYTES_PER_ITEM",
    );
    const many = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`k${index}`, index]),
    );
    expect(() => storage.set("p", ID, many)).toThrow("MAX_ITEMS");
    storage.dispose();
  });
});

describe("the registry", () => {
  const entry = (
    patch: Partial<InstalledExtension> = {},
  ): InstalledExtension => ({
    id: ID,
    source: "webstore",
    path: path.join(dir, "x"),
    version: "1.0",
    enabled: true,
    disabledReason: null,
    pinned: false,
    installedAt: 1,
    updatedAt: 1,
    approved: { permissions: [], origins: [] },
    granted: { permissions: [], origins: [] },
    enabledRulesets: null,
    pendingUpdate: null,
    uninstallUrl: null,
    stagedUpdate: null,
    installedEventFor: null,
    ...patch,
  });

  it("keeps a profile's extensions and survives a damaged entry", () => {
    const registry = new ExtensionRegistry(dir);
    registry.put("p", entry());
    registry.update("p", ID, (current) => ({ ...current, pinned: true }));
    registry.setDeveloperMode("p", true);
    const file = path.join(dir, "p", "extensions.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.extensions.push({ id: "broken" });
    fs.writeFileSync(file, JSON.stringify(saved));
    const reread = new ExtensionRegistry(dir);
    expect(reread.list("p")).toHaveLength(1);
    expect(reread.get("p", ID)?.pinned).toBe(true);
    expect(reread.developerMode("p")).toBe(true);
    expect(() => reread.dataDir("p", "../escape")).toThrow();
    expect(reread.dataDir("p", ID)).toBe(path.join(dir, "p", "extensions", ID));
    // The entry it can't read survives the next save.
    reread.setDeveloperMode("p", false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).extensions).toContainEqual(
      { id: "broken" },
    );
  });

  it("moves a file it can't parse aside instead of overwriting it", () => {
    const file = path.join(dir, "p", "extensions.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    const registry = new ExtensionRegistry(dir);
    expect(registry.list("p")).toEqual([]);
    registry.setDeveloperMode("p", true);
    const aside = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith("extensions.json.damaged-"));
    expect(aside).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(path.dirname(file), aside[0] ?? ""), "utf8"),
    ).toBe("{ not json");
  });
});

describe("native messaging", () => {
  const write = (name: string, manifest: unknown) => {
    fs.mkdirSync(path.join(dir, "hosts"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "hosts", `${name}.json`),
      JSON.stringify(manifest),
    );
  };

  it("finds a host only for the extensions it names", () => {
    write("com.example.host", {
      name: "com.example.host",
      path: "/Applications/Example.app/host",
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    });
    const dirs = [path.join(dir, "missing"), path.join(dir, "hosts")];
    expect(resolveNativeHost("com.example.host", ID, dirs)).toEqual({
      name: "com.example.host",
      path: "/Applications/Example.app/host",
    });
    expect(
      resolveNativeHost(
        "com.example.host",
        "ponmlkjihgfedcbaponmlkjihgfedcba",
        dirs,
      ),
    ).toEqual({ error: NATIVE_ERRORS.forbidden });
    expect(resolveNativeHost("com.example.other", ID, dirs)).toEqual({
      error: NATIVE_ERRORS.notFound,
    });
    expect(resolveNativeHost("../../etc/passwd", ID, dirs)).toEqual({
      error: NATIVE_ERRORS.notFound,
    });
  });

  it("refuses relative paths and other transports", () => {
    write("com.example.relative", {
      name: "com.example.relative",
      path: "host",
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    });
    expect(
      resolveNativeHost("com.example.relative", ID, [path.join(dir, "hosts")]),
    ).toEqual({ error: NATIVE_ERRORS.notFound });
  });

  it("frames messages with a length prefix", () => {
    const reader = new NativeMessageReader();
    const bytes = Buffer.concat([
      encodeNativeMessage({ a: 1 }),
      encodeNativeMessage("two"),
    ]);
    expect(reader.push(bytes.subarray(0, 6))).toEqual([]);
    expect(reader.push(bytes.subarray(6))).toEqual([{ a: 1 }, "two"]);
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(2 * 1024 * 1024);
    expect(() => new NativeMessageReader().push(huge)).toThrow();
  });
});
