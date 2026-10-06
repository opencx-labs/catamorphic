import crypto from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CrxError,
  extensionIdFromKey,
  keyHash,
  verifyCrx,
  WEB_STORE_PUBLISHER_KEY_HASH,
} from "./crx.js";
import { buildCrx } from "./crx-builder.js";

const developer = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publisher = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = (key: crypto.KeyObject) =>
  key.export({ format: "der", type: "spki" }) as Buffer;
const publisherHash = keyHash(spki(publisher.publicKey));

const archive = Buffer.from(
  zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ manifest_version: 3, name: "Test", version: "1.0" }),
    ),
  }),
);

describe("extension ids", () => {
  it("maps the key hash prefix to Chrome's a-p alphabet", () => {
    const id = extensionIdFromKey(spki(developer.publicKey));
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).toBe(extensionIdFromKey(spki(developer.publicKey)));
  });

  it("names the Web Store's real publisher key", () => {
    expect(WEB_STORE_PUBLISHER_KEY_HASH).toMatch(/^61f7f2a6/);
  });
});

describe("verifyCrx", () => {
  const signed = buildCrx({
    archive,
    developerKey: developer.privateKey,
    publisherKey: publisher.privateKey,
  });

  it("accepts a package signed by its developer and the store", () => {
    const verified = verifyCrx(signed, {
      publisherKeyHashes: [publisherHash],
    });
    expect(verified.id).toBe(extensionIdFromKey(spki(developer.publicKey)));
    expect(verified.publicKey.equals(spki(developer.publicKey))).toBe(true);
    expect(verified.archive.equals(archive)).toBe(true);
  });

  it("rejects a package without the store's signature", () => {
    const unpublished = buildCrx({
      archive,
      developerKey: developer.privateKey,
    });
    expect(() =>
      verifyCrx(unpublished, { publisherKeyHashes: [publisherHash] }),
    ).toThrow("not signed by the Chrome Web Store");
    expect(verifyCrx(unpublished, { publisherKeyHashes: null }).id).toMatch(
      /^[a-p]{32}$/,
    );
  });

  it("rejects a package whose archive changed after signing", () => {
    const tampered = Buffer.from(signed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(() =>
      verifyCrx(tampered, { publisherKeyHashes: [publisherHash] }),
    ).toThrow("does not verify");
  });

  it("rejects a package for another extension id", () => {
    expect(() =>
      verifyCrx(signed, {
        publisherKeyHashes: [publisherHash],
        expectedId: extensionIdFromKey(spki(stranger.publicKey)),
      }),
    ).toThrow("different extension");
  });

  it("rejects a package signed only by a key that is not its id's", () => {
    // Signed by the store, but the "developer" signature is a stranger's:
    // the id in the header still names the real developer key.
    const forged = buildCrx({
      archive,
      developerKey: stranger.privateKey,
      publisherKey: publisher.privateKey,
    });
    const header = forged.subarray(12, 12 + forged.readUInt32LE(8));
    const realId = crypto
      .createHash("sha256")
      .update(spki(developer.publicKey))
      .digest()
      .subarray(0, 16);
    const strangerId = crypto
      .createHash("sha256")
      .update(spki(stranger.publicKey))
      .digest()
      .subarray(0, 16);
    const at = header.indexOf(strangerId);
    expect(at).toBeGreaterThan(0);
    realId.copy(header, at);
    expect(() =>
      verifyCrx(forged, { publisherKeyHashes: [publisherHash] }),
    ).toThrow(CrxError);
  });

  it("rejects other formats", () => {
    expect(() =>
      verifyCrx(Buffer.from("PK\x03\x04 not a crx"), {
        publisherKeyHashes: null,
      }),
    ).toThrow("Not a Chrome extension package");
    const crx2 = Buffer.from(signed);
    crx2.writeUInt32LE(2, 4);
    expect(() => verifyCrx(crx2, { publisherKeyHashes: null })).toThrow("CRX2");
    const truncated = signed.subarray(0, 40);
    expect(() => verifyCrx(truncated, { publisherKeyHashes: null })).toThrow(
      CrxError,
    );
  });
});
