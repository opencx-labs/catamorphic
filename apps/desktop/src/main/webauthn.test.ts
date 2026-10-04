import { randomBytes } from "node:crypto";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import {
  assertionResponse,
  encodeCbor,
  FLAG,
  fromBase64Url,
  generatePasskeyKey,
  type PasskeyAlgorithm,
  pemFromPkcs8,
  readPrivateKey,
  registrationResponse,
  toBase64Url,
  validRelyingParty,
  WORK_AAGUID,
} from "./webauthn.js";

const origin = "https://app.example.com";
const rpId = "example.com";
const verified = FLAG.userPresent | FLAG.userVerified | FLAG.backupEligible;

/**
 * Work's responses checked by a real relying party library, the way a
 * site's server checks them: a registration it accepts, then sign-ins
 * signed with the stored key.
 */
async function register(algorithm: PasskeyAlgorithm) {
  const challenge = randomBytes(32);
  const credentialId = randomBytes(16);
  const { privateKeyPem, publicKey } = generatePasskeyKey(algorithm);
  const response = registrationResponse({
    rpId,
    origin,
    challenge,
    credentialId,
    publicKey,
    flags: verified,
    credProps: true,
  });
  const checked = await verifyRegistrationResponse({
    response: {
      id: response.id,
      rawId: response.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: response.response.clientDataJSON,
        attestationObject: response.response.attestationObject ?? "",
        transports: ["internal"],
      },
      clientExtensionResults: response.clientExtensionResults,
    },
    expectedChallenge: toBase64Url(challenge),
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  });
  return { response, checked, privateKeyPem, credentialId };
}

describe("registration and sign-in", () => {
  it.each([-7, -8, -257] as const)(
    "a site accepts algorithm %i end to end",
    async (algorithm) => {
      const { response, checked, privateKeyPem, credentialId } =
        await register(algorithm);
      expect(checked.verified).toBe(true);
      const info = checked.registrationInfo;
      if (!info) throw new Error("No registration info");
      expect(info.fmt).toBe("none");
      expect(info.aaguid).toBe(
        [
          WORK_AAGUID.subarray(0, 4),
          WORK_AAGUID.subarray(4, 6),
          WORK_AAGUID.subarray(6, 8),
          WORK_AAGUID.subarray(8, 10),
          WORK_AAGUID.subarray(10),
        ]
          .map((part) => part.toString("hex"))
          .join("-"),
      );
      expect(info.credentialDeviceType).toBe("multiDevice");
      expect(info.credentialBackedUp).toBe(false);
      expect(info.userVerified).toBe(true);
      expect(response.response.publicKeyAlgorithm).toBe(algorithm);
      expect(response.clientExtensionResults).toEqual({
        credProps: { rk: true },
      });

      const key = readPrivateKey(privateKeyPem);
      if (!key) throw new Error("Unreadable key");
      expect(key.algorithm).toBe(algorithm);
      const userHandle = randomBytes(8);
      const challenge = randomBytes(32);
      const assertion = assertionResponse({
        rpId,
        origin,
        challenge,
        credentialId: toBase64Url(credentialId),
        userHandle,
        privateKey: key.key,
        counter: 0,
        flags: verified,
      });
      expect(assertion.response.userHandle).toBe(toBase64Url(userHandle));
      const signedIn = await verifyAuthenticationResponse({
        response: {
          id: assertion.id,
          rawId: assertion.id,
          type: "public-key",
          response: {
            clientDataJSON: assertion.response.clientDataJSON,
            authenticatorData: assertion.response.authenticatorData,
            signature: assertion.response.signature ?? "",
            userHandle: assertion.response.userHandle ?? undefined,
          },
          clientExtensionResults: {},
        },
        expectedChallenge: toBase64Url(challenge),
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: info.credential,
        requireUserVerification: true,
      });
      expect(signedIn.verified).toBe(true);
    },
  );

  it("signs the client data a site expects, in WebAuthn's key order", async () => {
    const { response } = await register(-7);
    const clientData = fromBase64Url(
      response.response.clientDataJSON,
    ).toString();
    expect(Object.keys(JSON.parse(clientData))).toEqual([
      "type",
      "challenge",
      "origin",
      "crossOrigin",
    ]);
    expect(JSON.parse(clientData)).toMatchObject({
      type: "webauthn.create",
      origin,
      crossOrigin: false,
    });
  });

  it("carries an imported passkey's counter forward", async () => {
    const { checked, privateKeyPem, credentialId } = await register(-7);
    const info = checked.registrationInfo;
    const key = readPrivateKey(privateKeyPem);
    if (!info || !key) throw new Error("No registration");
    const challenge = randomBytes(32);
    const signedIn = await verifyAuthenticationResponse({
      response: (() => {
        const assertion = assertionResponse({
          rpId,
          origin,
          challenge,
          credentialId: toBase64Url(credentialId),
          userHandle: null,
          privateKey: key.key,
          counter: 42,
          flags: FLAG.userPresent,
        });
        return {
          id: assertion.id,
          rawId: assertion.id,
          type: "public-key" as const,
          response: {
            clientDataJSON: assertion.response.clientDataJSON,
            authenticatorData: assertion.response.authenticatorData,
            signature: assertion.response.signature ?? "",
          },
          clientExtensionResults: {},
        };
      })(),
      expectedChallenge: toBase64Url(challenge),
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: { ...info.credential, counter: 41 },
      requireUserVerification: false,
    });
    expect(signedIn.authenticationInfo.newCounter).toBe(42);
    expect(signedIn.authenticationInfo.userVerified).toBe(false);
  });
});

