export interface E2eSafeStorageOptions {
  e2eDataDir: string | undefined;
  platform: NodeJS.Platform;
}

/** Linux CI has no Secret Service; only throwaway E2E profiles may opt in. */
export function shouldUseE2ePlainTextEncryption({
  e2eDataDir,
  platform,
}: E2eSafeStorageOptions): boolean {
  return e2eDataDir !== undefined && platform === "linux";
}
