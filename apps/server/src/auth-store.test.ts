import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";

const dirs: string[] = [];
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-"));
  dirs.push(dir);
  return path.join(dir, "auth.json");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AuthStore", () => {
  it("mints one stable admin token and persists across reloads", () => {
    const file = tempFile();
    const store = new AuthStore(file);
    const admin = store.ensureAdmin();
    expect(store.ensureAdmin().token).toBe(admin.token);
    const reloaded = new AuthStore(file);
    expect(reloaded.ensureAdmin().token).toBe(admin.token);
    expect(reloaded.findByToken(admin.token)?.kind).toBe("admin");
  });

  it("mints, finds, and revokes member tokens", () => {
    const store = new AuthStore(tempFile());
    const member = store.mintMember("sam", "project-1", "Sam's phone");
    expect(store.findByToken(member.token)?.externalUserId).toBe("sam");
    expect(store.findByToken(member.token)?.projectId).toBe("project-1");
    expect(store.findByToken("nope")).toBeUndefined();
    expect(store.revoke(member.token)).toBe(true);
    expect(store.findByToken(member.token)).toBeUndefined();
    expect(store.revoke(member.token)).toBe(false);
  });

  it("survives a corrupt file by starting empty", () => {
    const file = tempFile();
    fs.writeFileSync(file, "{nope");
    const store = new AuthStore(file);
    expect(store.list()).toEqual([]);
  });
});
