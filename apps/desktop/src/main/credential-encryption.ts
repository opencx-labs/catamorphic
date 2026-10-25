import { safeStorage } from "electron";
import { shouldUseE2ePlainTextEncryption } from "./e2e-safe-storage.js";

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
  if (!storage.isEncryptionAvailable()) return false;
  if (
    platform !== "linux" ||
    shouldUseE2ePlainTextEncryption({ platform, e2eDataDir })
  )
    return true;
  const backend = storage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}
