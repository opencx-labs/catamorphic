import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

/**
 * Operations are sealed to their executor (ADR 0207). Every executor (an
 * enrolled worker, a member's runner) holds an X25519 key pair whose private
 * key never leaves its machine; the control plane seals each queued
 * operation to its public key, so Postgres, its log and its backups hold only
 * ciphertext. Each operation is sealed with an ephemeral X25519 agreement,
 * HKDF-SHA256 and AES-256-GCM, with associated data the caller binds to the
 * operation (its id and executor).
 */

/** HKDF info: what the derived key protects, and the format's version. */
const INFO = Buffer.from("work-operation-v1", "utf8");
/** The DER prefix of an X25519 SubjectPublicKeyInfo; the raw key follows. */
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A raw 32-byte X25519 public key, base64: what an executor registers. */
export const ExecutorPublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "Use a base64 X25519 public key")
  .refine(
    (value) => Buffer.from(value, "base64").length === KEY_BYTES,
    "Use a base64 X25519 public key",
  );

/** An executor's key pair. */
export interface ExecutorKeyPair {
  /** The raw 32-byte public key, base64. */
  publicKey: string;
  /** PKCS8 PEM. It never leaves the executor's machine. */
  privateKey: string;
}

/** One operation sealed to one executor's key. */
export const SealedOperationSchema = z.strictObject({
  v: z.literal(1),
  /** The ephemeral public key, raw and base64. */
  epk: z.string(),
  /** The AES-GCM nonce, 12 bytes, base64. */
  nonce: z.string(),
  /** Ciphertext with its 16-byte authentication tag appended, base64. */
  ct: z.string(),
});
export type SealedOperation = z.infer<typeof SealedOperationSchema>;

/**
 * This sealed operation was not sealed to this key, or it or its associated
 * data was altered.
 */
export class SealedOperationOpenError extends Error {
  constructor() {
    super(
      "This operation was not sealed to this executor's key, or it was altered",
    );
    this.name = "SealedOperationOpenError";
  }
}

/** A new X25519 key pair for an executor. */
export function generateExecutorKeyPair(): ExecutorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublicKey(publicKey).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** The public key of an executor's private key, base64 like the registered one. */
export function executorPublicKey(privateKey: string | KeyObject): string {
  return rawPublicKey(createPublicKey(privateKeyObject(privateKey))).toString(
    "base64",
  );
}

/** Seal `plaintext` to the executor holding `recipientPublicKey`'s private key. */
export function sealOperation(args: {
  plaintext: string;
  recipientPublicKey: string;
  aad: string;
}): SealedOperation {
  const recipient = Buffer.from(
    ExecutorPublicKeySchema.parse(args.recipientPublicKey),
    "base64",
  );
  const ephemeral = generateKeyPairSync("x25519");
  const epk = rawPublicKey(ephemeral.publicKey);
  const key = deriveKey({
    privateKey: ephemeral.privateKey,
    peer: recipient,
    epk,
    recipient,
  });
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(args.aad, "utf8"));
  const ct = Buffer.concat([
    cipher.update(args.plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    v: 1,
    epk: epk.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
  };
}

/**
 * Open an operation sealed to `privateKey`'s public key with the same
 * associated data. Throws {@link SealedOperationOpenError} otherwise.
 */
export function openOperation(args: {
  sealed: SealedOperation;
  privateKey: string | KeyObject;
  aad: string;
}): string {
  const sealed = SealedOperationSchema.parse(args.sealed);
  const epk = Buffer.from(sealed.epk, "base64");
  const nonce = Buffer.from(sealed.nonce, "base64");
  const ct = Buffer.from(sealed.ct, "base64");
  if (
    epk.length !== KEY_BYTES ||
    nonce.length !== NONCE_BYTES ||
    ct.length < TAG_BYTES
  )
    throw new SealedOperationOpenError();
  try {
    const privateKey = privateKeyObject(args.privateKey);
    const key = deriveKey({
      privateKey,
      peer: epk,
      epk,
      recipient: rawPublicKey(createPublicKey(privateKey)),
    });
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(args.aad, "utf8"));
    decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealedOperationOpenError();
  }
}

/**
 * The AES key for one agreement. The salt binds both public keys, so a
 * ciphertext opens only for the recipient it was sealed to. A low-order peer
 * key fails the agreement itself.
 */
function deriveKey(args: {
  privateKey: KeyObject;
  peer: Buffer;
  epk: Buffer;
  recipient: Buffer;
}): Buffer {
  const shared = diffieHellman({
    privateKey: args.privateKey,
    publicKey: publicKeyObject(args.peer),
  });
  if (shared.every((byte) => byte === 0)) throw new SealedOperationOpenError();
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([args.epk, args.recipient]),
      INFO,
      KEY_BYTES,
    ),
  );
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - KEY_BYTES));
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function privateKeyObject(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? createPrivateKey(key) : key;
}
