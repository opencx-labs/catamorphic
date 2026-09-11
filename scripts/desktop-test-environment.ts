/** An execution boundary, not a flag that suppresses native app behavior. */
export function isIsolatedDesktopTestHost(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (input.platform === "linux") {
    return (
      input.env.CATAMORPHIC_E2E_PRIVATE_DISPLAY === "1" &&
      /^:[0-9]+$/.test(input.env.DISPLAY ?? "")
    );
  }
  return (
    input.platform === "darwin" &&
    input.env.GITHUB_ACTIONS === "true" &&
    input.env.RUNNER_ENVIRONMENT === "github-hosted"
  );
}

export function assertIsolatedDesktopTestHost(): void {
  if (
    !isIsolatedDesktopTestHost({ platform: process.platform, env: process.env })
  ) {
    throw new Error(
      "Desktop tests require a private display. Run bun run --cwd apps/desktop test:e2e to use Docker. Native macOS tests require a dedicated GitHub-hosted runner.",
    );
  }
}
