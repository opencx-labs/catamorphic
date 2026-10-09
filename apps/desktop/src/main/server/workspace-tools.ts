import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { z } from "zod";
import {
  CHAT_ICON_COLOR_IDS,
  CHAT_ICON_NAMES,
} from "../../shared/chat-icons.js";
import { parseSurfaceLink } from "../../shared/surface-link.js";
import type { TurnHolder, WorkspaceBridge } from "../agent-bridge.js";

/**
 * The agent's workspace toolset: discovery (what tabs, chats, and sidebar
 * items the user has open), expansion (read any tab's content), and real
 * surfaces — browser tabs and terminals the agent opens inside the user's
 * app window, watchable live and subject to the take-over handoff.
 *
 * These are harness-neutral {@link ExtraTool}s: the ai-sdk harness mounts
 * them beside its built-ins, Claude Code gets them as an in-process MCP
 * server. Everything ultimately lands on the {@link WorkspaceBridge}.
 */

/** Chat transcripts live server-side; the bridge only maps tab → session. */
export type ChatTranscriptReader = (
  projectId: string,
  sessionId: string,
) => Promise<{
  title: string | null;
  messages: Array<{ role: string; content: string }>;
} | null>;

/** Writes a session's icon; wired to the chat store after boot. */
export type ChatIconSetter = (
  projectId: string,
  sessionId: string,
  icon: string,
) => Promise<void>;

/** Builds (and optionally publishes) a project app; wired after boot. */
export type AppBuilder = (
  projectId: string,
  appName: string,
  publish: boolean,
) => Promise<{
  status: "published" | "preview_ready" | "failed";
  versionId?: string;
  error?: string;
}>;

/**
 * Reads a skill's SKILL.md by declared name — project tier (repo files),
 * the user's personal tier (ADR 0056), and host tier (ADR 0049) alike;
 * wired to core's SkillsService after boot.
 */
export type SkillReader = (
  projectId: string,
  name: string,
) => Promise<{
  name: string;
  source: "project" | "user" | "host";
  path: string;
  content: string;
} | null>;

/** Desktop-local privacy decision for chat discovery and transcript reads. */
export type SessionVisibility = (
  projectId: string,
  sessionId: string,
) => Promise<boolean>;

/** Remote-sync + pull-request operations; wired to core after boot (ADR 0044). */
export interface GitBridge {
  sync(
    projectId: string,
    sessionId: string,
  ): Promise<{
    status: string;
    branch?: string | null;
    rescueBranch?: string;
    note?: string;
  }>;
  createPullRequest(
    projectId: string,
    sessionId: string,
    input: { title: string; body?: string },
  ): Promise<{ url: string; number: number; branch: string }>;
}

export interface SessionCoordinationBridge {
  list(projectId: string, sessionId: string): Promise<unknown[]>;
  read(
    projectId: string,
    ownSessionId: string,
    peerSessionId: string,
  ): Promise<{
    title: string | null;
    messages: Array<{ role: string; content: string }>;
  } | null>;
  send(
    projectId: string,
    ownSessionId: string,
    peerSessionId: string,
    content: string,
    mode: "message_only" | "queue" | "interrupt",
  ): Promise<unknown>;
  spawn(
    projectId: string,
    sessionId: string,
    input: {
      routeId?: string;
      agentId?: string;
      task: string;
      contextMode?: "fresh" | "inherit";
      title?: string;
    },
  ): Promise<unknown>;
  listSubsessions(projectId: string, sessionId: string): Promise<unknown[]>;
  waitForSubsessions(
    projectId: string,
    sessionId: string,
    input: { sessionIds?: string[]; timeoutMs?: number },
  ): Promise<unknown[]>;
  interruptSubsession(
    projectId: string,
    sessionId: string,
    childSessionId: string,
  ): Promise<void>;
  requestAttention(projectId: string, sessionId: string): Promise<unknown>;
  setActivity(
    projectId: string,
    sessionId: string,
    activity: string | null,
  ): Promise<void>;
}

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export interface AgentTodoItem {
  id: string;
  title: string;
  description: string;
  status: AgentTodoStatus;
}

export interface TodoListBridge {
  read(projectId: string, sessionId: string): Promise<AgentTodoItem[]>;
  replace(
    projectId: string,
    sessionId: string,
    items: Array<{
      id?: string;
      title: string;
      description: string;
      status: AgentTodoStatus;
      activeForm?: string;
    }>,
  ): Promise<AgentTodoItem[]>;
}

export interface CheckoutBridge {
  current(projectId: string, sessionId: string): Promise<unknown>;
  list(projectId: string): Promise<unknown[]>;
  create(
    projectId: string,
    sessionId: string,
  ): Promise<{ path: string; kind?: string; branch?: string | null }>;
  use(
    projectId: string,
    sessionId: string,
    checkoutPath: string,
  ): Promise<{ path: string; kind?: string; branch?: string | null }>;
  returnToPrimary(
    projectId: string,
    sessionId: string,
  ): Promise<{ path: string; kind?: string; branch?: string | null }>;
}

export interface WorkspaceTool extends ExtraTool {
  effect: "read" | "write";
  readOnly: boolean;
  nativeOnly: boolean;
  eager: boolean;
}

