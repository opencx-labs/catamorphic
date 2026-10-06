import crypto from "node:crypto";
import {
  HEADER_ECDSA_PROOF,
  HEADER_RSA_PROOF,
  HEADER_SIGNED_DATA,
  MAGIC,
  PROOF_PUBLIC_KEY,
  PROOF_SIGNATURE,
  SIGNED_DATA_CRX_ID,
  SIGNED_DATA_PREFIX,
} from "./crx.js";

/**
 * Build a signed CRX3 package. Work never publishes packages: only tests
 * import this, to make store-shaped fixtures signed by their own keys.
 */
export function buildCrx({
  archive,
  developerKey,
  publisherKey,
}: {
  archive: Buffer;
  developerKey: crypto.KeyObject;
  publisherKey?: crypto.KeyObject;
}): Buffer {
  const spki = (key: crypto.KeyObject) =>
    crypto
      .createPublicKey(key)
      .export({ format: "der", type: "spki" }) as Buffer;
  const developerSpki = spki(developerKey);
  const crxId = crypto
    .createHash("sha256")
    .update(developerSpki)
    .digest()
    .subarray(0, 16);
  const signedData = protobufBytes(SIGNED_DATA_CRX_ID, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const message = Buffer.concat([
    SIGNED_DATA_PREFIX,
    length,
    signedData,
    archive,
  ]);
  const proof = (key: crypto.KeyObject) =>
    Buffer.concat([
      protobufBytes(PROOF_PUBLIC_KEY, spki(key)),
      protobufBytes(PROOF_SIGNATURE, crypto.sign("sha256", message, key)),
    ]);
  const proofField = (key: crypto.KeyObject) =>
    protobufBytes(
      key.asymmetricKeyType === "ec" ? HEADER_ECDSA_PROOF : HEADER_RSA_PROOF,
      proof(key),
    );
  const header = Buffer.concat([
    proofField(developerKey),
    ...(publisherKey ? [proofField(publisherKey)] : []),
    protobufBytes(HEADER_SIGNED_DATA, signedData),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function protobufBytes(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