describe("keys", () => {
  it("reads PKCS#8 from an export's DER and refuses keys it cannot sign with", () => {
    const { privateKeyPem } = generatePasskeyKey(-7);
    const der = Buffer.from(
      privateKeyPem.replace(/-----[^-]+-----|\s/g, ""),
      "base64",
    );
    expect(readPrivateKey(pemFromPkcs8(der))?.algorithm).toBe(-7);
    expect(readPrivateKey("not a key")).toBeNull();
  });

  it("accepts base64 and base64url alike", () => {
    const bytes = Buffer.from([251, 255, 191, 0]);
    expect(fromBase64Url(bytes.toString("base64"))).toEqual(bytes);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it("encodes CBOR lengths across their size classes", () => {
    expect(encodeCbor(23)).toEqual(Buffer.from([0x17]));
    expect(encodeCbor(-1)).toEqual(Buffer.from([0x20]));
    expect(encodeCbor(500)).toEqual(Buffer.from([0x19, 0x01, 0xf4]));
    expect(encodeCbor(new Uint8Array(300)).subarray(0, 3)).toEqual(
      Buffer.from([0x59, 0x01, 0x2c]),
    );
    expect(encodeCbor("fmt")).toEqual(Buffer.from([0x63, 0x66, 0x6d, 0x74]));
  });
});

describe("validRelyingParty", () => {
  it.each([
    ["https://app.example.com", "example.com", true],
    ["https://app.example.com", "app.example.com", true],
    ["https://example.com", "app.example.com", false],
    ["https://example.com", "com", false],
    ["https://evil-example.com", "example.com", false],
    ["https://app.example.co.uk", "co.uk", false],
    ["https://user.github.io", "github.io", false],
    ["https://user.github.io", "user.github.io", true],
    ["http://example.com", "example.com", false],
    ["http://localhost:3000", "localhost", true],
    ["http://app.localhost", "localhost", true],
    ["https://127.0.0.1", "127.0.0.1", false],
    ["file:///tmp", "", false],
  ])("%s may use %s: %s", (pageOrigin, id, allowed) => {
    expect(validRelyingParty(pageOrigin, id)).toBe(allowed);
  });
});