export interface WorkspaceToolkit {
  tools: WorkspaceTool[];
  /** Late-bound: the chat store exists only after the server boots. */
  setChatTranscriptReader(reader: ChatTranscriptReader): void;
  /** Late-bound for the same reason. */
  setChatIconSetter(setter: ChatIconSetter): void;
  /** Late-bound: the apps service exists only after the server boots. */
  setAppBuilder(builder: AppBuilder): void;
  /** Late-bound: remote sync lives in core, which exists only after boot. */
  setGitBridge(git: GitBridge): void;
  /** Late-bound: skills live in core, which exists only after boot. */
  setSkillReader(reader: SkillReader): void;
  setSessionCoordinationBridge(bridge: SessionCoordinationBridge): void;
  setTodoListBridge(bridge: TodoListBridge): void;
  setCheckoutBridge(bridge: CheckoutBridge): void;
  setSessionVisibility(visibility: SessionVisibility): void;
}

const TRANSCRIPT_MESSAGE_CAP = 40;
const TRANSCRIPT_CHARS_CAP = 24_000;

type WorkspaceToolPolicy = Pick<
  WorkspaceTool,
  "effect" | "readOnly" | "nativeOnly" | "eager"
>;
const read: WorkspaceToolPolicy = {
  effect: "read",
  readOnly: true,
  nativeOnly: false,
  eager: false,
};
const write: WorkspaceToolPolicy = {
  effect: "write",
  readOnly: false,
  nativeOnly: false,
  eager: false,
};
const presentation: WorkspaceToolPolicy = { ...write, readOnly: true };
const checkout: WorkspaceToolPolicy = { ...write, nativeOnly: true };

/** Every operation declares policy. Missing declarations fail toolkit creation. */
export const WORKSPACE_TOOL_POLICY: Readonly<
  Record<string, WorkspaceToolPolicy>
> = {
  list_project_sessions: read,
  read_project_session: read,
  send_project_session_message: write,
  // Subsessions are the agent's subagents (ADR 0202): a model that cannot
  // see them by name concludes it cannot delegate.
  spawn_subsession: { ...write, eager: true },
  wait_for_subsessions: { ...read, eager: true },
  interrupt_subsession: write,
  request_user_attention: presentation,
  set_session_activity: presentation,
  read_todo_list: read,
  update_todo_list: { ...presentation, eager: true },
  list_worktrees: { ...read, nativeOnly: true },
  create_worktree: checkout,
  use_worktree: checkout,
  build_app: write,
  open_surface: { ...presentation, eager: true },
  point_at: presentation,
  set_chat_icon: presentation,
  workspace_overview: { ...read, eager: true },
  // What is on screen is the most common workspace question (ADR 0152).
  read_tab: { ...read, eager: true },
  // Driving Work's browser is a core interaction (ADR 0202): behind
  // discovery, models concluded the browser could only read and navigate.
  open_browser: { ...presentation, eager: true },
  browser_snapshot: { ...read, eager: true },
  browser_act: { ...write, eager: true },
  // Long-running work is a core execution need for every harness (ADR 0155).
  run_background_command: { ...write, eager: true },
  read_background_output: { ...read, eager: true },
  stop_background_command: { ...write, eager: true },
  watch_command: { ...write, eager: true },
  write_terminal: write,
  sync_project: write,
  create_pull_request: write,
  request_connection: write,
  read_skill: read,
  desktop_settings: read,
  surface_control: write,
};

