import {
  type PrComment,
  type PrCommentInput,
  prDetailsSchema,
} from "../../shared/pr-details.js";

const postedComments: PrComment[] = [];

/** Credential-free data, enabled only with both explicit E2E switches. */
export function e2eReviewFixture() {
  if (
    process.env.CATAMORPHIC_E2E_FAKE_AGENT !== "1" ||
    process.env.CATAMORPHIC_E2E_REVIEW !== "1"
  )
    return null;
  const paths = [
    "src/guard.ts",
    ...Array.from(
      { length: 240 },
      (_, index) =>
        `src/modules/group-${String(index).padStart(3, "0")}/index.ts`,
    ),
  ];
  return {
    postComment: (input: PrCommentInput) => {
      const comment: PrComment = {
        id: 1000 + postedComments.length,
        body: input.body,
        author: { login: "reviewer" },
        createdAt: new Date().toISOString(),
        ...(input.replyTo
          ? { replyToId: input.replyTo, path: "src/guard.ts", line: 1 }
          : {}),
      };
      postedComments.push(comment);
      return comment;
    },
    prs: [
      {
        number: 7,
        title: "Validate input before processing",
        author: "reviewer",
        viewerLogin: "reviewer",
        head: "input-guard",
        base: "main",
        draft: false,
        body: "Reject empty input before processing.\n\n<details><summary>Verification</summary>Review the guard and its callers.</details>",
        url: "https://github.com/example/repository/pull/7",
        requestedReviewers: ["reviewer"],
      },
    ],
    files: paths.map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch:
        "@@ -1 +1 @@\n-export const valid = true;\n+export const valid = input.length > 0;",
    })),
    details: prDetailsSchema.parse({
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      assignees: [{ login: "owner" }],
      reviewRequests: [{ login: "reviewer" }],
      reviews: [],
      comments: [
        ...postedComments.filter((comment) => !comment.replyToId),
        {
          id: 1,
          author: { login: "build-bot" },
          body: `Build report\n\n${"Additional diagnostics.\n\n".repeat(80)}`,
        },
      ],
      statusCheckRollup: [
        {
          name: "Unit tests",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/example/repository/actions/runs/1",
        },
      ],
      inlineComments: [
        ...postedComments.filter((comment) => comment.replyToId),
        {
          id: 10,
          path: "src/guard.ts",
          line: 1,
          author: { login: "reviewer" },
          body: "What happens for empty input?",
          diffHunk:
            "@@ -1 +1 @@\n-export const valid = true;\n+export const valid = input.length > 0;",
          side: "RIGHT",
        },
        {
          id: 11,
          replyToId: 10,
          path: "src/guard.ts",
          line: 1,
          author: { login: "owner" },
          body: "The guard rejects it.",
        },
      ],
    }),
  };
}
