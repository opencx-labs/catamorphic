import type { AgentCoordinationStrategy } from "@catamorphic/core";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
  TurnContextFragment,
  TurnOptions,
} from "@catamorphic/sandbox";
import type { WorkspaceBridge } from "../agent-bridge.js";

export interface ProjectSessionContext {
  id: string;
  title: string | null;
  agentId: string | null;
  running: boolean;
  task: string | null;
  activity: string | null;
  checkout: {
    kind: "primary" | "managed" | "external";
    branch: string | null;
  };
}

export interface AgentCoordinationContext {
  strategy: AgentCoordinationStrategy;
  peers(projectId: string, sessionId: string): Promise<ProjectSessionContext[]>;
  checkoutNotice?(projectId: string, sessionId: string): Promise<string | null>;
}

export function effectiveSessionAgentId(input: {
  projectId: string;
  agentId: string | null | undefined;
  defaultAgentId(projectId: string): string | undefined;
}): string | undefined {
  return input.agentId ?? input.defaultAgentId(input.projectId);
}

export function coordinationStrategyForSession(input: {
  projectId: string;
  agentId: string | null | undefined;
  defaultAgentId(projectId: string): string | undefined;
  coordinationForAgent(agentId: string): AgentCoordinationStrategy;
}): AgentCoordinationStrategy {
  const effectiveAgentId = effectiveSessionAgentId(input);
  return effectiveAgentId
    ? input.coordinationForAgent(effectiveAgentId)
    : "shared-first";
}

export function isolationConflictPeerSessionIds(input: {
  projectId: string;
  agentId: string | null | undefined;
  peers: Array<{ id: string; agentId: string | null | undefined }>;
  defaultAgentId(projectId: string): string | undefined;
  coordinationForAgent(agentId: string): AgentCoordinationStrategy;
}): string[] {
  const ownStrategy = coordinationStrategyForSession(input);
  return input.peers
    .filter(
      (peer) =>
        ownStrategy === "isolation-required" ||
        coordinationStrategyForSession({
          ...input,
          agentId: peer.agentId,
        }) === "isolation-required",
    )
    .map((peer) => peer.id);
}

/** Wiring for {@link WorkspaceContextAgent}. */
export interface WorkspaceContextOptions {
  bridge: WorkspaceBridge;
  /** Whether this harness also carries the workspace toolset. */
  hasTools: boolean;
  /**
   * The skills section for this harness (ADR 0049), resolved lazily so
   * sessions started before the server finishes booting still pick it up.
   */
  skillsNote?: () => string | undefined;
  coordination?: AgentCoordinationContext;
  /**
   * Per-project desktop facts: where new private documents go and any
   * settings file the person broke. Paths for settings themselves are a
   * tool call away (desktop_settings), not in every turn.
   */
  desktopFacts?: (projectId: string) => {
    personalFilesDirectory?: string;
    settingsErrors?: string[];
  };
  bindTurn?: (sessionId: string, options?: TurnOptions) => () => void;
}

/**
 * Workspace awareness for every harness (ADR 0152): a short, stable Work
 * section appended to the session's system prompt, and each turn's live
 * screen, desktop facts and peers added to the turn's context fragments.
 * The harness delivers fragments beside the user's message through its own
 * channel; the message text is never touched, so neither the stored chat
 * nor the harness history mixes host context into the person's words.
 */
export class WorkspaceContextAgent implements CodingAgentProvider {
  readonly name: string;
  /** Forwarded only when the harness supports them (feature-detection). */
  readonly interrupt?: (providerSessionId: string) => void;
  readonly hasSession?: (providerSessionId: string) => boolean;
  readonly retryTurn?: CodingAgentProvider["retryTurn"];

