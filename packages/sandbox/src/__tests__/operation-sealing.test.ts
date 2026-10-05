import { describe, expect, it } from "vitest";
import {
  ExecutorPublicKeySchema,
  executorPublicKey,
  generateExecutorKeyPair,
  openOperation,
  type SealedOperation,
  SealedOperationOpenError,
  sealOperation,
} from "../operation-sealing.js";

const plaintext = JSON.stringify({
  kind: "upload",
  sandboxId: "sandbox-1",
  files: { ".env": "STRIPE_KEY=sk_test_secret" },
  basePath: "/workspace",
});
const aad = '["operation-1","node:worker.build-1","upload"]';

/** Flip one bit of a base64 field. */
function flipped(value: string, byte = 0): string {
  const bytes = Buffer.from(value, "base64");
  bytes[byte] = (bytes[byte] ?? 0) ^ 1;
  return bytes.toString("base64");
}

describe("operations sealed to their executor (ADR 0206)", () => {
  it("opens for the executor it was sealed to", () => {
    const keys = generateExecutorKeyPair();
    expect(ExecutorPublicKeySchema.safeParse(keys.publicKey).success).toBe(
      true,
    );
    expect(executorPublicKey(keys.privateKey)).toBe(keys.publicKey);
    const sealed = sealOperation({
      plaintext,
      recipientPublicKey: keys.publicKey,
      aad,
    });
    expect(sealed.v).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain("sk_test_secret");
    expect(openOperation({ sealed, privateKey: keys.privateKey, aad })).toBe(
      plaintext,
    );
  });

  it("never opens with another executor's key", () => {
    const recipient = generateExecutorKeyPair();
    const other = generateExecutorKeyPair();
    const sealed = sealOperation({
      plaintext,
      recipientPublicKey: recipient.publicKey,
      aad,
    });
    expect(() =>
      openOperation({ sealed, privateKey: other.privateKey, aad }),
    ).toThrow(SealedOperationOpenError);
  });

  it("refuses altered associated data, ciphertext, nonce or ephemeral key", () => {
    const keys = generateExecutorKeyPair();
    const sealed = sealOperation({
      plaintext,
      recipientPublicKey: keys.publicKey,
      aad,
    });
    const open = (candidate: SealedOperation, candidateAad = aad) =>
      openOperation({
        sealed: candidate,
        privateKey: keys.privateKey,
        aad: candidateAad,
      });
    // Another operation's id, or another executor.
    expect(() =>
      open(sealed, '["operation-2","node:worker.build-1","upload"]'),
    ).toThrow(SealedOperationOpenError);
    expect(() =>
      open(sealed, '["operation-1","client:laptop","upload"]'),
    ).toThrow(SealedOperationOpenError);
    expect(() => open({ ...sealed, ct: flipped(sealed.ct) })).toThrow(
      SealedOperationOpenError,
    );
    // The appended tag itself.
    expect(() =>
      open({
        ...sealed,
        ct: flipped(sealed.ct, Buffer.from(sealed.ct, "base64").length - 1),
      }),
    ).toThrow(SealedOperationOpenError);
    expect(() => open({ ...sealed, nonce: flipped(sealed.nonce) })).toThrow(
      SealedOperationOpenError,
    );
    expect(() => open({ ...sealed, epk: flipped(sealed.epk) })).toThrow(
      SealedOperationOpenError,
    );
    // A low-order ephemeral key makes no agreement.
    expect(() =>
      open({ ...sealed, epk: Buffer.alloc(32).toString("base64") }),
    ).toThrow(SealedOperationOpenError);
    expect(() => open({ ...sealed, ct: "" })).toThrow(SealedOperationOpenError);
  });

  it("seals the same operation differently every time", () => {
    const keys = generateExecutorKeyPair();
    const seal = () =>
      sealOperation({ plaintext, recipientPublicKey: keys.publicKey, aad });
    const first = seal();
    const second = seal();
    expect(first.epk).not.toBe(second.epk);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ct).not.toBe(second.ct);
    expect(
      openOperation({ sealed: second, privateKey: keys.privateKey, aad }),
    ).toBe(plaintext);
  });

  it("refuses a public key that is not a raw X25519 key", () => {
    for (const recipientPublicKey of [
      "",
      "not-a-key",
      Buffer.alloc(31).toString("base64"),
      Buffer.alloc(33).toString("base64"),
    ])
      expect(() =>
        sealOperation({ plaintext, recipientPublicKey, aad }),
      ).toThrow();
  });
});