export function buildWorkspaceToolkit(
  bridge: WorkspaceBridge,
  host: {
    /** Work's settings files and their state for one project's profile. */
    desktopSettings?: (projectId: string) => unknown;
  } = {},
): WorkspaceToolkit {
  let readChatTranscript: ChatTranscriptReader | null = null;
  let setChatIcon: ChatIconSetter | null = null;
  let buildApp: AppBuilder | null = null;
  let gitBridge: GitBridge | null = null;
  let readSkill: SkillReader | null = null;
  let sessionCoordination: SessionCoordinationBridge | null = null;
  let todoList: TodoListBridge | null = null;
  let checkouts: CheckoutBridge | null = null;
  let sessionVisible: SessionVisibility = async () => true;

  const definitions: ExtraTool[] = [
    {
      name: "list_project_sessions",
      description:
        "List other agent sessions in this project, including subsessions and archived sessions, with their hierarchy, visibility, task, running state and checkout.",
      parameters: {
        children_only: z
          .boolean()
          .optional()
          .describe("Only this session's direct children"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        return input.children_only
          ? sessionCoordination.listSubsessions(ctx.projectId, ctx.sessionId)
          : sessionCoordination.list(ctx.projectId, ctx.sessionId);
      },
    },
    {
      name: "read_project_session",
      description:
        "Read a recent, bounded transcript from another session in this project, including an archived session. Use it when the summary is not enough to understand its work.",
      parameters: {
        session_id: z.string().min(1).describe("Peer session id"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        const transcript = await sessionCoordination.read(
          ctx.projectId,
          ctx.sessionId,
          String(input.session_id),
        );
        if (!transcript)
          throw new Error("That project session is not visible.");
        return boundedTranscript(transcript);
      },
    },
    {
      name: "send_project_session_message",
      description:
        "Send a message to another session in this project. Use message_only for context that should not start work, queue to queue work, or interrupt only when the other agent must change course immediately.",
      parameters: {
        session_id: z.string().min(1).describe("Target session id"),
        message: z.string().min(1).describe("Message to send"),
        delivery_mode: z
          .enum(["message_only", "queue", "interrupt"])
          .default("message_only"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        return sessionCoordination.send(
          ctx.projectId,
          ctx.sessionId,
          String(input.session_id),
          String(input.message),
          input.delivery_mode as "message_only" | "queue" | "interrupt",
        );
      },
    },
    {
      name: "spawn_subsession",
      description:
        "Start a subagent: a child session that works on one bounded, self-contained task in parallel with you, through an allowed delegation route. Use it wherever you would use a subagent or Task tool (parallel research, independent reviews, exploration). Returns at once; its result arrives in this chat as a message from it, during your turn if you are still working.",
      parameters: {
        task: z
          .string()
          .min(1)
          .describe(
            "The whole task: the child sees nothing else unless inherit",
          ),
        route_id: z.string().min(1).optional().describe("Allowed route id"),
        agent_id: z
          .string()
          .min(1)
          .optional()
          .describe("Agent choice when the route allows it"),
        context_mode: z.enum(["fresh", "inherit"]).default("fresh"),
        title: z.string().min(1).max(500).optional(),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        const child = await sessionCoordination.spawn(
          ctx.projectId,
          ctx.sessionId,
          {
            task: String(input.task),
            ...(input.route_id ? { routeId: String(input.route_id) } : {}),
            ...(input.agent_id ? { agentId: String(input.agent_id) } : {}),
            contextMode: input.context_mode as "fresh" | "inherit",
            ...(input.title ? { title: String(input.title) } : {}),
          },
        );
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
      parameters: {
        session_ids: z.array(z.string().min(1)).max(100).optional(),
        timeout_ms: z.number().int().min(0).max(60_000).default(60_000),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        const children = await sessionCoordination.waitForSubsessions(
          ctx.projectId,
          ctx.sessionId,
          {
            ...(input.session_ids
              ? { sessionIds: input.session_ids as string[] }
              : {}),
            timeoutMs: Number(input.timeout_ms),
          },
        );
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
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        await sessionCoordination.interruptSubsession(
          ctx.projectId,
          ctx.sessionId,
          String(input.session_id),
        );
        return { ok: true };
      },
    },
    {
      name: "request_user_attention",
      description:
        "Promote this session into the user's sidebar and mark it as needing attention. Use only for a result or decision the user should see, such as a merged pull request or required input.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        return sessionCoordination.requestAttention(
          ctx.projectId,
          ctx.sessionId,
        );
      },
    },
    {
      name: "set_session_activity",
      description:
        "Publish a short description of the files or work you are actively handling so other agents in this project can coordinate. Clear it when the activity no longer applies.",
      parameters: {
        activity: z
          .string()
          .max(500)
          .nullable()
          .describe("Short current activity, or null to clear it"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!sessionCoordination) {
          throw new Error("Session coordination is not available yet.");
        }
        await sessionCoordination.setActivity(
          ctx.projectId,
          ctx.sessionId,
          typeof input.activity === "string" ? input.activity : null,
        );
        return { ok: true };
      },
    },
    {
      name: "read_todo_list",
      description:
        "Read this chat's current agent-owned todo list. Use this before changing an existing list when its latest item ids or state are not already in your context.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!todoList) throw new Error("Todo lists are not available yet.");
        return { items: await todoList.read(ctx.projectId, ctx.sessionId) };
      },
    },
    {
      name: "update_todo_list",
      description:
        "Replace this chat's complete todo list so the user can track progress. Use it for multi-step work, update it as steps progress, and clear it with an empty items array when no list is useful. Every item needs a short action title, a detailed description with important task specifics, and a status. Echo an existing item's id when editing, completing, reordering, or retaining it; omit id only for a new item. Omitting an existing item removes it. Give the in-progress item an activeForm; the person sees it as what you are doing.",
      parameters: {
        items: todoInputSchema.describe(
          "The complete desired todo list, in display order",
        ),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!todoList) throw new Error("Todo lists are not available yet.");
        const items = todoInputSchema.parse(input.items);
        const updated = await todoList.replace(
          ctx.projectId,
          ctx.sessionId,
          items,
        );
        return {
          items: updated,
          completed: updated.filter((item) => item.status === "completed")
            .length,
          total: updated.length,
        };
      },
    },
    {
      name: "list_worktrees",
      description:
        "List Git worktrees already registered for this project and show the checkout currently assigned to this session.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!checkouts)
          throw new Error("Worktree management is not available.");
        return {
          current: await checkouts.current(ctx.projectId, ctx.sessionId),
          worktrees: await checkouts.list(ctx.projectId),
        };
      },
    },
    {
      name: "create_worktree",
      description:
        "Create or reuse this session's managed Git worktree when independent repository state is needed. Ordinary document edits, private files, and proposals stay in the project folder unless the user or coordination policy requires isolation.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!checkouts)
          throw new Error("Worktree management is not available.");
        const checkout = await checkouts.create(ctx.projectId, ctx.sessionId);
        ctx.workingDirectory = checkout.path;
        return checkoutResult(checkout);
      },
    },
    {
      name: "use_worktree",
      description:
        "Assign this session to an existing Git worktree created by Work or another harness. The path must belong to this project's Git repository.",
      parameters: {
        path: z
          .string()
          .min(1)
          .nullable()
          .describe(
            "Absolute worktree path, or null for the primary project checkout",
          ),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!checkouts)
          throw new Error("Worktree management is not available.");
        const checkout =
          input.path === null
            ? await checkouts.returnToPrimary(ctx.projectId, ctx.sessionId)
            : await checkouts.use(
                ctx.projectId,
                ctx.sessionId,
                String(input.path),
              );
        ctx.workingDirectory = checkout.path;
        return checkoutResult(checkout);
      },
    },
    {
      name: "build_app",
      description:
        "Build a project app preview from .work/apps/<name>/. Set publish: true only when publication is requested. Preview is the default and can be opened with open_surface target app:<name>. Load building-apps for authoring.",
      parameters: {
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .describe("The app's directory name under .work/apps/"),
        publish: z
          .boolean()
          .optional()
          .describe("Publish after building (default false)"),
      },
      execute: async (input, ctx) => {
        if (!buildApp) throw new Error("App building is not available yet.");
        const result = await buildApp(
          ctx.projectId,
          String(input.name),
          input.publish === true,
        );
        if (result.status === "failed") {
          throw new Error(result.error ?? "App build failed");
        }
        return {
          ...result,
          note:
            result.status === "published"
              ? `Published. Open it for the user with open_surface target "app:${input.name}".`
              : `Preview compiled — the user's app tab shows this build (open_surface target "app:${input.name}"); the published version is unchanged.`,
        };
      },
    },
    {
      name: "open_surface",
      description:
        "Show a tab, app:<name>, workflow:<exportName>, file:<path>, or web URL. The result reports focused or background opening; tell the user where it is if they did not see it. Load desktop-workspace for interaction guidance.",
      parameters: {
        target: z
          .string()
          .describe(
            "Tab key, 'app:<name>', 'workflow:<exportName>', 'file:<path>', or an http(s) URL",
          ),
      },
      execute: async (input, ctx) => {
        const target = String(input.target);
        const link = parseSurfaceLink(target);
        if (
          link?.kind === "file" &&
          (ctx.workingDirectory || path.isAbsolute(link.path))
        ) {
          const filePath = path.resolve(ctx.workingDirectory ?? "", link.path);
          if ((await stat(filePath)).isDirectory()) {
            throw new Error(
              "This path is a directory. Open a file inside it or use workflow:<exportName> for a workflow graph.",
            );
          }
        }
        const result = await bridge.openTarget(
          ctx.projectId,
          ctx.sessionId ?? "",
          target,
        );
        return result;
      },
    },
    {
      name: "point_at",
      description:
        "Point the user's attention at a UI element with a subtle glow and scroll it into view. The glow stays until the user interacts with that element or you point at something else (pass keep_previous to stack pointers instead of replacing them). For an element inside a browser page, pass its browser tab key as target and its snapshot uid. Targets: a workspace tab key from workspace_overview (glows that tab), 'app:<name>', 'sidebar:<item label>' (glows that sidebar entry), or 'chip:<surface key>' (glows that surface's chip on your own chat, e.g. 'chip:terminal:<id>'). Pass target: null to clear highlighting.",
      parameters: {
        target: z
          .string()
          .nullable()
          .describe(
            "Tab key, 'app:<name>', 'sidebar:<item label>', or 'chip:<surface key>'",
          ),
        uid: z
          .string()
          .optional()
          .describe(
            "Element reference from browser_snapshot, for pointing inside a page",
          ),
        note: z
          .string()
          .optional()
          .describe("Short label shown beside the glow (a few words)"),
        keep_previous: z
          .boolean()
          .optional()
          .describe("Keep earlier pointers glowing too (default false)"),
      },
      execute: async (input, ctx) => {
        if (input.target === null) {
          await bridge.clearPointers(ctx.projectId);
          return { ok: true };
        }
        const result = await bridge.pointAt(
          ctx.projectId,
          String(input.target),
          typeof input.note === "string" ? input.note : undefined,
          input.keep_previous === true,
          typeof input.uid === "string" ? input.uid : undefined,
        );
        if (!result.ok) {
          throw new Error(result.error ?? "Could not find that element.");
        }
        return { ok: true };
      },
    },
    {
      name: "set_chat_icon",
      description: `Set this conversation's icon, shown on its tab, bubble, and sidebar entry (like picking a team icon in Linear). Optional: choose an icon and color when useful or requested. Icons: ${CHAT_ICON_NAMES.join(", ")}. Colors: ${CHAT_ICON_COLOR_IDS.join(", ")}.`,
      parameters: {
        icon: z
          .enum(CHAT_ICON_NAMES)
          .describe("Icon name from the allowed set"),
        color: z
          .enum(CHAT_ICON_COLOR_IDS as [string, ...string[]])
          .describe("Color name from the allowed set"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) {
          throw new Error("This turn has no chat session to set an icon on.");
        }
        if (!setChatIcon) throw new Error("Chat store not ready yet.");
        await setChatIcon(
          ctx.projectId,
          ctx.sessionId,
          `${String(input.icon)}:${String(input.color)}`,
        );
        return { ok: true, icon: `${input.icon}:${input.color}` };
      },
    },
    {
      name: "workspace_overview",
      description:
        "See the user's live workspace: every open tab (browser pages, terminals, editors, chats) with keys and titles, which tab is active (what the user is looking at right now), the focused editor's current text selection if any, other chat conversations, and the sidebar's configured shortcuts. Start here whenever the user refers to something they can see, another conversation, 'this'/'the selected text', or 'that page/terminal'. Expand any entry with read_tab.",
      parameters: {},
      execute: async (_input, ctx) =>
        filterWorkspaceOverview(
          await bridge.overview(ctx.projectId),
          ctx.projectId,
          sessionVisible,
        ),
    },
    {
      name: "read_tab",
      description:
        "Expand one workspace tab by key (from workspace_overview): a browser page's visible text, a terminal's recent output, a chat's transcript, or an editor's file path plus the user's focused selection (text and line range), so 'this paragraph' or 'the selected code' resolves without asking. Key 'window' returns a screenshot of Work itself. Use it to look at anything the user can see or that runs in the background.",
      parameters: {
        key: z
          .string()
          .describe("Tab key from workspace_overview, e.g. 'browser:<id>'"),
      },
      execute: async (input, ctx) => {
        if (input.key === "window")
          return bridge.screenshotWindow(ctx.projectId);
        const result = await bridge.readTab(ctx.projectId, String(input.key));
        // Chat tabs resolve to a session pointer; the transcript itself
        // lives in the chat store, not behind the bridge.
        if (
          result &&
          typeof result === "object" &&
          (result as { kind?: string }).kind === "chat"
        ) {
          const pointer = result as {
            kind: "chat";
            sessionId: string | null;
            title?: string;
          };
          if (!pointer.sessionId) {
            return { kind: "chat", title: pointer.title, transcript: [] };
          }
          if (!(await sessionVisible(ctx.projectId, pointer.sessionId))) {
            throw new Error("That chat is private and not visible to agents.");
          }
          const transcript = readChatTranscript
            ? await readChatTranscript(ctx.projectId, pointer.sessionId)
            : null;
          if (!transcript) return result;
          let total = 0;
          const recent = transcript.messages
            .slice(-TRANSCRIPT_MESSAGE_CAP)
            .reverse()
            .filter((message) => {
              total += message.content.length;
              return total <= TRANSCRIPT_CHARS_CAP;
            })
            .reverse();
          return {
            kind: "chat",
            title: transcript.title ?? pointer.title,
            omitted: transcript.messages.length - recent.length,
            transcript: recent,
          };
        }
        return result;
      },
    },
    {
      name: "open_browser",
      description:
        "Open a tab in Work's browser, signed in as the person, and drive it with browser_snapshot and browser_act. Prefer it to fetching whenever a task needs their sign-ins, clicks, forms or uploads; open your own tab rather than driving one of theirs unless asked. They can watch and take over. Returns the tab key.",
      parameters: {
        url: z.string().describe("The http(s) URL to open"),
      },
      execute: async (input, ctx) => {
        const result = await bridge.openBrowser(
          ctx.projectId,
          turnHolder(ctx),
          String(input.url),
        );
        return {
          ...result,
          note: "Tab opened under your control until this turn ends, when it goes back to the person. Take a browser_snapshot to see the page; discover surface_control to close it if it was only scaffolding.",
        };
      },
    },
    {
      name: "browser_snapshot",
      description:
        "A browser tab's interactive elements (links, buttons, inputs) with uids for browser_act, plus its url and title; any tab key from the workspace context works. format image is a screenshot (canvas, embedded frames) whose coordinates are CSS viewport pixels. A uid stays valid while its element stays in the page; snapshot again after the page changes.",
      parameters: {
        key: z.string().describe("Browser tab key, e.g. 'browser:<id>'"),
        format: z.enum(["dom", "image"]).optional(),
      },
      execute: (input, ctx) =>
        bridge.browserSnapshot(
          ctx.projectId,
          turnHolder(ctx),
          String(input.key),
          input.format === "image" ? "image" : "dom",
        ),
    },
    {
      name: "browser_act",
      description:
        "Act on a browser tab with real input: click or hover (uid, or x and y), drag (x, y to toX, toY), fill (uid, text), select (uid, option value as text), press (press_key, e.g. Enter, Meta+a), navigate (url), scroll (direction), read (visible text), wait_for (text), upload (uid of a file input or the button that opens one, files as absolute paths; never hidden files or ~/Library). Inspect with evaluate (expression: JavaScript run in the page, its value returned), console and network (what the page logged and requested since the tab was last read), and downloads (files this tab saved, with paths; timeoutMs waits for them). Fails while the person has taken the tab over; respect that.",
      parameters: {
        key: z.string().describe("Browser tab key, 'browser:<id>'"),
        action: z.enum([
          "click",
          "hover",
          "drag",
          "select",
          "fill",
          "press",
          "navigate",
          "scroll",
          "read",
          "wait_for",
          "upload",
          "evaluate",
          "console",
          "network",
          "downloads",
        ]),
        uid: z
          .string()
          .optional()
          .describe("Element uid from browser_snapshot"),
        x: z.number().nonnegative().optional(),
        y: z.number().nonnegative().optional(),
        toX: z.number().nonnegative().optional(),
        toY: z.number().nonnegative().optional(),
        text: z
          .string()
          .optional()
          .describe("Text to type (fill) or wait for (wait_for)"),
        press_key: z
          .string()
          .optional()
          .describe("Key for 'press', e.g. 'Enter', 'Escape', 'Tab'"),
        url: z.string().optional().describe("Target url (navigate)"),
        direction: z.enum(["up", "down"]).optional().describe("scroll only"),
        files: z.array(z.string()).optional().describe("upload only"),
        expression: z.string().optional().describe("evaluate only"),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
      execute: (input, ctx) => {
        const key = String(input.key);
        if (!key.startsWith("browser:"))
          throw new Error(
            `key names the browser tab ('browser:<id>'), not ${JSON.stringify(key)}; a keyboard key goes in press_key.`,
          );
        const action = parseBrowserAction(input);
        return bridge.browserAct(
          ctx.projectId,
          turnHolder(ctx),
          key,
          action.type === "upload" && ctx.workingDirectory
            ? { ...action, workingDirectory: ctx.workingDirectory }
            : action,
        );
      },
    },
    {
      name: "run_background_command",
      description:
        "Start a long-running command (a dev server, a watcher, a slow build or test run, anything you would otherwise wait on) in its own background terminal and keep working. It keeps running after this turn, shows as a chip on your chat the person can open to watch, and wakes this chat with a message when it finishes, so never poll with sleep. Use your own shell for quick commands. Returns the command's id, its status, and its first output (a quick failure shows up here). Set wake_on_output to also be woken when a line matches, e.g. 'ready on|listening|error'.",
      parameters: {
        command: z.string().describe("The shell command to run"),
        description: z
          .string()
          .describe(
            "What it does in 3-8 plain words, e.g. 'Start the dev server'. Shown to the person.",
          ),
        wake_on_exit: z
          .boolean()
          .optional()
          .describe("Wake this chat when it finishes (default true)"),
        wake_on_output: z
          .string()
          .optional()
          .describe(
            "A regular expression; wake this chat when an output line matches (at most every 15 seconds)",
          ),
      },
      execute: (input, ctx) => {
        if (!ctx.sessionId) throw new Error("Background commands need a chat.");
        return bridge.startBackgroundCommand({
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          command: String(input.command),
          description: String(input.description ?? ""),
          ...(ctx.workingDirectory
            ? { workingDirectory: ctx.workingDirectory }
            : {}),
          ...(typeof input.wake_on_exit === "boolean"
            ? { wakeOnExit: input.wake_on_exit }
            : {}),
          ...(typeof input.wake_on_output === "string" && input.wake_on_output
            ? { wakeOnOutput: input.wake_on_output }
            : {}),
        });
      },
    },
    {
      name: "read_background_output",
      description:
        "Read a background command's output since your last read, with its status (running, finished, stopped) and exit code. wait_seconds blocks until it prints something new or finishes; with wait_for, until a line matches.",
      parameters: {
        id: z.string().describe("The id run_background_command returned"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe("Seconds to wait"),
        wait_for: z.string().optional().describe("Regex of a line to wait for"),
      },
      execute: (input, ctx) =>
        bridge.readBackgroundCommand({
          sessionId: ctx.sessionId ?? "",
          id: String(input.id),
          ...(typeof input.wait_seconds === "number"
            ? { waitMs: input.wait_seconds * 1000 }
            : {}),
          ...(typeof input.wait_for === "string" && input.wait_for
            ? { waitFor: input.wait_for }
            : {}),
        }),
    },
    {
      name: "stop_background_command",
      description:
        "Stop a background command (Ctrl+C, then close its terminal) and return its last output, or stop a watch.",
      parameters: {
        id: z
          .string()
          .describe("The id run_background_command or watch_command returned"),
      },
      execute: (input, ctx) =>
        String(input.id).startsWith("watch-")
          ? bridge.stopCommandWatch({
              sessionId: ctx.sessionId ?? "",
              id: String(input.id),
            })
          : bridge.stopBackgroundCommand({
              sessionId: ctx.sessionId ?? "",
              id: String(input.id),
            }),
    },
    {
      name: "watch_command",
      description:
        "Wait for something without polling: re-run a quick check command here every few seconds and wake this chat when it matters, across turns and app restarts. until 'success' wakes once when the check exits 0 (curl -fsS <url>/health; test -f out.pdf), then ends. until 'change' wakes whenever its output or exit status changes, until stopped. Print only what matters (jq, grep) so timestamps are not changes. Checks missed during sleep collapse into one. The first check runs now; its result is returned. Stop with stop_background_command.",
      parameters: {
        command: z
          .string()
          .describe("A quick read-only check; it runs many times"),
        description: z
          .string()
          .describe(
            "What you wait for in 3-8 plain words, shown to the person",
          ),
        until: z
          .enum(["success", "change"])
          .describe(
            "'success': wake once when it exits 0. 'change': wake on every change.",
          ),
        every_seconds: z
          .number()
          .int()
          .min(5)
          .max(86_400)
          .optional()
          .describe("Seconds between checks (default 30)"),
        expires_in_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Give up after this long (and say so)"),
      },
      execute: (input, ctx) => {
        if (!ctx.sessionId) throw new Error("Watches need a chat.");
        return bridge.startCommandWatch({
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          command: String(input.command),
          description: String(input.description ?? ""),
          until: input.until === "change" ? "change" : "success",
          ...(ctx.workingDirectory
            ? { workingDirectory: ctx.workingDirectory }
            : {}),
          ...(typeof input.every_seconds === "number"
            ? { everySeconds: input.every_seconds }
            : {}),
          ...(typeof input.expires_in_seconds === "number"
            ? { expiresInSeconds: input.expires_in_seconds }
            : {}),
        });
      },
    },
    {
      name: "write_terminal",
      description:
        "Type raw input into a terminal: answer a prompt, drive an interactive command (REPLs, ssh, installers), or send control sequences. End a line with \\r to press Enter; '\\u0003' sends Ctrl+C to stop the foreground process. Targeting the user's own terminal takes it over first (they see the handoff). Fails if the user has taken the terminal over.",
      parameters: {
        terminalId: z
          .string()
          .describe(
            "A terminal id: a background command's id, or one from workspace_overview",
          ),
        data: z
          .string()
          .describe("Raw input, e.g. 'y\\r' or '\\u0003' for Ctrl+C"),
      },
      execute: async (input, ctx) => {
        const accepted = await bridge.writeTerminal(
          ctx.projectId,
          String(input.terminalId),
          String(input.data),
        );
        if (!accepted) {
          throw new Error(
            "Terminal not writable (closed or its process exited).",
          );
        }
        return { ok: true };
      },
    },
    {
      name: "sync_project",
      description:
        "Sync this project with its linked remote repository now. On the primary checkout this fetches and fast-forwards over a clean tree. Work pushes only to a repository it created; in a repository that existed before Work, local commits are never pushed, the result reports `ahead` or `diverged`, and you share them with create_pull_request. An isolated worktree is never synced; use create_pull_request to share that branch. Call this when the user asks to sync, pull, or share changes. Never run raw git push or pull in a terminal for a linked project.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!gitBridge) throw new Error("Remote sync is not available yet.");
        return gitBridge.sync(ctx.projectId, ctx.sessionId);
      },
    },
    {
      name: "create_pull_request",
      description:
        "Propose the project's current changes for review: pushes the recorded commits to a new work/ branch on the linked remote (e.g. GitHub) and opens a pull request. This is how local work reaches a repository that existed before Work, and the right choice whenever sync_project reports `ahead` or `diverged`, the change is risky, collaborators are active, or the user asks for review. Returns the PR URL; share it with the user (open_surface can open it).",
      parameters: {
        title: z
          .string()
          .min(1)
          .max(120)
          .describe("PR title: a concise, imperative summary of the change"),
        body: z
          .string()
          .optional()
          .describe("PR description (markdown): what changed and why"),
      },
      execute: async (input, ctx) => {
        if (!ctx.sessionId) throw new Error("This turn has no chat session.");
        if (!gitBridge) {
          throw new Error("Pull requests are not available yet.");
        }
        return gitBridge.createPullRequest(ctx.projectId, ctx.sessionId, {
          title: String(input.title),
          ...(typeof input.body === "string" ? { body: input.body } : {}),
        });
      },
    },
    {
      name: "request_connection",
      description:
        "Ask the user to connect an external service (a connector/MCP server — e.g. Linear, Notion, a database) that the current task needs but isn't connected yet. Opens the app's connector setup pre-filled with your search query; the user reviews, authenticates, and installs — never ask them to paste credentials into the chat. If something was installed, its tools are NOT available in this turn: finish your turn promptly and say what you'll do next — the conversation continues automatically with the new connection mounted.",
      parameters: {
        query: z
          .string()
          .min(1)
          .describe(
            "What to search the connector catalogs for (a service name works best, e.g. 'linear')",
          ),
        reason: z
          .string()
          .optional()
          .describe("One sentence shown to the user: why you need it"),
      },
      execute: async (input, ctx) => {
        const { installed } = await bridge.requestConnection(
          ctx.projectId,
          ctx.sessionId ?? "",
          String(input.query),
          typeof input.reason === "string" ? input.reason : undefined,
        );
        if (installed.length === 0) {
          return {
            installed: [],
            note: "The user didn't install a connection. Continue without it or ask them what they'd prefer.",
          };
        }
        return {
          installed,
          note: `Installed: ${installed.join(", ")}. These tools become available on your NEXT turn — end this turn with a brief status; the conversation resumes automatically.`,
        };
      },
    },
    {
      name: "read_skill",
      description:
        "Load a skill (a reusable playbook) by its declared name and return its SKILL.md content. Covers both tiers: project skills (files under .work/skills/ in this project) and app skills shipped by the app. Use it when the user invokes a skill by name ('use the X skill', a palette or / command) or a task matches a skill's description from your skill listing — then follow the returned instructions.",
      parameters: {
        name: z
          .string()
          .min(1)
          .describe("The skill's declared name, e.g. 'publishing-to-github'"),
      },
      execute: async (input, ctx) => {
        if (!readSkill) throw new Error("Skills are not available yet.");
        const result = await readSkill(ctx.projectId, String(input.name));
        if (!result) {
          throw new Error(
            `No skill named '${String(input.name)}' exists in this project.`,
          );
        }
        return result;
      },
    },
    {
      name: "desktop_settings",
      description:
        "Get the files that configure Work for this project and person (preferences, theme, keyboard shortcuts, workspace.js for sidebars and palette modes, and browser bookmarks) with their scopes, and any validation errors. Use with the configuring-catamorphic-desktop skill when the person wants to change how Work looks or behaves, or to bookmark a page.",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!host.desktopSettings)
          throw new Error("Work settings are not available here.");
        return host.desktopSettings(ctx.projectId);
      },
    },
    {
      name: "surface_control",
      description:
        "Manage a browser tab or terminal you control. Browser tabs you opened go back to the user by themselves when your turn ends; 'release' hands one back sooner, and you may drive it again later. 'release' on a terminal hands it over once you're done with an interactive command, until you reclaim it. 'reclaim' takes a surface back after the user took over (only when your task still needs it, and if they're actively using it, ask first); 'close' closes the tab entirely (terminals also end their process). Close surfaces that were only scaffolding.",
      parameters: {
        key: z.string().describe("Surface key, e.g. 'browser:<id>'"),
        action: z.enum(["release", "reclaim", "close"]),
      },
      execute: async (input, ctx) => {
        const key = String(input.key);
        switch (input.action) {
          case "release":
            await bridge.setControl(ctx.projectId, turnHolder(ctx), key, false);
            return { ok: true, note: "The user can now use this surface." };
          case "reclaim":
            await bridge.setControl(ctx.projectId, turnHolder(ctx), key, true);
            return { ok: true, note: "You are driving this surface again." };
          case "close":
            await bridge.closeSurface(ctx.projectId, key);
            return { ok: true };
          default:
            throw new Error(`Unknown action: ${String(input.action)}`);
        }
      },
    },
  ];

  const tools = definitions.map((tool): WorkspaceTool => {
    const policy = WORKSPACE_TOOL_POLICY[tool.name];
    if (!policy)
      throw new Error(`Workspace tool lacks an exposure policy: ${tool.name}`);
    return { ...tool, ...policy };
  });

  return {
    tools,
    setChatTranscriptReader(reader) {
      readChatTranscript = reader;
    },
    setChatIconSetter(setter) {
      setChatIcon = setter;
    },
    setAppBuilder(builder) {
      buildApp = builder;
    },
    setGitBridge(git) {
      gitBridge = git;
    },
    setSkillReader(reader) {
      readSkill = reader;
    },
    setSessionCoordinationBridge(bridge) {
      sessionCoordination = bridge;
    },
    setTodoListBridge(bridge) {
      todoList = bridge;
    },
    setCheckoutBridge(bridge) {
      checkouts = bridge;
    },
    setSessionVisibility(visibility) {
      sessionVisible = visibility;
    },
  };
}

