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
    ...(ci === "true" && platform === "linux"
      ? [
          "--no-sandbox",
          // GitHub's Xvfb runner has no Secret Service. The test profiles are
          // isolated throwaway directories, so use Chromium's basic backend
          // to keep safeStorage-backed connection flows testable there.
          "--password-store=basic",
        ]
      : []),
  ];
}
