import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: {} }));
vi.mock("./shell-ipc.js", () => ({ shellIpcMain: {} }));
const { CodeApprovals } = await import("./code-approvals.js");

/** A keychain stand-in: sealing is reversible only through it. */
const keyring = {
  available: async () => true,
  encrypt: async (text: string) =>
    Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`),
  decrypt: async (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith("sealed:")) throw new Error("Not sealed here.");
    return Buffer.from(text.slice(7), "base64").toString();
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-approvals-"));
  dirs.push(dir);
  return { dir, approvals: new CodeApprovals({ dir, keyring }) };
}

describe("approvals (ADR 0277)", () => {
  it("authenticates exact host service payloads across restart without accepting edits or another profile's key", async () => {
    const { dir, approvals } = store();
    const payload = JSON.stringify([
      7,
      { owner: "package", command: "bun service.ts" },
    ]);
    const signature = await approvals.sealServiceDefinition({ payload });
    expect(
      await new CodeApprovals({ dir, keyring }).verifyServiceDefinition({
        payload,
        signature,
      }),
    ).toBe(true);
    expect(
      await approvals.verifyServiceDefinition({
        payload: payload.replace("7", "8"),
        signature,
      }),
    ).toBe(false);
    expect(
      await approvals.verifyServiceDefinition({
        payload: payload.replace("service", "other"),
        signature,
      }),
    ).toBe(false);
    expect(
      await store().approvals.verifyServiceDefinition({ payload, signature }),
    ).toBe(false);
    expect(
      await approvals.verifyServiceDefinition({ payload, signature: "forged" }),
    ).toBe(false);
  });
  it("keeps what the person approved, across restarts", async () => {
    const { dir, approvals } = store();
    expect(await approvals.approved("module:p:.work/todos.ts")).toBeNull();
    await approvals.approve("module:p:.work/todos.ts", {
      hosts: ["api.linear.app"],
    });
    const again = new CodeApprovals({ dir, keyring });
    expect(await again.approved("module:p:.work/todos.ts")).toEqual({
      hosts: ["api.linear.app"],
    });
    await again.revoke("module:p:.work/todos.ts");
    expect(await again.approved("module:p:.work/todos.ts")).toBeNull();
  });

  it("grants nothing for an approval written into the file", async () => {
    const { dir, approvals } = store();
    await approvals.approve("module:p:.work/todos.ts", { lists: ["tabs"] });
    const file = path.join(dir, "approvals.json");
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    // Another program widens the approval and adds one of its own.
    records[0].access = { lists: ["tabs", "chats"], hosts: ["evil.test"] };
    records.push({
      subject: "module:p:.work/steal.ts",
      access: { hosts: ["evil.test"] },
      at: Date.now(),
      mac: "00".repeat(32),
    });
    fs.writeFileSync(file, JSON.stringify(records));
    const reread = new CodeApprovals({ dir, keyring });
    expect(await reread.approved("module:p:.work/todos.ts")).toBeNull();
    expect(await reread.approved("module:p:.work/steal.ts")).toBeNull();
  });

  it("moves no approval from one subject to another", async () => {
    const { dir, approvals } = store();
    await approvals.approve("module:p:.work/todos.ts", { hosts: ["a.test"] });
    const file = path.join(dir, "approvals.json");
    const [record] = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify([{ ...record, subject: "module:p:.work/other.ts" }]),
    );
    expect(
      await new CodeApprovals({ dir, keyring }).approved(
        "module:p:.work/other.ts",
      ),
    ).toBeNull();
  });

  it("asks again when the key is gone, and never allows without the keychain", async () => {
    const { dir, approvals } = store();
    await approvals.approve("app:p:activity", { lists: ["chats"] });
    fs.rmSync(path.join(dir, "approvals.key"));
    const fresh = new CodeApprovals({ dir, keyring });
    expect(await fresh.approved("app:p:activity")).toBeNull();
    const locked = new CodeApprovals({
      dir: path.join(dir, "none"),
      keyring: { ...keyring, available: async () => false },
    });
    await expect(locked.approved("app:p:activity")).rejects.toThrow(
      "keychain is not available",
    );
  });
  it("refuses an existing key when its OS storage is unavailable and can retry after unlock", async () => {
    const { dir, approvals } = store();
    await approvals.approve("app:p:activity", { lists: ["chats"] });
    const keyBefore = fs.readFileSync(path.join(dir, "approvals.key"));
    const recordsBefore = fs.readFileSync(path.join(dir, "approvals.json"));
    let available = false;
    const decrypt = vi.fn(keyring.decrypt);
    const locked = new CodeApprovals({
      dir,
      keyring: { ...keyring, available: async () => available, decrypt },
    });
    await expect(locked.approved("app:p:activity")).rejects.toThrow(
      "Unlock your operating system's keychain",
    );
    expect(decrypt).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, "approvals.key"))).toEqual(keyBefore);
    expect(fs.readFileSync(path.join(dir, "approvals.json"))).toEqual(
      recordsBefore,
    );
    available = true;
    await expect(locked.approved("app:p:activity")).resolves.toEqual({
      lists: ["chats"],
    });
  });

  it.each(["", "00", "not a key", "ab".repeat(33)])(
    "refuses an invalid decrypted signing key %j without replacing it",
    async (secret) => {
      const { dir } = store();
      const sealed = await keyring.encrypt(secret);
      fs.writeFileSync(path.join(dir, "approvals.key"), sealed);
      const approvals = new CodeApprovals({ dir, keyring });
      await expect(
        approvals.approve("app:p:activity", { lists: ["chats"] }),
      ).rejects.toThrow("Work could not unlock saved approvals");
      expect(fs.readFileSync(path.join(dir, "approvals.key"))).toEqual(sealed);
      expect(fs.existsSync(path.join(dir, "approvals.json"))).toBe(false);
    },
  );
  it("never mistakes a keychain item error for a missing signing-key file", async () => {
    const { dir, approvals } = store();
    await approvals.approve("app:p:activity", { lists: ["chats"] });
    const sealed = fs.readFileSync(path.join(dir, "approvals.key"));
    const records = fs.readFileSync(path.join(dir, "approvals.json"));
    const unreadable = new CodeApprovals({
      dir,
      keyring: {
        ...keyring,
        decrypt: async () => {
          throw Object.assign(new Error("Keychain item missing"), {
            code: "ENOENT",
          });
        },
      },
    });
    await expect(unreadable.approved("app:p:activity")).rejects.toThrow(
      "Work could not unlock saved approvals",
    );
    expect(fs.readFileSync(path.join(dir, "approvals.key"))).toEqual(sealed);
    expect(fs.readFileSync(path.join(dir, "approvals.json"))).toEqual(records);
  });
});