const todoInputSchema = z
  .array(
    z.object({
      id: z.string().uuid().optional(),
      title: z.string().min(1).max(200),
      description: z.string().min(1).max(4_000),
      status: z.enum(["pending", "in_progress", "completed"]),
      activeForm: z
        .string()
        .max(80)
        .optional()
        .describe(
          "Present continuous, shown to the person while this is in progress, e.g. 'Reviewing database migrations'",
        ),
    }),
  )
  .max(50);

async function filterWorkspaceOverview(
  overview: unknown,
  projectId: string,
  visible: SessionVisibility,
): Promise<unknown> {
  if (!overview || typeof overview !== "object") return overview;
  const data = overview as {
    tabs?: unknown[];
    chats?: Array<{ key?: string; sessionId?: string | null }>;
  };
  if (!Array.isArray(data.chats)) return overview;
  const visibility = await Promise.all(
    data.chats.map(async (chat) => ({
      chat,
      visible: chat.sessionId ? await visible(projectId, chat.sessionId) : true,
    })),
  );
  const hiddenKeys = new Set(
    visibility
      .filter((entry) => !entry.visible && entry.chat.key)
      .map((entry) => entry.chat.key as string),
  );
  return {
    ...data,
    chats: visibility
      .filter((entry) => entry.visible)
      .map((entry) => entry.chat),
    ...(Array.isArray(data.tabs)
      ? {
          tabs: data.tabs.filter((tab) => {
            if (!tab || typeof tab !== "object") return true;
            return !hiddenKeys.has((tab as { key?: string }).key ?? "");
          }),
        }
      : {}),
  };
}

