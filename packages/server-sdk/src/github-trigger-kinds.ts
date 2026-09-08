import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

const projectEventFields = {
  id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  projectId: z.string().uuid(),
  source: z.literal("github"),
  externalId: z.string(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  payload: z.json(),
};

function githubProjectEventKind<const Name extends `github.${string}`>(args: {
  name: Name;
  label: string;
  description: string;
}) {
  return defineTriggerKind({
    name: args.name,
    description: args.description,
    display: { label: args.label, icon: "github", color: "#24292f" },
    payload: z.object({
      ...projectEventFields,
      kind: z.literal(args.name),
    }),
    correlationKey: (event) => event.id,
  });
}

export const githubPullRequest = githubProjectEventKind({
  name: "github.pull_request",
  label: "GitHub Pull Request",
  description: "A linked GitHub pull request changed",
});

export const githubPullRequestReview = githubProjectEventKind({
  name: "github.pull_request_review",
  label: "GitHub PR Review",
  description: "A review on a linked GitHub pull request changed",
});

export const githubCheckRun = githubProjectEventKind({
  name: "github.check_run",
  label: "GitHub Check Run",
  description: "A check run for a linked GitHub repository changed",
});

export const githubCheckSuite = githubProjectEventKind({
  name: "github.check_suite",
  label: "GitHub Check Suite",
  description: "A check suite for a linked GitHub repository changed",
});

export const githubWorkflowRun = githubProjectEventKind({
  name: "github.workflow_run",
  label: "GitHub Workflow Run",
  description: "A GitHub Actions workflow run changed",
});

export const GITHUB_PROJECT_EVENT_TRIGGER_KINDS = [
  githubPullRequest,
  githubPullRequestReview,
  githubCheckRun,
  githubCheckSuite,
  githubWorkflowRun,
] as const;
