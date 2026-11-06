import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { parse } from "tldts";
import type { PasskeyCredentialJson } from "../shared/passkeys.js";

/**
 * The authenticator half of Web Authentication for passkeys Work keeps
 * in its vault (ADR 0201): key generation, the CBOR and COSE encodings a
 * relying party reads, and the signed responses. Pure and main-process
 * only, so private keys never reach a page or the renderer.
 */

/** Work's authenticator model, so a site can name where a passkey lives. */
export const WORK_AAGUID = Buffer.from(
  "7817c3ed9c6241089b1b46317e4cd46e",
  "hex",
);

/** COSE algorithms Work signs with, in the order it prefers them. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[number];

export function isPasskeyAlgorithm(value: number): value is PasskeyAlgorithm {
  return (PASSKEY_ALGORITHMS as readonly number[]).includes(value);
}

/** Authenticator data flags (WebAuthn §6.1). */
export const FLAG = {
  userPresent: 0x01,
  userVerified: 0x04,
  backupEligible: 0x08,
  backedUp: 0x10,
  attestedCredential: 0x40,
} as const;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url, or the padded base64 some exports write. */
export function fromBase64Url(text: string): Buffer {
  return Buffer.from(
    text.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    "base64url",
  );
}

// --- CBOR (RFC 8949), the subset authenticator data uses ---
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function cborHead(major: number, length: number): Buffer {
  const type = major << 5;
  if (length < 24) return Buffer.from([type | length]);
  if (length < 0x100) return Buffer.from([type | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = type | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = type | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

export function encodeCbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("CBOR integers only");
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  const parts = [cborHead(5, value.size)];
  for (const [key, item] of value)
    parts.push(encodeCbor(key), encodeCbor(item));
  return Buffer.concat(parts);
}

// --- keys ---

/** The algorithm a private or public key signs with, or null if Work cannot. */
export function algorithmOf(key: KeyObject): PasskeyAlgorithm | null {
  if (key.asymmetricKeyType === "ec")
    return key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? -7 : null;
  if (key.asymmetricKeyType === "ed25519") return -8;
  if (key.asymmetricKeyType === "rsa") return -257;
  return null;
}

/** A new key for the first algorithm the site accepts that Work signs with. */
export function generatePasskeyKey(algorithm: PasskeyAlgorithm): {
  privateKeyPem: string;
  publicKey: KeyObject;
} {
  const pair =
    algorithm === -7
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : algorithm === -8
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKey: pair.publicKey,
  };
}

/** A stored PKCS#8 key, if it is one Work can sign with. */
export function readPrivateKey(
  pem: string,
): { key: KeyObject; algorithm: PasskeyAlgorithm } | null {
  try {
    const key = createPrivateKey(pem);
    const algorithm = algorithmOf(key);
    return algorithm ? { key, algorithm } : null;
  } catch {
    return null;
  }
}

/** PKCS#8 DER (as exports carry it) to the PEM the vault stores. */
export function pemFromPkcs8(der: Uint8Array): string {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

/** The COSE_Key a relying party stores for a public key. */
export function cosePublicKey(publicKey: KeyObject): Buffer {
  const algorithm = algorithmOf(publicKey);
  const jwk = publicKey.export({ format: "jwk" });
  const bytes = (field: string | undefined) => fromBase64Url(field ?? "");
  if (algorithm === -7)
    return encodeCbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, bytes(jwk.x)],
        [-3, bytes(jwk.y)],
      ]),
    );
  if (algorithm === -8)
    return encodeCbor(
      new Map<number, Cbor>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, bytes(jwk.x)],
      ]),
    );
  if (algorithm === -257)
    return encodeCbor(
      new Map<number, Cbor>([
        [1, 3],
        [3, -257],
        [-1, bytes(jwk.n)],
        [-2, bytes(jwk.e)],
      ]),
    );
  throw new Error("Unsupported passkey key");
}

// --- relying party ---

/**
 * Whether `rpId` may be used by a page at `origin` (WebAuthn §5.1.3 with
 * Chrome's rules): a secure origin whose host is the id or a subdomain of
 * it, and an id that is a registrable domain, never a public suffix or
 * an IP address. Related origins (.well-known/webauthn) are not consulted.
 */
export function validRelyingParty(origin: string, rpId: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const id = rpId.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    return false;
  if (!id || (host !== id && !host.endsWith(`.${id}`))) return false;
  if (id === "localhost" || id.endsWith(".localhost")) return local;
  const parsed = parse(id, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) return false;
  return id === parsed.domain || id.endsWith(`.${parsed.domain}`);
}

