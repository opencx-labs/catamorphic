import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import type { WorkspaceBridge } from "../agent-bridge.js";

/**
 * Workspace awareness for every harness: appends the workspace playbook to
 * the session's system prompt, and opens each turn with a live
 * `<workspace_context>` snapshot of what the user's window shows — so a
 * chat opened over a web tab already knows what "this page" means, and any
 * question about "that terminal" or another conversation lands.
 *
 * The snapshot is prepended at the provider boundary: the stored chat
 * transcript stays clean (core persisted the user's message before this
 * decorator runs); only the harness-side history carries it.
 */
export class WorkspaceContextAgent implements CodingAgentProvider {
  readonly name: string;
  /** Forwarded only when the harness supports them (feature-detection). */
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: CodingAgentProvider["retryTurn"];

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly bridge: WorkspaceBridge,
    /** Whether this harness also carries the workspace toolset. */
    private readonly hasTools: boolean,
  ) {
    this.name = inner.name;
    if (inner.interrupt) {
      this.interrupt = (providerSessionId) =>
        inner.interrupt?.(providerSessionId);
    }
    if (inner.hasSession) {
      this.hasSession = (providerSessionId) =>
        inner.hasSession?.(providerSessionId) ?? true;
    }
    if (inner.retryTurn) {
      // A retry re-runs history as-is; no fresh context block to prepend.
      this.retryTurn = (session, opts) =>
        (inner.retryTurn as NonNullable<typeof inner.retryTurn>).call(
          inner,
          session,
          opts,
        );
    }
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const playbook = this.hasTools
      ? WORKSPACE_TOOLS_PLAYBOOK
      : WORKSPACE_CONTEXT_NOTE;
    return this.inner.startSession({
      ...opts,
      systemPrompt: [opts.systemPrompt, playbook].filter(Boolean).join("\n\n"),
    });
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    let context = "";
    try {
      context = formatWorkspaceContext(
        await this.bridge.overview(session.projectId),
        session.sessionId,
      );
    } catch {
      // No window has the project open — the turn just runs without a
      // snapshot. Context must never break a chat.
    }
    yield* this.inner.sendMessage(
      session,
      context ? `${context}\n\n${message}` : message,
      opts,
    );
  }

  async dispose(session: ProviderSession): Promise<void> {
    await this.inner.dispose(session);
  }
}

const WORKSPACE_TOOLS_PLAYBOOK = `## The user's workspace

This chat lives inside the user's desktop app, next to their real browser tabs, terminals, editors, and other chats. Its users range from non-programmers to professional engineers doing real development work on real codebases — calibrate to THIS user from how they talk and what the project holds. With an engineer, communicate like a senior colleague: file paths, branches, diffs, and git vocabulary are welcome, and never simplify away technical substance. With a non-technical user, describe behavior and outcomes in plain language. You can see and drive the workspace:

- Each turn opens with a <workspace_context> snapshot of what the user's window shows. It is background context, not part of the user's request. When they say "this page", "that terminal", or similar, resolve it against the snapshot: the ACTIVE entry is what they're looking at.
- workspace_overview lists everything open (including background tabs and other chats); read_tab expands any entry: page text, terminal output, chat transcripts, file paths.
- open_browser / browser_snapshot / browser_act give you a real browser tab in the user's own profile (their logins, cookies). Snapshot → act by uid → re-snapshot after navigation. Prefer it over webfetch when a task needs interaction or the user's session.
- run_terminal / read_terminal / write_terminal run commands in real terminal tabs. run_terminal waits for the command (2 min default, timeoutMs up to 10) and returns its output and exit code; pass terminalId to reuse a terminal (prefer one working terminal for routine sequential commands — cwd and env persist there — not a new tab per command). Long-running processes (dev servers, watchers) keep running across turns: follow them with read_terminal (waitForIdleMs blocks until done; sinceOffset returns only new output), and answer interactive prompts with write_terminal. If you have no built-in shell tool, run_terminal IS your shell.
- Surfaces you open appear as chips on this chat, live for the user to watch. While you drive one, the user can only watch, until they hit "Take over", after which your actions on it fail. When that happens, work around it or ask; reclaim with surface_control only if the task truly needs it.
- Apps: some projects contain user-facing apps under apps/<name>/ (see the building-apps skill in the project); you can also add the first app to a project that has none. After creating or editing an app, run build_app to publish it, then open_surface with target "app:<name>" to put it in front of the user. Apps you're editing show as chips on this chat.
- Showing the user things: open_surface opens/focuses any tab-shaped thing (tab keys, "app:<name>", "file:<path>", URLs). If the user is watching your chat it opens behind it — your chat steps aside so they see it. If they're busy on another surface, their view is not moved: the tab opens in the background and its chip on your chat is highlighted. The result's "opened" field says which happened ("focused" vs "background") — after a background open, tell the user it's ready and where; never assume they saw it. point_at adds a subtle glow + scroll to a tab, app, sidebar item ("sidebar:<label>"), or one of your chat's chips ("chip:<surface key>") that lasts until the user interacts with it or you point elsewhere; keep_previous stacks pointers, clear_pointers ends the tour. Prefer showing over describing.
- Git: every project is a git repository, and your work is checkpointed into its history automatically at the end of each turn — never commit for the sake of saving work. Projects linked to a remote (e.g. imported from GitHub) also sync automatically; sync_project runs that sync on demand (when the user says push/pull/sync, or you need the freshest remote state), and create_pull_request proposes changes for review instead of syncing to main — prefer it when the change is risky, collaborators are active, or the user asks for review. For linked projects use these tools for pushing and pulling, never raw git push/pull in a terminal (branching, rebasing, and other local git operations in a terminal are fine for technical work). With a non-technical user, report outcomes in plain language ("saved and shared", "opened a review request"), not git vocabulary.
- Worktrees: git worktrees are welcome for parallel or experimental work — the app's git views show every worktree. When you create one, remember gitignored files do NOT follow it: copy over whatever the code needs to run (.env files, local config, untracked credentials/fixtures) from the main folder before working there, and say you did.
- Identity: when the conversation's topic becomes clear (around when it gets its title), call set_chat_icon once with the icon and color that best capture it. The icon marks this chat in the user's tabs, bubbles, and sidebar. Update it only if the topic changes substantially.`;

