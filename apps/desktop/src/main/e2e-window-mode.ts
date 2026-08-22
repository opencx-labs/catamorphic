export interface WindowModeOptions {
  e2eDataDir: string | undefined;
  e2eWindowMode: string | undefined;
}

/** Production windows always show. E2E windows show only in realism mode. */
export function shouldShowWindow({
  e2eDataDir,
  e2eWindowMode,
}: WindowModeOptions): boolean {
  return e2eDataDir === undefined || e2eWindowMode === "visible";
}
