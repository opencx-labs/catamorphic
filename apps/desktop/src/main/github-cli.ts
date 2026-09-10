import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeGit } from "@catamorphic/git";
import { GithubApi, repoFullNameFromUrl } from "@catamorphic/github";
import {
  inlineCommentsSchema,
  type PrCommentInput,
  postedCommentSchema,
  prDetailsSchema,
} from "../shared/pr-details.js";

const execFileAsync = promisify(execFile);

export type GithubCliCommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

/**
 * Read the github.com credential already held by `gh`. The CLI is only a
 * credential source: repository checks, cloning, sync, and pull requests all
 * continue through GithubService and the shared git engine.
 */
export async function githubCliToken(
  options: { run?: GithubCliCommandRunner } = {},
): Promise<string | null> {
  const run = options.run ?? runCommand;
  try {
    const result = await run("gh", [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runCommand(
  file: string,
  args: string[],
): Promise<{ stdout: string }> {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return { stdout: String(result.stdout) };
}

/** Use the local repository remote and the CLI account for desktop PR reads. */
export async function githubCliRepository(rootPath: string) {
  let remote: string;
  try {
    remote = (
      await nativeGit(rootPath, ["remote", "get-url", "origin"])
    ).trim();
  } catch {
    return null;
  }
  const fullName = repoFullNameFromUrl(remote);
  if (
    !fullName ||
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(
      remote,
    )
  )
    return null;
  const token = await githubCliToken();
  if (!token) return null;
  return {
    fullName,
    api: new GithubApi(token, { signal: AbortSignal.timeout(30000) }),
  };
}

export async function githubCliPrDetails({
  rootPath,
  number,
}: {
  rootPath: string;
  number: number;
}) {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("Invalid pull request number.");
  const repository = await githubCliRepository(rootPath);
  if (!repository)
    throw new Error("[github-cli-required] Sign in with gh auth login.");
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      repository.fullName,
      "--json",
      "state,reviewDecision,assignees,reviewRequests,reviews,comments,statusCheckRollup",
    ],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const details = prDetailsSchema.parse(JSON.parse(stdout));
  try {
    const inline = await execFileAsync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository.fullName}/pulls/${number}/comments`,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    details.inlineComments = inlineCommentsSchema
      .parse(JSON.parse(inline.stdout))
      .flat()
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        author: comment.user,
        createdAt: comment.created_at,
        url: comment.html_url,
        path: comment.path,
        line: comment.line,
        replyToId: comment.in_reply_to_id,
        diffHunk: comment.diff_hunk,
        side: comment.side,
      }));
  } catch {
    details.inlineCommentsUnavailable = true;
  }
  return details;
}

/** Payload is sent over stdin, never exposed in a shell command or process arguments. */
export async function githubCliPrComment({
  rootPath,
  input,
}: {
  rootPath: string;
  input: PrCommentInput;
}) {
  const repository = await githubCliRepository(rootPath);
  if (!repository)
    throw new Error("[github-cli-required] Sign in with gh auth login.");
  const endpoint = input.replyTo
    ? `repos/${repository.fullName}/pulls/${input.number}/comments/${input.replyTo}/replies`
    : `repos/${repository.fullName}/issues/${input.number}/comments`;
  const request = execFileAsync(
    "gh",
    ["api", endpoint, "--method", "POST", "--input", "-"],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  request.child.stdin?.end(JSON.stringify({ body: input.body }));
  try {
    const { stdout } = await request;
    const comment = postedCommentSchema.parse(JSON.parse(stdout));
    return {
      id: comment.id,
      body: comment.body,
      author: comment.user,
      createdAt: comment.created_at,
      url: comment.html_url,
      path: comment.path,
      line: comment.line,
      replyToId: comment.in_reply_to_id,
      diffHunk: comment.diff_hunk,
      side: comment.side,
    };
  } catch {
    throw new Error(
      "Could not confirm the comment was posted. Check GitHub before trying again. Your draft is preserved.",
    );
  }
}