  constructor(
    private readonly inner: CodingAgentProvider,
    private readonly opts: WorkspaceContextOptions,
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
      // A retry re-runs history as-is; no fresh context to add.
      const bindTurn = opts.bindTurn;
      this.retryTurn = async function* (
        session: ProviderSession,
        turn?: TurnOptions,
      ) {
        const release = bindTurn?.(session.sessionId, turn);
        try {
          if (inner.retryTurn) yield* inner.retryTurn(session, turn);
        } finally {
          release?.();
        }
      };
    }
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return this.inner.startSession({
      ...opts,
      systemPrompt: [
        opts.systemPrompt,
        workPlaybook({ hasTools: this.opts.hasTools }),
        coordinationNote(this.opts.coordination?.strategy ?? "shared-first"),
        this.opts.skillsNote?.(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    const fragments = await this.turnContext(session);
    const release = this.opts.bindTurn?.(session.sessionId, opts);
    try {
      yield* this.inner.sendMessage(session, message, {
        ...opts,
        context: [...(opts?.context ?? []), ...fragments],
      });
    } finally {
      release?.();
    }
  }

  async dispose(session: ProviderSession): Promise<void> {
    await this.inner.dispose(session);
  }

  /** Every part is advisory: a failure drops that part, never the turn. */
  private async turnContext(
    session: ProviderSession,
  ): Promise<TurnContextFragment[]> {
    const fragments: TurnContextFragment[] = [];
    const { bridge, coordination, desktopFacts } = this.opts;
    try {
      const overview = await bridge.overview(session.projectId);
      const screen = describeScreen(overview, session.sessionId);
      if (screen) {
        const look = await glanceAt(bridge, session.projectId, screen.focus);
        fragments.push({
          source: "workspace",
          trust: "observed",
          text: formatScreen(screen, look),
        });
      }
    } catch {
      // No window has the project open; the turn runs without a screen.
    }
    const desktop: string[] = [];
    try {
      const facts = desktopFacts?.(session.projectId);
      if (facts?.personalFilesDirectory) {
        desktop.push(
          `New documents the person asks for are private by default: save them in ${facts.personalFilesDirectory} unless they choose another folder.`,
        );
      }
      if (facts?.settingsErrors?.length) {
        desktop.push(
          `A Work settings file has errors, so its last valid version is still in effect: ${facts.settingsErrors.join("; ")}`,
        );
      }
    } catch {
      // Desktop facts are advisory.
    }
    try {
      const notice = await coordination?.checkoutNotice?.(
        session.projectId,
        session.sessionId,
      );
      if (notice) desktop.push(notice);
    } catch {
      // A recovery notice must not break a turn.
    }
    try {
      const running = bridge
        .backgroundCommands({ sessionId: session.sessionId })
        .filter((command) => command.status === "running");
      if (running.length > 0) {
        desktop.push(
          [
            "Your background commands and watches still running (they wake this chat when they finish or see what you asked for):",
            ...running.map(
              (command) =>
                `- ${command.id}: ${command.description} (${command.command.replace(/\s+/g, " ").slice(0, 120)})`,
            ),
          ].join("\n"),
        );
      }
    } catch {
      // Advisory.
    }
    if (desktop.length > 0) {
      fragments.push({
        source: "desktop",
        trust: "host",
        text: desktop.join("\n"),
      });
    }
    try {
      if (coordination) {
        const peers = formatProjectSessionsContext(
          await coordination.peers(session.projectId, session.sessionId),
        );
        if (peers) {
          fragments.push({
            source: "project_sessions",
            trust: "observed",
            text: peers,
          });
        }
      }
    } catch {
      // Coordination context is advisory.
    }
    return fragments;
  }
}

/**
 * The stable Work section of every desktop agent's system prompt. Kept
 * short: procedures live in the desktop-workspace skill.
 */
export function workPlaybook({ hasTools }: { hasTools: boolean }): string {
  const tools = hasTools
    ? `

Use your own file and shell tools for ordinary work; Bun is on PATH. Start anything long-running (dev servers, slow builds or test runs) with run_background_command and keep working: it runs in a terminal the person can open, outlives this turn, and wakes this chat when it finishes, so never wait on it with sleep. To wait on anything else (a file, a deploy, a review), use watch_command, never a polling loop. Give commands a short plain description; the person sees it as what you are doing, as they see an in-progress todo's activeForm. Read more of what the person sees with read_tab (a page's full text, a terminal's output, another chat, an editor selection). Browser tools from elsewhere, such as a Chrome extension or MCP server, see a different browser, not Work's tabs. Control Work's browser or terminals, reach other chats, build apps and connect services through discover_capabilities; the desktop-workspace skill explains these when a task needs them.

Show results instead of describing where they are: link them in Markdown as [Title](app:<name>), [Title](workflow:<exportName>), [Title](file:<path>) or a web URL, and open the one that matters with open_surface. Use update_todo_list to show progress on multi-step work.`
    : "";
  return `# Work

This conversation runs inside Work, the person's desktop workspace: browser tabs, documents, terminals, apps and other chats share one window with this chat. Each turn's workspace context says what is on their screen right now. "This", "here", "this page", and questions that name nothing are almost always about what they are looking at: answer about that first, and turn to the project folder only when the question is about the project.${tools}

Keep work on this computer unless the person asks to share, publish or propose it. Connectors are managed in Work's Settings; if your harness reports that an MCP server or plugin needs authorization, that is a host notice: mention it only when the person asks about that connector or wants to use it.`;
}

function coordinationNote(strategy: AgentCoordinationStrategy): string {
  const rule =
    strategy === "isolation-required"
      ? " This agent must not share a checkout with another active chat: use a worktree or wait."
      : strategy === "isolate-on-contention"
        ? " Prefer a worktree when another active chat is likely to touch the same files."
        : "";
  return `Other chats may be working in this project at the same time; the turn context lists them. Before editing, check whether one is changing the same files, and coordinate or wait (see the desktop-workspace skill).${rule}`;
}

/** Other active chats in the project, as observed status data. */
export function formatProjectSessionsContext(
  peers: ProjectSessionContext[],
): string {
  if (peers.length === 0) return "";
  const lines = ["Other active chats in this project:"];
  for (const peer of peers.slice(0, 8)) {
    const title = oneLine(peer.title || peer.task || "Untitled chat");
    const where =
      peer.checkout.kind === "primary"
        ? ""
        : `, in a separate worktree${
            peer.checkout.branch ? ` (${oneLine(peer.checkout.branch)})` : ""
          }`;
    const doing = peer.activity ?? (peer.task !== title ? peer.task : null);
    lines.push(
      `- "${title}" (${peer.running ? "working now" : "idle"}${where})${
        doing ? `: ${oneLine(doing)}` : ""
      }`,
    );
  }
  if (peers.length > 8) lines.push(`- …and ${peers.length - 8} more`);
  return lines.join("\n");
}

function oneLine(value: string, limit = 160): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const MAX_OTHER_TABS = 16;
const GLANCE_CHARS = 1500;
const GLANCE_TIMEOUT_MS = 800;

interface OverviewTab {
  key?: string;
  kind?: string;
  active?: boolean;
  title?: string;
  url?: string;
  filePath?: string;
  name?: string;
  running?: boolean;
  busy?: boolean;
  agentControlled?: boolean;
  /** Chip-only surface: no workspace tab until shown. */
  background?: boolean;
  selection?: { text?: string; startLine?: number; endLine?: number };
}

interface OverviewChat {
  key?: string;
  title?: string;
  state?: string;
  sessionId?: string | null;
}

interface Screen {
  /** What the person is looking at, besides this chat. */
  focus?: OverviewTab;
  /** How this chat sits relative to the focus. */
  chat: "floating" | "minimized" | "tab" | "split" | "elsewhere";
  /** The other half of a split, when there is one. */
  beside?: OverviewTab;
  others: OverviewTab[];
  moreTabs: number;
}

/**
 * Interprets the renderer's overview for one chat: which surface the person
 * is looking at, and where this chat sits relative to it.
 */
export function describeScreen(
  overview: unknown,
  ownSessionId?: string,
): Screen | undefined {
  const data = overview as {
    tabs?: OverviewTab[];
    chats?: OverviewChat[];
    split?: { leftKey?: string; rightKey?: string } | null;
    previousTabKey?: string | null;
  };
  if (!data || !Array.isArray(data.tabs)) return undefined;
  const tabs = data.tabs;
  const own = (data.chats ?? []).find(
    (chat) => ownSessionId && chat.sessionId === ownSessionId,
  );
  const byKey = new Map(tabs.map((tab) => [tab.key, tab]));
  const active = tabs.find((tab) => tab.active);
  const split = data.split;
  const splitKeys =
    split?.leftKey && split.rightKey ? [split.leftKey, split.rightKey] : [];
  let focus = active;
  let chat: Screen["chat"] = "elsewhere";
  let beside: OverviewTab | undefined;
  if (own?.state === "partial") chat = "floating";
  else if (own?.state === "min") chat = "minimized";
  if (own?.key && active?.key === own.key) {
    // The chat is the front tab: "this" is the other half of a split, or
    // what they looked at just before opening the chat.
    const partner = splitKeys.includes(own.key)
      ? splitKeys.find((key) => key !== own.key)
      : undefined;
    chat = partner ? "split" : "tab";
    focus =
      byKey.get(partner) ??
      (data.previousTabKey ? byKey.get(data.previousTabKey) : undefined);
  } else if (active?.key && splitKeys.includes(active.key)) {
    const partnerKey = splitKeys.find((key) => key !== active.key);
    if (own?.key && partnerKey === own.key) chat = "split";
    else beside = byKey.get(partnerKey);
  }
  const shown = new Set([focus?.key, beside?.key, own?.key]);
  const rest = tabs.filter((tab) => !shown.has(tab.key));
  return {
    ...(focus ? { focus } : {}),
    chat,
    ...(beside ? { beside } : {}),
    others: rest.slice(0, MAX_OTHER_TABS),
    moreTabs: Math.max(0, rest.length - MAX_OTHER_TABS),
  };
}

interface Glance {
  title?: string;
  description?: string;
  selection?: string;
  text?: string;
}

/** A passive look inside the focused surface, bounded in time and size. */
async function glanceAt(
  bridge: WorkspaceBridge,
  projectId: string,
  focus: OverviewTab | undefined,
): Promise<Glance | undefined> {
  if (!focus?.key) return undefined;
  if (focus.kind === "editor" && focus.selection?.text) {
    return { selection: focus.selection.text.slice(0, GLANCE_CHARS) };
  }
  const look = async (): Promise<Glance | undefined> => {
    if (focus.kind === "browser") {
      return (await bridge.glanceBrowser(
        projectId,
        focus.key as string,
        GLANCE_CHARS,
      )) as Glance;
    }
    if (focus.kind === "terminal") {
      const read = (await bridge.readTab(projectId, focus.key as string)) as {
        output?: string;
      };
      const output = (read?.output ?? "").trimEnd();
      return output ? { text: output.slice(-GLANCE_CHARS) } : undefined;
    }
    return undefined;
  };
  try {
    return await Promise.race([
      look(),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), GLANCE_TIMEOUT_MS).unref?.(),
      ),
    ]);
  } catch {
    return undefined;
  }
}

