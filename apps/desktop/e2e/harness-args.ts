export function electronLaunchArgs({
  cdpPort,
  ci,
  platform,
  useMockKeychain = false,
}: {
  cdpPort: number;
  ci: string | undefined;
  platform: NodeJS.Platform;
  useMockKeychain?: boolean;
}): string[] {
  return [
    ".",
    `--remote-debugging-port=${cdpPort}`,
    ...(platform === "darwin" && useMockKeychain
      ? ["--use-mock-keychain"]
      : []),
    ...(ci === "true" && platform === "linux" ? ["--no-sandbox"] : []),
  ];
}
