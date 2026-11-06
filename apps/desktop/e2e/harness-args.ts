export function electronLaunchArgs({
  cdpPort,
  ci,
  platform,
  useMockKeychain = false,
  sandboxedRenderers = false,
  fakeAudioCapture,
}: {
  cdpPort: number;
  ci: string | undefined;
  platform: NodeJS.Platform;
  useMockKeychain?: boolean;
  /** A WAV the synthetic microphone plays once instead of its beeps. */
  fakeAudioCapture?: string;
  /** Run every renderer as Electron's sandboxed renderer (see below). */
  sandboxedRenderers?: boolean;
}): string[] {
  return [
    ".",
    `--remote-debugging-port=${cdpPort}`,
    // Pages get a synthetic camera and microphone; the permission prompt
    // stays real (the fake-UI switch would skip it).
    "--use-fake-device-for-media-stream",
    ...(fakeAudioCapture
      ? [`--use-file-for-fake-audio-capture=${fakeAudioCapture}%noloop`]
      : []),
    ...(platform === "darwin" && useMockKeychain
      ? ["--use-mock-keychain"]
      : []),
    // Linux CI runners cannot use Chromium's OS sandbox, which also turns
    // off Electron's sandboxed renderers. Extension service workers need
    // those for their preload (ADR 0203), as users have them; a suite that
    // asks gets them back for every renderer, its own windows included.
    ...(ci === "true" && platform === "linux"
      ? ["--no-sandbox", ...(sandboxedRenderers ? ["--enable-sandbox"] : [])]
      : []),
  ];
}
