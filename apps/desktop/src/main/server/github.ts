import type { GithubAppConfig } from "@catamorphic/github";
import {
  defineGithubConnectionProvider,
  type GithubConnectionProvider,
} from "@catamorphic/server-sdk";

/**
 * The GitHub App people sign in with (ADR 0177). Only the OAuth client id
 * ships with the desktop: the device flow needs no secret. The default is
 * the current app until an organization owner registers the Work-branded
 * one (#107); forks and self-hosters point at their own with
 * `WORK_GITHUB_CLIENT_ID` and `WORK_GITHUB_APP_SLUG`.
 */
export const GITHUB_APP: GithubAppConfig = {
  clientId: process.env.WORK_GITHUB_CLIENT_ID ?? "Iv23ctJpmtmboLcXS2rE",
  appSlug: process.env.WORK_GITHUB_APP_SLUG ?? "catamorphic-ai",
};

/**
 * GitHub as an ordinary connection on the desktop: the person's own account,
 * signed in with the device flow and kept in the credential vault like any
 * connection. Completing a device authorization waits until the person
 * finishes on GitHub or the code expires.
 */
export function desktopGithubProvider(
  options: { fetch?: typeof fetch } = {},
): GithubConnectionProvider {
  return defineGithubConnectionProvider({
    oauth: GITHUB_APP,
    devicePollTimeoutMs: 15 * 60 * 1000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
