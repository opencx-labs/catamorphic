export function electronLaunchArgs({
  cdpPort,
  ci,
  platform,
}: {
  cdpPort: number;
  ci: string | undefined;
  platform: NodeJS.Platform;
}): string[] {
  return [
    ".",
    `--remote-debugging-port=${cdpPort}`,
    ...(ci === "true" && platform === "linux" ? ["--no-sandbox"] : []),
  ];
}
