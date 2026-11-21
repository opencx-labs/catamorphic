import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { z } from "zod";
import type { Identity } from "../../identity.js";
import {
  type AgentCapability,
  defineAgentCapability,
} from "../agent-capabilities-service.js";

/** The one name of the pull request tool, the same on every host. */
export const PULL_REQUEST_TOOL_NAME = "create_pull_request";

/** What a chat's pull request tool returns (ADR 0343). */
export interface ChatPullRequest {
  url: string;
  number: number;
  /** The branch in the repository the pull request is for. */
  branch: string;
  /** The commit pushed: the tip of the chat's branch. */
  commit: string;
  base: string;
  /** False when the pull request was already open and its branch moved. */
  created: boolean;
  /** Files with changes that are not committed, so were not pushed. */
  uncommitted: string[];
  note: string;
}

/** What an agent asks of the pull request tool. */
export interface PullRequestRequest {
  projectId: string;
  sessionId: string;
  title: string;
  body?: string;
}

const parameters = {
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("A concise, imperative summary of the change"),
  body: z
    .string()
    .max(60000)
    .optional()
    .describe("Markdown: what changed and why"),
};

const DESCRIPTION =
  "Open a pull request for the commits on this chat's branch, or update the one it already opened. Work pushes the branch to the project's repository as this chat's own branch under work/ and opens the pull request against the branch the chat started from. Commit first: only commits are pushed, and the result names the files left uncommitted. Call it again after more commits to update the same pull request; after a rebase it replaces this chat's branch, and refuses if anyone else pushed there. The pull request is recorded on the chat by itself. Returns its URL; share it with the person.";

/** What the agent is told with a pull request: what was and was not pushed. */
export function pullRequestNote(input: {
  created: boolean;
  uncommitted: readonly string[];
}): string {
  const opened = input.created
    ? "Opened, and recorded on this chat."
    : "Already open: its branch now holds your latest commits.";
  if (input.uncommitted.length === 0) return opened;
  const shown = input.uncommitted.slice(0, 20).join(", ");
  const more = input.uncommitted.length - 20;
  return `${opened} Not pushed, because not committed: ${shown}${more > 0 ? ` and ${more} more` : ""}. Commit them and call this again to add them.`;
}

function chatOf(context: ExtraToolContext): {
  projectId: string;
  sessionId: string;
} {
  if (!context.sessionId) throw new Error("This turn has no chat session.");
  return { projectId: context.projectId, sessionId: context.sessionId };
}

/**
 * The pull request tool (ADR 0343): one definition, which a host builds
 * over how it reaches a chat's checkout. The desktop serves it beside its
 * workspace tools; a server serves it through capability discovery
 * ({@link pullRequestCapability}).
 */
export function pullRequestTool(
  create: (
    request: PullRequestRequest,
    context: ExtraToolContext,
  ) => Promise<ChatPullRequest>,
): ExtraTool {
  return {
    name: PULL_REQUEST_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    execute: async (input, context) => {
      const { title, body } = z.object(parameters).parse(input);
      return create(
        { ...chatOf(context), title, ...(body !== undefined ? { body } : {}) },
        context,
      );
    },
  };
}

/**
 * The same tool as a capability an agent discovers: `project.` and its
 * name, for the session's caller. An agent whose changes never leave its
 * sandbox (ADR 0182) may not call it.
 */
export function pullRequestCapability(
  create: (
    request: PullRequestRequest & { identity: Identity },
  ) => Promise<ChatPullRequest>,
): AgentCapability {
  return defineAgentCapability({
    revision: "1",
    name: `project.${PULL_REQUEST_TOOL_NAME}`,
    description: DESCRIPTION,
    effect: "write",
    sandboxing: "propose",
    inputSchema: z.object(parameters).strict(),
    outputSchema: z.unknown(),
    authorize: () => true,
    execute: async (invocation, input) => {
      invocation.signal?.throwIfAborted();
      const opened = await create({
        identity: invocation.identity,
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      return JSON.parse(JSON.stringify(opened));
    },
  });
}
