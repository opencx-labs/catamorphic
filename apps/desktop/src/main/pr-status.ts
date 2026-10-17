import {
  CodeHostNotConnectedError,
  type PullRequestStatus,
} from "@catamorphic/core";
import {
  GithubApi,
  GithubApiError,
  pullRequestFromUrl,
} from "@catamorphic/github";
import { githubCliToken } from "./github-cli.js";

/**
 * Where the pull request at a web address stands (ADR 0239), for the chip
 * of the chat that recorded it: read with the person's own connection to
 * the host serving the address, else the GitHub CLI when they turned it on
 * (ADR 0117). Null when nothing here may read it, so the chip shows what
 * the chat recorded; a failure worth retrying throws.
 */
export async function readPullRequestStatus({
  url,
  viaConnection,
  cliEnabled,
  cliToken = githubCliToken,
}: {
  url: string;
  /** The person's connection through core's code hosts, or null. */
  viaConnection: (url: string) => Promise<PullRequestStatus | null>;
  cliEnabled: boolean;
  cliToken?: () => Promise<string | null>;
}): Promise<PullRequestStatus | null> {
  try {
    const status = await viaConnection(url);
    if (status) return status;
  } catch (error) {
    if (!(error instanceof CodeHostNotConnectedError) && !refused(error))
      throw error;
  }
  if (!cliEnabled) return null;
  const pull = pullRequestFromUrl({ url });
  const token = pull ? await cliToken() : null;
  if (!pull || !token) return null;
  try {
    return await new GithubApi(token, {
      signal: AbortSignal.timeout(15_000),
    }).pullRequestStatus(pull);
  } catch (error) {
    if (refused(error)) return null;
    throw error;
  }
}

/** A pull request's web address, as the window may ask for one. */
export function pullRequestAddress(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length > 2048 ||
    !/^https?:\/\/[^\s/]+\/\S*$/i.test(raw)
  )
    throw new Error("A pull request is read by its web address.");
  return raw;
}

/** GitHub said no (or that there is nothing there) for this credential. */
function refused(error: unknown): boolean {
  return (
    error instanceof GithubApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

/**
 * Credential-free statuses for the fake agent's runs: pull requests in an
 * `acme/*` repository on github.com stand where their number says, so a
 * test can show every state; any other address has no status, as when
 * nothing may read it. Undefined outside those runs.
 */
export function e2ePullRequestStatus(
  url: string,
): PullRequestStatus | null | undefined {
  if (process.env.CATAMORPHIC_E2E_FAKE_AGENT !== "1") return undefined;
  const pull = pullRequestFromUrl({ url });
  if (!pull?.fullName.startsWith("acme/")) return null;
  const { number } = pull;
  const states = ["open", "draft", "merged", "closed"] as const;
  const state = states[number % states.length] ?? "open";
  return {
    number,
    title: `Chips that say where work stands (#${number})`,
    url,
    repository: pull.fullName,
    author: "octo",
    head: `work/chips-${number}`,
    base: "main",
    state,
    additions: (number * 389) % 15_000,
    deletions: number % 3 === 0 ? 0 : (number * 53) % 900,
    changedFiles: 3 + (number % 9),
    comments: number % 5 === 0 ? 0 : number % 12,
    ...(state === "open"
      ? {
          checks:
            number % 3 === 0
              ? { state: "failure", passed: 4, failed: 1, pending: 0 }
              : number % 3 === 1
                ? { state: "pending", passed: 3, failed: 0, pending: 2 }
                : { state: "success", passed: 5, failed: 0, pending: 0 },
        }
      : {}),
    updatedAt: "2026-10-16T09:00:00.000Z",
  };
}
