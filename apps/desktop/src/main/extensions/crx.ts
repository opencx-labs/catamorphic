import crypto from "node:crypto";

/**
 * CRX3, Chrome's extension package (ADR 0203): `Cr24`, a format version, a
 * protobuf header of signatures, then the zip archive the signatures cover.
 * Work accepts a package the way Chrome does: every signature in the header
 * must verify, one of them must be by the key the extension's id is derived
 * from, and a package from the Chrome Web Store must also carry the store's
 * publisher signature.
 */

/** SHA-256 of the Chrome Web Store publisher key (Chromium crx_verifier). */
export const WEB_STORE_PUBLISHER_KEY_HASH =
  "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf";

export const MAGIC = "Cr24";
export const SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "latin1");
// Field numbers from Chromium's crx3.proto.
export const HEADER_RSA_PROOF = 2;
export const HEADER_ECDSA_PROOF = 3;
export const HEADER_SIGNED_DATA = 10000;
export const PROOF_PUBLIC_KEY = 1;
export const PROOF_SIGNATURE = 2;
export const SIGNED_DATA_CRX_ID = 1;
// Generous: real headers are about 1.3 KB.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PROOFS = 16;

export class CrxError extends Error {
  override name = "CrxError";
}

export interface VerifiedCrx {
  /** The 32-letter extension id the developer key derives. */
  id: string;
  /** The developer key (DER SubjectPublicKeyInfo); becomes manifest `key`. */
  publicKey: Buffer;
  /** The zip archive the signatures cover. */
  archive: Buffer;
}

/** Chrome's id: the first 128 bits of SHA-256(key), hex digits mapped to a–p. */
export function extensionIdFromKey(publicKey: Uint8Array): string {
  const digest = crypto.createHash("sha256").update(publicKey).digest();
  return idFromHashPrefix(digest.subarray(0, 16));
}

function idFromHashPrefix(prefix: Uint8Array): string {
  let id = "";
  for (const byte of prefix) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return id;
}

export function keyHash(publicKey: Uint8Array): string {
  return crypto.createHash("sha256").update(publicKey).digest("hex");
}

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

interface Field {
  field: number;
  bytes: Buffer | null;
}

function readVarint(data: Buffer, at: { offset: number }): number {
  let value = 0;
  let scale = 1;
  for (let read = 0; read < 8; read++) {
    if (at.offset >= data.length) throw new CrxError("Truncated header");
    const byte = data[at.offset++] ?? 0;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value))
        throw new CrxError("Header value too large");
      return value;
    }
    scale *= 128;
  }
  throw new CrxError("Header value too large");
}

/** The fields of one protobuf message; unknown fields are skipped. */
function readFields(data: Buffer): Field[] {
  const fields: Field[] = [];
  const at = { offset: 0 };
  while (at.offset < data.length) {
    const tag = readVarint(data, at);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      readVarint(data, at);
      fields.push({ field, bytes: null });
    } else if (wire === 1 || wire === 5) {
      at.offset += wire === 1 ? 8 : 4;
      if (at.offset > data.length) throw new CrxError("Truncated header");
      fields.push({ field, bytes: null });
    } else if (wire === 2) {
      const length = readVarint(data, at);
      const end = at.offset + length;
      if (end > data.length) throw new CrxError("Truncated header");
      fields.push({ field, bytes: data.subarray(at.offset, end) });
      at.offset = end;
    } else {
      throw new CrxError("Unsupported header encoding");
    }
  }
  return fields;
}

function only(fields: Field[], field: number): Buffer | null {
  const matches = fields.filter((entry) => entry.field === field);
  if (matches.length > 1) throw new CrxError("Duplicate header field");
  return matches[0]?.bytes ?? null;
}

interface Proof {
  publicKey: Buffer;
  signature: Buffer;
  algorithm: "rsa" | "ecdsa";
}

function readProof(bytes: Buffer, algorithm: Proof["algorithm"]): Proof {
  const fields = readFields(bytes);
  const publicKey = only(fields, PROOF_PUBLIC_KEY);
  const signature = only(fields, PROOF_SIGNATURE);
  if (!publicKey || !signature) throw new CrxError("Incomplete signature");
  return { publicKey, signature, algorithm };
}

function verifyProof(proof: Proof, message: Buffer): boolean {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({
      key: proof.publicKey,
      format: "der",
      type: "spki",
    });
  } catch {
    return false;
  }
  const keyType = key.asymmetricKeyType;
  if (proof.algorithm === "rsa" ? keyType !== "rsa" : keyType !== "ec")
    return false;
  try {
    return crypto.verify("sha256", message, key, proof.signature);
  } catch {
    return false;
  }
}

/**
 * Verify a CRX3 package. `publisherKeyHashes` names the publisher keys one
 * of which must have signed it (the Web Store's for store installs); null
 * accepts a package signed only by its developer.
 */
export function verifyCrx(
  data: Buffer,
  {
    publisherKeyHashes,
    expectedId,
  }: { publisherKeyHashes: readonly string[] | null; expectedId?: string },
): VerifiedCrx {
  if (data.length < 12 || data.toString("latin1", 0, 4) !== MAGIC)
    throw new CrxError("Not a Chrome extension package");
  const version = data.readUInt32LE(4);
  if (version !== 3)
    throw new CrxError(`Unsupported package format CRX${version}`);
  const headerSize = data.readUInt32LE(8);
  if (headerSize > MAX_HEADER_BYTES || 12 + headerSize > data.length)
    throw new CrxError("Malformed package header");
  const header = data.subarray(12, 12 + headerSize);
  const archive = data.subarray(12 + headerSize);

  const fields = readFields(header);
  const signedData = only(fields, HEADER_SIGNED_DATA);
  if (!signedData) throw new CrxError("Package has no signed id");
  const crxId = only(readFields(signedData), SIGNED_DATA_CRX_ID);
  if (crxId?.length !== 16) throw new CrxError("Package has no signed id");
  const id = idFromHashPrefix(crxId);
  if (expectedId && id !== expectedId)
    throw new CrxError("Package is for a different extension");

  const proofs = [
    ...fields
      .filter((entry) => entry.field === HEADER_RSA_PROOF && entry.bytes)
      .map((entry) => readProof(entry.bytes as Buffer, "rsa")),
    ...fields
      .filter((entry) => entry.field === HEADER_ECDSA_PROOF && entry.bytes)
      .map((entry) => readProof(entry.bytes as Buffer, "ecdsa")),
  ];
  if (proofs.length === 0) throw new CrxError("Package is not signed");
  if (proofs.length > MAX_PROOFS) throw new CrxError("Too many signatures");

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const message = Buffer.concat([
    SIGNED_DATA_PREFIX,
    length,
    signedData,
    archive,
  ]);
  let developerKey: Buffer | null = null;
  let published = publisherKeyHashes === null;
  for (const proof of proofs) {
    // Chrome rejects a package when any signature in it fails.
    if (!verifyProof(proof, message))
      throw new CrxError("Package signature does not verify");
    if (extensionIdFromKey(proof.publicKey) === id)
      developerKey = proof.publicKey;
    if (publisherKeyHashes?.includes(keyHash(proof.publicKey)))
      published = true;
  }
  if (!developerKey)
    throw new CrxError("Package is not signed by its developer key");
  if (!published)
    throw new CrxError("Package is not signed by the Chrome Web Store");
  return { id, publicKey: Buffer.from(developerKey), archive };
}
