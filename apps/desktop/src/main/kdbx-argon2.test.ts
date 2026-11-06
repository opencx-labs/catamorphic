import * as kdbx from "kdbxweb";
import { describe, expect, it } from "vitest";
import { nodeArgon2, wasmArgon2 } from "./kdbx-argon2.js";

/**
 * Two implementations derive KDBX keys: hash-wasm in the app, Node's own
 * where the runtime has it. Their output is pinned to the same vectors.
 */
describe("kdbx Argon2", () => {
  const password = new TextEncoder().encode("correct horse battery staple");
  const salt = new Uint8Array(32).map((_, index) => index);
  const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");

  // The app's (hash-wasm) and the tests' (Node) implementations derive the
  // same keys, so vaults and imports open in both.
  it.each<[string, kdbx.CryptoEngine.Argon2Type, string]>([
    [
      "argon2d",
      kdbx.CryptoEngine.Argon2TypeArgon2d,
      "2b7f579345aad69e4eb08b5ee0719363a8ff1866b8f4a8a078aa062edb9b66a9",
    ],
    [
      "argon2id",
      kdbx.CryptoEngine.Argon2TypeArgon2id,
      "c456bd5633944bd1a56fb5294f67f6863d8c6ef721d95e236098543a82ea4ba5",
    ],
  ])(
    "derives the same %s key in both implementations",
    async (_name, type, expected) => {
      for (const derive of [wasmArgon2, nodeArgon2])
        expect(
          hex(
            await derive(
              password.buffer,
              salt.buffer,
              1024,
              2,
              32,
              2,
              type,
              0x13,
            ),
          ),
        ).toBe(expected);
    },
  );

  it("opens a database it wrote", async () => {
    const credentials = new kdbx.Credentials(
      kdbx.ProtectedValue.fromString("pw"),
    );
    const db = kdbx.Kdbx.create(credentials, "Vault");
    const bytes = await db.save();
    const reopened = await kdbx.Kdbx.load(
      bytes,
      new kdbx.Credentials(kdbx.ProtectedValue.fromString("pw")),
    );
    expect(reopened.getDefaultGroup().name).toBe("Vault");
  });
});
