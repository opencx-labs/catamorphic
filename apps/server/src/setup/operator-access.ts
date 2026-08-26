import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OPERATOR_SECRET_FILE = "operator-secret";

/** Machine authority for local agent operations, never a Catamorphic user. */
export function loadStockOperatorSecret(options: {
  dataDir: string;
  configuredSecret?: string;
}): string {
  if (options.configuredSecret) {
    assertSecretLength(options.configuredSecret);
    return options.configuredSecret;
  }

  fs.mkdirSync(options.dataDir, { recursive: true });
  const file = path.join(options.dataDir, OPERATOR_SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    assertSecretLength(existing);
    fs.chmodSync(file, 0o600);
    return existing;
  } catch (error) {
    if (isNodeError(error) && error.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(file, `${generated}\n`, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file, "utf8").trim();
    assertSecretLength(existing);
    fs.chmodSync(file, 0o600);
    return existing;
  }
}

export function readStockOperatorSecret(options: {
  dataDir: string;
  configuredSecret?: string;
}): string {
  if (options.configuredSecret) {
    assertSecretLength(options.configuredSecret);
    return options.configuredSecret;
  }
  const secret = fs
    .readFileSync(path.join(options.dataDir, OPERATOR_SECRET_FILE), "utf8")
    .trim();
  assertSecretLength(secret);
  return secret;
}

export function verifyStockOperatorSecret(
  authorization: string | undefined,
  expected: string,
): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match?.[1]) return false;
  const actualBytes = Buffer.from(match[1]);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function assertSecretLength(secret: string): void {
  if (secret.length < 32) {
    throw new Error("The stock operator secret must be at least 32 characters");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
