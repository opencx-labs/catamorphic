import { isNamedError } from "./engine/channel.js";

/**
 * Whether a code-host call failed because the person's connection cannot
 * reach the repository: signed out or expired, not authorized for it, or the
 * repository invisible to it (GitHub answers 404 when the App is not
 * installed on the repository's owner). The call is answered by the engine
 * (ADR 0341), so its error arrives as its name and plain fields.
 */
export function codeHostAccessDenied(error: unknown): boolean {
  if (isNamedError(error, "GithubApiError"))
    return (
      "status" in error &&
      typeof error.status === "number" &&
      [401, 403, 404].includes(error.status)
    );
  return (
    isNamedError(error, "GithubAuthError") ||
    isNamedError(error, "ConnectionUnavailableError") ||
    isNamedError(error, "CodeHostNotConnectedError")
  );
}

/**
 * Runs a pull request operation through the person's code-host connection
 * (ADR 0177). When that connection cannot reach the repository and the
 * GitHub CLI is on, answers `null` so the caller falls through to the CLI
 * (ADR 0117); every other failure, or any failure with the CLI off, throws.
 */
export async function throughCodeHost<Host, T>(args: {
  codeHosts: Host | null;
  cliEnabled: boolean;
  run: (codeHosts: Host) => Promise<T>;
}): Promise<{ value: T } | null> {
  if (!args.codeHosts) return null;
  try {
    return { value: await args.run(args.codeHosts) };
  } catch (error) {
    if (args.cliEnabled && codeHostAccessDenied(error)) return null;
    throw error;
  }
}
