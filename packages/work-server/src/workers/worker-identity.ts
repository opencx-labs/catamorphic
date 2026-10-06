import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** A machine credential and the private key that came with it (PKCS8 PEM). */
export interface WorkerCredentialPair {
  credential: string;
  privateKey: string;
}

/**
 * A worker's identity on its own disk (ADRs 0164, 0206): its machine
 * credential and the private key its operations are sealed to, each in an
 * owner-only file of its data directory. Nothing else of it exists anywhere:
 * losing the data directory means enrolling the worker again.
 */
export interface WorkerIdentity {
  credential: string;
  /** PKCS8 PEM. Absent only for a worker enrolled before sealing. */
  privateKey?: string;
  /**
   * The pair a rotation replaced, kept until the control plane has accepted
   * the new credential once. Should it refuse the new one (a rotation it no
   * longer knows of), the worker goes back to this pair.
   */
  previous?: WorkerCredentialPair;
}

const CREDENTIAL_FILE = "worker-credential";
const KEY_FILE = "worker-key";
/** The pair a rotation replaced, while the new one is unconfirmed. */
const PREVIOUS_FILE = "worker-identity.previous";
/**
 * A rotation's whole new state, written before any file is replaced: it is
 * installed together even across a crash.
 */
const NEXT_FILE = "worker-identity.next";

const PairSchema = z.strictObject({
  credential: z.string().min(1),
  privateKey: z.string().min(1),
});
const NextIdentitySchema = PairSchema.extend({
  previous: PairSchema.optional(),
});

/**
 * The worker's identity, or undefined before it enrolled. A rotation a
 * crash interrupted is finished first.
 */
export function loadWorkerIdentity(
  dataDir: string,
): WorkerIdentity | undefined {
  const next = readIfPresent(path.join(dataDir, NEXT_FILE));
  if (next !== undefined) {
    const parsed = NextIdentitySchema.safeParse(parseJson(next));
    // A torn record never replaced anything: the current pair still holds.
    if (parsed.success) install(dataDir, parsed.data);
    fs.rmSync(path.join(dataDir, NEXT_FILE), { force: true });
  }
  const credential = readIfPresent(path.join(dataDir, CREDENTIAL_FILE))?.trim();
  if (!credential) return undefined;
  const privateKey = readIfPresent(path.join(dataDir, KEY_FILE));
  if (!privateKey) return { credential };
  const previous = PairSchema.safeParse(
    parseJson(readIfPresent(path.join(dataDir, PREVIOUS_FILE)) ?? ""),
  );
  return {
    credential,
    privateKey,
    ...(previous.success ? { previous: previous.data } : {}),
  };
}

/**
 * Save a credential, its key, and the pair it replaces (until the new one is
 * confirmed) so that all are durable together before the worker uses any:
 * the state is written as one record, then each file is replaced
 * atomically, then the record is removed.
 */
export function saveWorkerIdentity(
  dataDir: string,
  identity: WorkerCredentialPair & { previous?: WorkerCredentialPair },
): void {
  writeAtomically(path.join(dataDir, NEXT_FILE), JSON.stringify(identity));
  install(dataDir, identity);
  fs.rmSync(path.join(dataDir, NEXT_FILE), { force: true });
  syncDirectory(dataDir);
}

/**
 * The control plane accepted the current credential: the pair it replaced
 * no longer works anywhere and leaves the disk.
 */
export function confirmWorkerIdentity(dataDir: string): void {
  fs.rmSync(path.join(dataDir, PREVIOUS_FILE), { force: true });
  syncDirectory(dataDir);
}

/** Save the key of a worker enrolled before sealing; its credential stays. */
export function saveWorkerKey(dataDir: string, privateKey: string): void {
  writeAtomically(path.join(dataDir, KEY_FILE), privateKey);
}

function install(
  dataDir: string,
  identity: WorkerCredentialPair & { previous?: WorkerCredentialPair },
) {
  if (identity.previous)
    writeAtomically(
      path.join(dataDir, PREVIOUS_FILE),
      JSON.stringify(identity.previous),
    );
  else fs.rmSync(path.join(dataDir, PREVIOUS_FILE), { force: true });
  writeAtomically(path.join(dataDir, KEY_FILE), identity.privateKey);
  writeAtomically(
    path.join(dataDir, CREDENTIAL_FILE),
    `${identity.credential}\n`,
  );
}

/** Write a temporary file, flush it to disk, then rename it into place. */
function writeAtomically(file: string, content: string): void {
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

/** Make renames in `dir` durable; some platforms cannot sync a directory. */
function syncDirectory(dir: string): void {
  try {
    const handle = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    /* Not supported here; the rename itself is still atomic. */
  }
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
