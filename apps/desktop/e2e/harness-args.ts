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
    // Pages get a synthetic camera and microphone; the permission prompt
    // stays real (the fake-UI switch would skip it).
    "--use-fake-device-for-media-stream",
    ...(platform === "darwin" && useMockKeychain
      ? ["--use-mock-keychain"]
      : []),
    // Linux CI runners cannot use Chromium's OS sandbox. Renderers still
    // run as Electron's sandboxed renderers, as they do for users: service
    // worker preloads (extension APIs, ADR 0203) exist only there.
    ...(ci === "true" && platform === "linux"
      ? ["--no-sandbox", "--enable-sandbox"]
      : []),
  ];
}