// --- responses ---

/** The client data a response signs over, in WebAuthn's key order. */
export function clientDataJson({
  type,
  challenge,
  origin,
}: {
  type: "webauthn.create" | "webauthn.get";
  challenge: Uint8Array;
  origin: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge: toBase64Url(challenge),
      origin,
      crossOrigin: false,
    }),
    "utf8",
  );
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function authenticatorData({
  rpId,
  flags,
  counter,
  attested,
}: {
  rpId: string;
  flags: number;
  counter: number;
  attested?: Buffer;
}): Buffer {
  const head = Buffer.alloc(37);
  sha256(rpId).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter >>> 0, 33);
  return attested ? Buffer.concat([head, attested]) : head;
}

export interface AttestationResult {
  attestationObject: Buffer;
  authenticatorData: Buffer;
  publicKeySpki: Buffer;
  algorithm: PasskeyAlgorithm;
}

/** A new credential's attestation ("none"), for `create`. */
export function attest({
  rpId,
  credentialId,
  publicKey,
  flags,
}: {
  rpId: string;
  credentialId: Uint8Array;
  publicKey: KeyObject;
  flags: number;
}): AttestationResult {
  const algorithm = algorithmOf(publicKey);
  if (!algorithm) throw new Error("Unsupported passkey key");
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const data = authenticatorData({
    rpId,
    flags: flags | FLAG.attestedCredential,
    counter: 0,
    attested: Buffer.concat([
      WORK_AAGUID,
      idLength,
      Buffer.from(credentialId),
      cosePublicKey(publicKey),
    ]),
  });
  return {
    attestationObject: encodeCbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", data],
      ]),
    ),
    authenticatorData: data,
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }),
    algorithm,
  };
}

/** A signed assertion, for `get`. */
export function assert({
  rpId,
  flags,
  counter,
  clientData,
  privateKey,
}: {
  rpId: string;
  flags: number;
  counter: number;
  clientData: Buffer;
  privateKey: KeyObject;
}): { authenticatorData: Buffer; signature: Buffer } {
  const data = authenticatorData({ rpId, flags, counter });
  const signed = Buffer.concat([data, sha256(clientData)]);
  const signature =
    algorithmOf(privateKey) === -8
      ? sign(null, signed, privateKey)
      : sign("sha256", signed, privateKey);
  return { authenticatorData: data, signature };
}

/** The registration a page receives for a passkey Work just created. */
export function registrationResponse({
  rpId,
  origin,
  challenge,
  credentialId,
  publicKey,
  flags,
  credProps,
}: {
  rpId: string;
  origin: string;
  challenge: Uint8Array;
  credentialId: Uint8Array;
  publicKey: KeyObject;
  flags: number;
  /** The site asked whether the passkey is discoverable (it always is). */
  credProps: boolean;
}): PasskeyCredentialJson {
  const clientData = clientDataJson({
    type: "webauthn.create",
    challenge,
    origin,
  });
  const attested = attest({ rpId, credentialId, publicKey, flags });
  return {
    id: toBase64Url(credentialId),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: toBase64Url(clientData),
      attestationObject: toBase64Url(attested.attestationObject),
      authenticatorData: toBase64Url(attested.authenticatorData),
      publicKey: toBase64Url(attested.publicKeySpki),
      publicKeyAlgorithm: attested.algorithm,
      transports: ["internal"],
    },
    clientExtensionResults: credProps ? { credProps: { rk: true } } : {},
  };
}

/** The signed assertion a page receives when a saved passkey signs in. */
export function assertionResponse({
  rpId,
  origin,
  challenge,
  credentialId,
  userHandle,
  privateKey,
  counter,
  flags,
}: {
  rpId: string;
  origin: string;
  challenge: Uint8Array;
  /** base64url, as stored. */
  credentialId: string;
  userHandle: Uint8Array | null;
  privateKey: KeyObject;
  counter: number;
  flags: number;
}): PasskeyCredentialJson {
  const clientData = clientDataJson({
    type: "webauthn.get",
    challenge,
    origin,
  });
  const signed = assert({ rpId, flags, counter, clientData, privateKey });
  return {
    id: credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: toBase64Url(clientData),
      authenticatorData: toBase64Url(signed.authenticatorData),
      signature: toBase64Url(signed.signature),
      userHandle: userHandle ? toBase64Url(userHandle) : null,
    },
    clientExtensionResults: {},
  };
}
