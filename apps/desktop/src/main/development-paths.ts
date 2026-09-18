import path from "node:path";

export function desktopDataDirFromEnvironment(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return env.CATAMORPHIC_E2E_DATA_DIR ?? env.CATAMORPHIC_DESKTOP_DATA_DIR;
}

export function desktopApplicationName(input: {
  isPackaged: boolean;
  isolatedDataDir?: string;
}): "Work" | "Work Development" {
  return !input.isPackaged || input.isolatedDataDir
    ? "Work Development"
    : "Work";
}

export function defaultDesktopProjectsDir(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const isolatedDataDir = desktopDataDirFromEnvironment(input.env);
  return path.join(isolatedDataDir ?? input.homeDir, "Work");
}
