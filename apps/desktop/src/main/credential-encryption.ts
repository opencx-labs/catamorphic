import { app, safeStorage } from "electron";
import { shouldUseE2ePlainTextEncryption } from "./e2e-safe-storage.js";

/** A host-authored message that is safe to show without exposing provider errors. */
export class CredentialStorageError extends Error {
  override name = "CredentialStorageError";
}

/** Electron's Linux basic_text backend uses a public hardcoded password. */
export function credentialEncryptionAvailable({
  storage = safeStorage,
  platform = process.platform,
  e2eDataDir = process.env.CATAMORPHIC_E2E_DATA_DIR,
}: {
  storage?: Pick<
    typeof safeStorage,
    "isEncryptionAvailable" | "getSelectedStorageBackend"
  >;
  platform?: NodeJS.Platform;
  e2eDataDir?: string;
} = {}): boolean {
  return (
    storage.isEncryptionAvailable() &&
    secureStorageBackend({ storage, platform, e2eDataDir })
  );
}

/** Keep keychain prompts off Electron's main thread when the caller is async. */
export async function credentialEncryptionAvailableAsync({
  storage = safeStorage,
  platform = process.platform,
  e2eDataDir = process.env.CATAMORPHIC_E2E_DATA_DIR,
}: {
  storage?: Pick<
    typeof safeStorage,
    "isAsyncEncryptionAvailable" | "getSelectedStorageBackend"
  >;
  platform?: NodeJS.Platform;
  e2eDataDir?: string;
} = {}): Promise<boolean> {
  return (
    (await storage.isAsyncEncryptionAvailable()) &&
    secureStorageBackend({ storage, platform, e2eDataDir })
  );
}

function secureStorageBackend({
  storage,
  platform,
  e2eDataDir,
}: {
  storage: Pick<typeof safeStorage, "getSelectedStorageBackend">;
  platform: NodeJS.Platform;
  e2eDataDir: string | undefined;
}): boolean {
  if (
    platform !== "linux" ||
    (e2eDataDir !== undefined &&
      !app.isPackaged &&
      shouldUseE2ePlainTextEncryption({ platform, e2eDataDir }))
  )
    return true;
  const backend = storage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

export function requireCredentialEncryption(): void {
  if (!credentialEncryptionAvailable())
    throw new CredentialStorageError(
      "OS credential encryption is unavailable. Unlock your operating system's keychain or enable a secure credential store, then try again.",
    );
}

export function credentialUnlockError({ cause }: { cause: unknown }): Error {
  return new CredentialStorageError(
    "Work could not unlock the saved credential. Unlock your operating system's keychain and try again. If it still cannot be opened, reconnect the account in Settings.",
    { cause },
  );
}
