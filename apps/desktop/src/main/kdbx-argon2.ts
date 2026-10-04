import { argon2d, argon2id } from "hash-wasm";
import * as kdbx from "kdbxweb";

/**
 * kdbxweb needs an external Argon2 for KDBX4 databases; hash-wasm is small
 * and WASM-based. Imported for its effect by everything that opens one
 * (the profile vault, KeePass imports).
 */
kdbx.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type) => {
    const fn =
      type === kdbx.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id;
    const hash = await fn({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: "binary",
    });
    return hash.buffer as ArrayBuffer;
  },
);
