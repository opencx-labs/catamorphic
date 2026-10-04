import { argon2, argon2Sync } from "node:crypto";
import { argon2d, argon2id } from "hash-wasm";
import * as kdbx from "kdbxweb";

/**
 * kdbxweb needs an external Argon2 for KDBX4 databases. Imported for its
 * effect by everything that opens one (the profile vault, KeePass
 * imports).
 *
 * Node's own Argon2 runs where the runtime has it (Node with OpenSSL 3.2+,
 * as under tests); Electron's Node is built on BoringSSL without it, so
 * the app uses hash-wasm, a small WebAssembly implementation. Both derive
 * the same keys (kdbx-argon2.test.ts pins them). The native path matters
 * in test workers: allocating wasm memory per derivation in worker
 * threads crashes V8 there (UnregisterWasmAllocation).
 */
const nativeArgon2 = (() => {
  try {
    argon2Sync("argon2id", {
      message: "probe",
      nonce: Buffer.alloc(16),
      memory: 8,
      passes: 1,
      tagLength: 16,
      parallelism: 1,
    });
    return true;
  } catch {
    return false;
  }
})();

type Argon2Impl = Parameters<typeof kdbx.CryptoEngine.setArgon2Impl>[0];

/** hash-wasm's Argon2, which the packaged app uses. */
export const wasmArgon2: Argon2Impl = async (
  password,
  salt,
  memory,
  iterations,
  length,
  parallelism,
  type,
) => {
  const derive =
    type === kdbx.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id;
  const hash = await derive({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: "binary",
  });
  return hash.buffer as ArrayBuffer;
};

/** Node's Argon2, where the runtime has one. */
export const nodeArgon2: Argon2Impl = (
  password,
  salt,
  memory,
  iterations,
  length,
  parallelism,
  type,
) =>
  new Promise<ArrayBuffer>((resolve, reject) =>
    argon2(
      type === kdbx.CryptoEngine.Argon2TypeArgon2d ? "argon2d" : "argon2id",
      {
        message: new Uint8Array(password),
        nonce: new Uint8Array(salt),
        // KiB, as kdbxweb passes it (and hash-wasm takes it).
        memory,
        passes: iterations,
        tagLength: length,
        parallelism,
      },
      (error, hash) => {
        if (error) reject(error);
        else
          resolve(
            hash.buffer.slice(
              hash.byteOffset,
              hash.byteOffset + hash.byteLength,
            ) as ArrayBuffer,
          );
      },
    ),
  );

kdbx.CryptoEngine.setArgon2Impl(nativeArgon2 ? nodeArgon2 : wasmArgon2);