/** What an agent needs about a subsession: which one, and how it stands. */
function subsessionSummary(child: unknown): Record<string, unknown> {
  const parsed = z
    .object({
      status: z.string(),
      session: z.object({ id: z.string(), title: z.string().nullable() }),
    })
    .safeParse(child);
  return parsed.success
    ? {
        sessionId: parsed.data.session.id,
        title: parsed.data.session.title,
        status: parsed.data.status,
      }
    : { subsession: child };
}

function boundedTranscript(transcript: {
  title: string | null;
  messages: Array<{ role: string; content: string }>;
}) {
  let total = 0;
  const recent = transcript.messages
    .slice(-TRANSCRIPT_MESSAGE_CAP)
    .reverse()
    .filter((message) => {
      total += message.content.length;
      return total <= TRANSCRIPT_CHARS_CAP;
    })
    .reverse();
  return {
    title: transcript.title,
    omitted: transcript.messages.length - recent.length,
    transcript: recent,
  };
}

function checkoutResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const checkout = result as { path?: unknown };
  return {
    ...checkout,
    note:
      typeof checkout.path === "string"
        ? `Checkout assigned at ${checkout.path}. Use this absolute path for all remaining file and terminal operations in this turn. Future turns start there automatically.`
        : "Checkout assigned. Use its path for all remaining file and terminal operations in this turn.",
  };
}

