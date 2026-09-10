import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { prDetailsSchema } from "../../shared/pr-details.js";
import {
  discussionThreads,
  latestReviews,
  orderedChecks,
  ReviewDiscussion,
  ReviewMarkdown,
  ReviewMetadata,
} from "./review-metadata.js";

it("renders GitHub details and tables while stripping scripts and HTML comments", () => {
  const html = renderToStaticMarkup(
    <ReviewMarkdown
      body={
        "<!-- hidden -->\n<details><summary>Details</summary>Useful text</details>\n<script>alert(1)</script>\n\n| Name | State |\n| --- | --- |\n| Build | Pass |"
      }
    />,
  );
  expect(html).toContain("<details>");
  expect(html).toContain("<summary>Details</summary>");
  expect(html).toContain("<table>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("alert(1)");
  expect(html).not.toContain("hidden");
});

it("shows checks, people, review decisions, and inline comment context", () => {
  const details = prDetailsSchema.parse({
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    assignees: [{ login: "owner" }],
    reviewRequests: [{ name: "Review team" }],
    reviews: [
      {
        id: "r1",
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please fix this.",
      },
    ],
    statusCheckRollup: [
      {
        name: "Unit tests",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/test/check",
      },
    ],
    inlineComments: [
      {
        id: 1,
        body: "Missing guard",
        author: { login: "reviewer" },
        path: "src/app.ts",
        line: 42,
      },
    ],
  });
  const metadata = renderToStaticMarkup(<ReviewMetadata details={details} />);
  expect(metadata).toContain("Unit tests");
  expect(metadata).toContain("failure");
  expect(metadata).toContain("Review team");
  expect(metadata).toContain("owner");
  const discussion = renderToStaticMarkup(
    <ReviewDiscussion details={details} />,
  );
  expect(discussion).toContain("Missing guard");
  expect(discussion).toContain("src/app.ts:42");
  expect(discussion).toContain("Please fix this.");
});

it("keeps replies with their inline thread and preserves orphaned replies", () => {
  const details = prDetailsSchema.parse({
    state: "OPEN",
    inlineComments: [
      { id: 2, replyToId: 1, body: "Fixed", createdAt: "2026-09-10T11:00:00Z" },
      {
        id: 1,
        body: "Missing guard",
        path: "src/app.ts",
        line: null,
        createdAt: "2026-09-10T10:00:00Z",
      },
      { id: 3, replyToId: 999, body: "Parent unavailable" },
    ],
  });
  const threads = discussionThreads(details);
  expect(threads).toHaveLength(2);
  expect(
    threads
      .find((thread) => thread.comment.id === 1)
      ?.replies.map((reply) => reply.body),
  ).toEqual(["Fixed"]);
  expect(threads.some((thread) => thread.comment.id === 3)).toBe(true);
  const html = renderToStaticMarkup(<ReviewDiscussion details={details} />);
  expect(html).toContain("outdated");
  expect(html).toContain("Parent unavailable");
});

it("summarizes each reviewer once using the latest dated review without discarding history", () => {
  const details = prDetailsSchema.parse({
    state: "OPEN",
    reviews: [
      {
        id: "new",
        author: { login: "Bot" },
        submittedAt: "2026-09-10T12:00:00Z",
        state: "APPROVED",
        body: "Looks good",
      },
      {
        id: "old",
        author: { login: "bot" },
        submittedAt: "2026-09-09T12:00:00Z",
        state: "COMMENTED",
        body: "Earlier feedback",
      },
      { id: "human", author: { login: "reviewer" }, state: "COMMENTED" },
    ],
  });
  expect(latestReviews(details.reviews).map((review) => review.id)).toEqual([
    "new",
    "human",
  ]);
  expect(details.reviews).toHaveLength(3);
  expect(discussionThreads(details)).toHaveLength(2);
});

it("puts failing and unfinished checks ahead of successful runs without merging matrix jobs", () => {
  const details = prDetailsSchema.parse({
    state: "OPEN",
    statusCheckRollup: [
      {
        name: "Tests",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/test/1",
      },
      { name: "Deploy", status: "IN_PROGRESS", conclusion: null },
      {
        name: "Tests",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/test/2",
      },
    ],
  });
  expect(
    orderedChecks(details).map((check) => check.conclusion || check.status),
  ).toEqual(["FAILURE", "IN_PROGRESS", "SUCCESS"]);
  expect(details.statusCheckRollup?.[0]?.conclusion).toBe("SUCCESS");
});