const WORKSPACE_CONTEXT_NOTE = `## The user's workspace

This chat lives inside the user's desktop app. Each turn opens with a <workspace_context> snapshot describing what their window currently shows (tabs, terminals, other chats). It is background context, not part of the user's request. Use it to resolve references like "this page" or "that terminal".

Users range from non-programmers to professional engineers — calibrate to this user from how they talk and what the project holds; never simplify away technical substance for an engineer. Your work is checkpointed into the project's git history automatically at the end of each turn, so never commit just to save work. If you create a git worktree, gitignored files (.env, local config) do not follow it — copy the relevant ones from the main folder before working there.`;

const MAX_TAB_LINES = 24;
const MAX_SIDEBAR_ITEMS = 12;

interface OverviewTab {
  key?: string;
  kind?: string;
  active?: boolean;
  title?: string;
  url?: string;
  filePath?: string;
  name?: string;
  running?: boolean;
  agentControlled?: boolean;
  /** Chip-only agent terminal: no workspace tab until shown/clicked. */
  background?: boolean;
}

interface OverviewChat {
  key?: string;
  title?: string;
  working?: boolean;
  sessionId?: string;
}

interface OverviewSidebarSection {
  title?: string;
  items?: Array<{ label?: string; url?: string }>;
}

/** Compact, model-facing rendering of the renderer's overview payload. */
export function formatWorkspaceContext(
  overview: unknown,
  ownSessionId?: string,
): string {
  const data = overview as {
    tabs?: OverviewTab[];
    chats?: OverviewChat[];
    sidebar?: OverviewSidebarSection[];
  };
  if (!data || !Array.isArray(data.tabs)) return "";

  const chatsBySession = new Map<string, OverviewChat>();
  for (const chat of data.chats ?? []) {
    if (chat.sessionId) chatsBySession.set(chat.sessionId, chat);
  }
  const ownChatKey = ownSessionId
    ? chatsBySession.get(ownSessionId)?.key
    : undefined;

  const lines: string[] = [];
  for (const tab of data.tabs.slice(0, MAX_TAB_LINES)) {
    const marks = [
      tab.active ? "ACTIVE (the user is looking at this)" : "",
      tab.key && tab.key === ownChatKey ? "this conversation" : "",
      tab.kind === "terminal" && tab.running ? "running" : "",
      tab.agentControlled ? "agent-controlled" : "",
      // A chip-only terminal: the user is NOT looking at it; open_surface
      // with its key is how the agent puts it in front of them.
      tab.background ? "background — not open as a tab" : "",
    ].filter(Boolean);
    const label =
      tab.title || tab.filePath || tab.url || tab.name || tab.kind || "tab";
    const detail = tab.kind === "browser" && tab.url ? ` (${tab.url})` : "";
    lines.push(
      `- ${tab.kind ?? "tab"} "${label}"${detail}${
        marks.length > 0 ? ` (${marks.join(", ")})` : ""
      } [${tab.key ?? ""}]`,
    );
  }
  if (data.tabs.length > MAX_TAB_LINES) {
    lines.push(`- …${data.tabs.length - MAX_TAB_LINES} more tabs`);
  }

  const shortcuts: string[] = [];
  for (const section of data.sidebar ?? []) {
    for (const item of section.items ?? []) {
      if (shortcuts.length >= MAX_SIDEBAR_ITEMS) break;
      if (item.label) {
        shortcuts.push(item.url ? `${item.label} (${item.url})` : item.label);
      }
    }
  }

  return [
    "<workspace_context>",
    "The user's app window right now (background context, not a request):",
    ...lines,
    ...(shortcuts.length > 0
      ? [`Sidebar shortcuts: ${shortcuts.join(", ")}`]
      : []),
    "</workspace_context>",
  ].join("\n");
}
