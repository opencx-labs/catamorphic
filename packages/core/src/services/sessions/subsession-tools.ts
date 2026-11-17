import type {
  AgentEffort,
  ExtraTool,
  ExtraToolContext,
} from "@catamorphic/sandbox";
import { z } from "zod";

/**
 * Where a subsession works (ADR 0322): in its parent's workspace (the same
 * sandbox or checkout, as it stands), or in one of its own started at the
 * parent's base.
 */
export const SUBSESSION_WORKSPACES = ["shared", "own"] as const;
export type SubsessionWorkspace = (typeof SUBSESSION_WORKSPACES)[number];

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** What a parent asks for when it starts a subsession (ADRs 0271, 0322). */
export interface SubsessionRequest {
  task: string;
  agentId?: string;
  model?: string;
  effort?: AgentEffort;
  readOnly?: boolean;
  delegate?: boolean;
  workspace?: SubsessionWorkspace;
  contextMode?: "fresh" | "inherit";
  title?: string;
}

/** How a host's subsession tools reach its sessions. */
export interface SubsessionOperations {
  spawn(input: {
    projectId: string;
    sessionId: string;
    request: SubsessionRequest;
  }): Promise<unknown>;
  waitFor(input: {
    projectId: string;
    sessionId: string;
    sessionIds?: string[];
    timeoutMs: number;
    stopWaiting: AbortSignal;
  }): Promise<unknown[]>;
  interrupt(input: {
    projectId: string;
    sessionId: string;
    childSessionId: string;
  }): Promise<void>;
}

/** The names of the subsession tools, the same on every host. */
export const SUBSESSION_TOOL_NAMES = [
  "spawn_subsession",
  "wait_for_subsessions",
  "interrupt_subsession",
] as const;

function chatOf(context: ExtraToolContext): {
  projectId: string;
  sessionId: string;
} {
  if (!context.sessionId) throw new Error("This turn has no chat session.");
  return { projectId: context.projectId, sessionId: context.sessionId };
}

/**
 * The subsession tools (ADRs 0090, 0202, 0271, 0322): one definition, which
 * core serves to agents whose host serves none of them and a host may
 * build over its own operations.
 */
export function subsessionTools(operations: SubsessionOperations): ExtraTool[] {
  return [
    {
      name: "spawn_subsession",
      description:
        "Start a subagent: a child session that works on one bounded, self-contained task in parallel with you. Whom you may start, and the model and effort you may set, are listed in your instructions. Use it wherever you would use a subagent or Task tool (parallel research, independent reviews, exploration). It works in your workspace, on your files, unless workspace is own. Returns at once; its result arrives in this chat as a message from it, during your turn if you are still working.",
      parameters: {
        task: z
          .string()
          .min(1)
          .describe(
            "The whole task: the child sees nothing else unless inherit",
          ),
        agent: z
          .string()
          .min(1)
          .optional()
          .describe(
            "An agent id from your instructions' list; leave out for a copy of yourself",
          ),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(
            "As its harness names it, like opus; left out, a copy keeps this chat's, another agent its own",
          ),
        effort: effortSchema
          .optional()
          .describe("How hard it thinks; left out like model"),
        read_only: z
          .boolean()
          .optional()
          .describe(
            "Runs it in its harness's read-only mode, with only Work's read-only tools",
          ),
        delegate: z
          .boolean()
          .optional()
          .describe("false: it starts no subagents of its own"),
        workspace: z
          .enum(SUBSESSION_WORKSPACES)
          .default("shared")
          .describe("own: a workspace of its own, for parallel writers"),
        context_mode: z.enum(["fresh", "inherit"]).default("fresh"),
        title: z.string().min(1).max(500).optional(),
      },
      execute: async (input, context) => {
        const child = await operations.spawn({
          ...chatOf(context),
          request: {
            task: String(input.task),
            ...(input.agent ? { agentId: String(input.agent) } : {}),
            ...(input.model ? { model: String(input.model) } : {}),
            ...(input.effort
              ? { effort: effortSchema.parse(input.effort) }
              : {}),
            ...(input.read_only === true ? { readOnly: true } : {}),
            ...(input.delegate === false ? { delegate: false } : {}),
            workspace: z
              .enum(SUBSESSION_WORKSPACES)
              .parse(input.workspace ?? "shared"),
            contextMode: input.context_mode === "inherit" ? "inherit" : "fresh",
            ...(input.title ? { title: String(input.title) } : {}),
          },
        });
        return {
          ...subsessionSummary(child),
          note: "Running. Its result arrives in this chat as a message from it.",
        };
      },
    },
    {
      name: "wait_for_subsessions",
      description:
        "Wait until one of your running subsessions (or those given) finishes, or the timeout; call again to keep waiting. Each finished one's result arrives as a message in this chat.",
      readOnly: true,
      parameters: {
        session_ids: z.array(z.string().min(1)).max(100).optional(),
        timeout_ms: z.number().int().min(0).max(60_000).default(60_000),
      },
      execute: async (input, context) => {
        const children = await operations.waitFor({
          ...chatOf(context),
          ...(Array.isArray(input.session_ids)
            ? { sessionIds: input.session_ids.map(String) }
            : {}),
          timeoutMs: Number(input.timeout_ms ?? 60_000),
          stopWaiting: context.stopWaiting,
        });
        return children.length > 0
          ? children.map(subsessionSummary)
          : {
              subsessions: [],
              note: "None of your subsessions is running; finished ones already sent their results to this chat.",
            };
      },
    },
    {
      name: "interrupt_subsession",
      description:
        "Stop a direct child session that this session spawned. Its delegation is marked interrupted.",
      parameters: {
        session_id: z.string().min(1).describe("Child session id"),
      },
      execute: async (input, context) => {
        await operations.interrupt({
          ...chatOf(context),
          childSessionId: String(input.session_id),
        });
        return { ok: true };
      },
    },
  ];
}

/** A child as its parent reads it: what runs it, how, and where (ADR 0271). */
export function subsessionSummary(child: unknown): Record<string, unknown> {
  const parsed = z
    .object({
      status: z.string(),
      workspace: z.enum(SUBSESSION_WORKSPACES).optional(),
      session: z.object({
        id: z.string(),
        title: z.string().nullable(),
        agentId: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        modelEffort: z.string().nullable().optional(),
        readOnly: z.boolean().optional(),
      }),
    })
    .safeParse(child);
  if (!parsed.success) return { subsession: child };
  const { session } = parsed.data;
  return {
    sessionId: session.id,
    title: session.title,
    status: parsed.data.status,
    ...(parsed.data.workspace ? { workspace: parsed.data.workspace } : {}),
    ...(session.agentId ? { agent: session.agentId } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.modelEffort ? { effort: session.modelEffort } : {}),
    ...(session.readOnly ? { readOnly: true } : {}),
  };
}