function describeTab(tab: OverviewTab): string {
  const kind =
    tab.kind === "browser"
      ? "web page"
      : tab.kind === "editor"
        ? "file"
        : (tab.kind ?? "tab");
  const label = tab.title || tab.filePath || tab.name || tab.url || kind;
  const marks = [
    tab.kind === "browser" && tab.url && tab.url !== label ? tab.url : "",
    tab.kind === "editor" && tab.filePath && tab.filePath !== label
      ? tab.filePath
      : "",
    tab.kind === "terminal" && tab.busy ? "running a command" : "",
    tab.agentControlled ? "agent-controlled" : "",
    tab.background ? "not open as a tab" : "",
  ].filter(Boolean);
  return `${kind} "${oneLine(label, 120)}"${
    marks.length > 0 ? ` (${marks.join(", ")})` : ""
  } [${tab.key ?? ""}]`;
}

/** Model-facing rendering of the screen: the focus first, in detail. */
export function formatScreen(screen: Screen, look?: Glance): string {
  const lines: string[] = [];
  if (screen.focus) {
    lines.push(`The person is looking at: ${describeTab(screen.focus)}`);
    if (look?.description) lines.push(`Description: ${look.description}`);
    const selection =
      look?.selection ??
      (screen.focus.kind === "editor" ? screen.focus.selection?.text : "");
    if (selection) {
      const range =
        screen.focus.kind === "editor" && screen.focus.selection?.startLine
          ? ` (lines ${screen.focus.selection.startLine}-${screen.focus.selection.endLine})`
          : "";
      lines.push(`Selected${range}:`, fence(selection));
    }
    if (look?.text) {
      lines.push(
        screen.focus.kind === "terminal"
          ? "Latest output:"
          : "Start of the page:",
        fence(look.text),
      );
    }
  } else {
    lines.push(
      "The person is looking at this chat; nothing else is on screen.",
    );
  }
  if (screen.beside) {
    lines.push(`Beside it, in a split: ${describeTab(screen.beside)}`);
  }
  if (screen.focus)
    lines.push(
      {
        floating: "This chat floats over that view.",
        minimized: "This chat is minimized over that view.",
        tab: "This chat fills the window; the view above is what they looked at just before opening it.",
        split: "This chat is open beside that view.",
        elsewhere: "This chat is open in the workspace.",
      }[screen.chat],
    );
  if (screen.others.length > 0) {
    lines.push(
      "Other open tabs:",
      ...screen.others.map((tab) => `- ${describeTab(tab)}`),
    );
    if (screen.moreTabs > 0) lines.push(`- …and ${screen.moreTabs} more`);
  }
  return lines.join("\n");
}

function fence(text: string): string {
  const body = text.trim();
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}\n${body}\n${ticks}`;
}
