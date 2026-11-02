/** Reject Chromium's separate debugging server as well as Node's fused-off inspector. */
export function assertProductionLaunchArguments({
  isPackaged,
  args = process.argv,
  hasSwitch = () => false,
}: {
  isPackaged: boolean;
  args?: readonly string[];
  /** Electron's parsed command line also covers platform-specific switch spelling. */
  hasSwitch?: (name: string) => boolean;
}): void {
  if (!isPackaged) return;
  const debugging =
    args.some((arg) =>
      /^-{1,2}(?:remote-debugging(?:-[a-z-]+)?|remote-allow-origins)(?:=|$)/i.test(
        arg,
      ),
    ) ||
    [
      "remote-debugging-port",
      "remote-debugging-pipe",
      "remote-debugging-address",
      "remote-allow-origins",
    ].some(hasSwitch);
  if (debugging)
    throw new Error(
      "Work cannot start with remote debugging enabled. Remove the remote debugging launch flags and open Work again.",
    );
}