function parseBrowserAction(
  input: Record<string, unknown>,
): Parameters<WorkspaceBridge["browserAct"]>[3] {
  const action = String(input.action);
  const uid = typeof input.uid === "string" ? input.uid : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;
  switch (action) {
    case "click":
    case "hover":
      if (uid !== undefined) return { type: action, uid };
      if (typeof input.x === "number" && typeof input.y === "number")
        return { type: action, x: input.x, y: input.y };
      throw new Error(`${action} needs a uid or x/y coordinates`);
    case "drag":
      if (
        typeof input.x !== "number" ||
        typeof input.y !== "number" ||
        typeof input.toX !== "number" ||
        typeof input.toY !== "number"
      )
        throw new Error("drag needs x, y, toX and toY");
      return {
        type: "drag",
        x: input.x,
        y: input.y,
        toX: input.toX,
        toY: input.toY,
      };
    case "fill":
    case "select":
      if (uid === undefined || text === undefined) {
        throw new Error(`${action} needs a uid and text`);
      }
      return { type: action, uid, text };
    case "press":
      if (typeof input.press_key !== "string") {
        throw new Error("press needs press_key (e.g. 'Enter')");
      }
      return { type: "press", key: input.press_key };
    case "navigate":
      if (typeof input.url !== "string") throw new Error("navigate needs url");
      return { type: "navigate", url: input.url };
    case "scroll":
      return {
        type: "scroll",
        direction: input.direction === "up" ? "up" : "down",
      };
    case "read":
      return { type: "read" };
    case "wait_for":
      if (text === undefined) throw new Error("wait_for needs text");
      return {
        type: "wait_for",
        text,
        timeoutMs:
          typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      };
    case "upload": {
      const files = z.array(z.string()).safeParse(input.files);
      if (uid === undefined || !files.success || files.data.length === 0)
        throw new Error("upload needs a uid and files (absolute paths)");
      return { type: "upload", uid, files: files.data };
    }
    case "evaluate":
      if (typeof input.expression !== "string" || !input.expression.trim())
        throw new Error("evaluate needs an expression");
      return { type: "evaluate", expression: input.expression };
    case "console":
    case "network":
      return { type: action };
    case "downloads":
      return {
        type: "downloads",
        timeoutMs:
          typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      };
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

/** The turn a browser tool call holds its tab for (agent-bridge). */
function turnHolder(ctx: ExtraToolContext): TurnHolder {
  return {
    sessionId: ctx.sessionId ?? "",
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  };
}
