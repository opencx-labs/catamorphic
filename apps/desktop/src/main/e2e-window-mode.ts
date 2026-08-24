export interface WindowModeOptions {
  e2eDataDir: string | undefined;
  e2eWindowMode: string | undefined;
}

export interface E2eSafeStorageOptions {
  e2eDataDir: string | undefined;
  platform: NodeJS.Platform;
}

/** Production windows always show. E2E windows show only in realism mode. */
export function shouldShowWindow({
  e2eDataDir,
  e2eWindowMode,
}: WindowModeOptions): boolean {
  return e2eDataDir === undefined || e2eWindowMode === "visible";
}

/** Linux CI has no Secret Service; only throwaway E2E profiles may opt in. */
export function shouldUseE2ePlainTextEncryption({
  e2eDataDir,
  platform,
}: E2eSafeStorageOptions): boolean {
  return e2eDataDir !== undefined && platform === "linux";
}
