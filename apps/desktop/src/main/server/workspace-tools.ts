import type { ExtraTool } from "@catamorphic/sandbox";
import { z } from "zod";
import {
  CHAT_ICON_COLOR_IDS,
  CHAT_ICON_NAMES,
} from "../../shared/chat-icons.js";
import type { WorkspaceBridge } from "../agent-bridge.js";

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

/** Remote-sync + pull-request operations; wired to core after boot (ADR 0044). */
export interface GitBridge {
  sync(projectId: string): Promise<{ status: string; rescueBranch?: string }>;
  createPullRequest(
    projectId: string,
    input: { title: string; body?: string },
  ): Promise<{ url: string; number: number; branch: string }>;
}

export interface WorkspaceToolkit {
  tools: ExtraTool[];
  /** Late-bound: the chat store exists only after the server boots. */
  setChatTranscriptReader(reader: ChatTranscriptReader): void;
  /** Late-bound for the same reason. */
  setChatIconSetter(setter: ChatIconSetter): void;
  /** Late-bound: the apps service exists only after the server boots. */
  setAppBuilder(builder: AppBuilder): void;
  /** Late-bound: remote sync lives in core, which exists only after boot. */
  setGitBridge(git: GitBridge): void;
}

const TRANSCRIPT_MESSAGE_CAP = 40;
const TRANSCRIPT_CHARS_CAP = 24_000;

export function buildWorkspaceToolkit(
  bridge: WorkspaceBridge,
): WorkspaceToolkit {
  let readChatTranscript: ChatTranscriptReader | null = null;
  let setChatIcon: ChatIconSetter | null = null;
  let buildApp: AppBuilder | null = null;
  let gitBridge: GitBridge | null = null;

  const tools: ExtraTool[] = [
    {
      name: "build_app",
      description:
        "Build a project app (a React frontend under apps/<name>/ that calls workflows through the typed app contract) and publish it so the user can open it. Run this after creating or editing an app's files — publishing is what makes your changes visible. Pass publish: false to only compile a preview (checks for build errors without changing what the user sees). On success, show the result with open_surface target 'app:<name>'.",
      parameters: {
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .describe("The app's directory name under apps/"),
        publish: z
          .boolean()
          .optional()
          .describe("Publish after building (default true)"),
      },
      execute: async (input, ctx) => {
        if (!buildApp) throw new Error("App building is not available yet.");
        const result = await buildApp(
          ctx.projectId,
          String(input.name),
          input.publish !== false,
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
        "Open (or focus) something tab-shaped in the user's workspace, BEHIND your chat — your chat steps down to its floating dock so the user sees the tab. Targets: an existing tab key from workspace_overview, 'app:<name>' (a published project app), 'file:<path>' (opens the file in an editor tab), or an http(s) URL (browser tab). Use it to show the user something: an app you built, a file you changed, a page.",
      parameters: {
        target: z
          .string()
          .describe("Tab key, 'app:<name>', 'file:<path>', or an http(s) URL"),
      },
      execute: (input, ctx) =>
        bridge.openTarget(
          ctx.projectId,
          ctx.sessionId ?? "",
          String(input.target),
        ),
    },
    {
      name: "point_at",
      description:
        "Point the user's attention at a UI element with a subtle glow and scroll it into view. The glow stays until the user interacts with that element or you point at something else (pass keep_previous to stack pointers instead of replacing them). Targets: a workspace tab key from workspace_overview (glows that tab), 'app:<name>', or 'sidebar:<item label>' (glows that sidebar entry). Use clear_pointers when nothing should be highlighted anymore.",
      parameters: {
        target: z
          .string()
          .describe("Tab key, 'app:<name>', or 'sidebar:<item label>'"),
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
        const result = await bridge.pointAt(
          ctx.projectId,
          String(input.target),
          typeof input.note === "string" ? input.note : undefined,
          input.keep_previous === true,
        );
        if (!result.ok) {
          throw new Error(result.error ?? "Could not find that element.");
        }
        return { ok: true };
      },
    },
    {
      name: "clear_pointers",
      description:
        "Remove every glow you placed with point_at. Use it when the tour is over or the highlights no longer apply.",
      parameters: {},
      execute: async (_input, ctx) => {
        await bridge.clearPointers(ctx.projectId);
        return { ok: true };
      },
    },
    {
      name: "set_chat_icon",
      description: `Set this conversation's icon, shown on its tab, bubble, and sidebar entry (like picking a team icon in Linear). Choose the icon and color that best capture what the conversation is about; do it once when the topic is clear (around when the conversation gets its title), and again only if the topic changes substantially. Icons: ${CHAT_ICON_NAMES.join(", ")}. Colors: ${CHAT_ICON_COLOR_IDS.join(", ")}.`,
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
        "See the user's live workspace: every open tab (browser pages, terminals, editors, chats) with keys and titles, which tab is active (what the user is looking at right now), other chat conversations, and the sidebar's configured shortcuts. Start here whenever the user refers to something they can see, another conversation, or 'that page/terminal'. Expand any entry with read_tab.",
      parameters: {},
      execute: (_input, ctx) => bridge.overview(ctx.projectId),
    },
    {
      name: "read_tab",
      description:
        "Expand one workspace tab by key (from workspace_overview): browser tabs return the page's visible text, terminals their recent output, chats their conversation transcript, editors the open file's path. Use it to look into anything the user can see, or anything running in the background.",
      parameters: {
        key: z
          .string()
          .describe("Tab key from workspace_overview, e.g. 'browser:<id>'"),
      },
      execute: async (input, ctx) => {
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
        "Open a new browser tab in the user's workspace and take control of it. The tab is visible to the user (marked as agent-driven; they can watch you work live) and appears as a chip on your chat. Returns the tab key. Call browser_snapshot next to see the page's interactive elements. Prefer this over web fetching whenever a task needs logins, clicks, forms, or the user's own browser profile.",
      parameters: {
        url: z.string().describe("The http(s) URL to open"),
      },
      execute: async (input, ctx) => {
        const result = await bridge.openBrowser(
          ctx.projectId,
          ctx.sessionId ?? "",
          String(input.url),
        );
        return {
          ...result,
          note: "Tab opened under your control. Take a browser_snapshot to see the page; release it with surface_control when you're done.",
        };
      },
    },
    {
      name: "browser_snapshot",
      description:
        "List a browser tab's interactive elements (links, buttons, inputs …) as numbered uids plus the page url/title. Snapshot before acting, and take a fresh snapshot after anything that changes the page (navigation, submit, dynamic content): uids go stale.",
      parameters: {
        key: z.string().describe("Browser tab key, e.g. 'browser:<id>'"),
      },
      execute: (input, ctx) =>
        bridge.browserSnapshot(ctx.projectId, String(input.key)),
    },
    {
      name: "browser_act",
      description:
        "Act on a browser tab: 'click' or 'fill' an element by uid (from browser_snapshot), 'press' a key (e.g. Enter) on the focused element, 'navigate' to a url, 'scroll' up/down, 'read' the page's visible text, or 'wait_for' text to appear. The user sees each action highlighted live. Fails if the user has taken over the tab. Respect that and continue without it, or reclaim with surface_control only if your task requires the tab.",
      parameters: {
        key: z.string().describe("Browser tab key"),
        action: z.enum([
          "click",
          "fill",
          "press",
          "navigate",
          "scroll",
          "read",
          "wait_for",
        ]),
        uid: z.number().int().optional().describe("Element uid (click, fill)"),
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
        timeoutMs: z.number().int().positive().optional(),
      },
      execute: (input, ctx) =>
        bridge.browserAct(
          ctx.projectId,
          String(input.key),
          parseBrowserAction(input),
        ),
    },
    {
      name: "run_terminal",
      description:
        "Run a shell command in a real terminal in the user's workspace (project directory, user's login shell). By default a NEW terminal opens in the background: it appears as a chip on your chat, not as a tab — the user's view doesn't move. Show it to them with open_surface (the returned key) when the output is worth their attention. Pass terminalId to reuse a terminal (a terminal you opened earlier, or any terminal from workspace_overview; running in the user's own terminal marks it agent-controlled until you release it). Prefer reusing one terminal for routine sequential commands — shell state (cwd, env vars) persists there. Multi-line commands are safe (sent as one block). Waits for the command to finish (default 2 minutes; set timeoutMs up to 600000 for longer builds) and returns its output plus exitCode (0 = success) when available. Commands that outlast the wait return commandRunning: true — follow them with read_terminal (waitForIdleMs + sinceOffset with the returned offset), don't re-run them. Close scaffolding terminals with surface_control.",
      parameters: {
        command: z.string().describe("The shell command to run"),
        terminalId: z
          .string()
          .optional()
          .describe(
            "Existing terminal to run in (from workspace_overview or a previous run_terminal); omit for a new terminal",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long to wait for the command to finish, in ms (default 120000, max 600000)",
          ),
      },
      execute: (input, ctx) =>
        bridge.runTerminal(
          ctx.projectId,
          ctx.sessionId ?? "",
          String(input.command),
          typeof input.terminalId === "string" && input.terminalId
            ? input.terminalId
            : undefined,
          typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        ),
    },
    {
      name: "read_terminal",
      description:
        "Read a terminal's output, whether its shell is alive (running), and whether a command is executing right now (busy). Works on any terminal from workspace_overview. To follow a long-running command, pass waitForIdleMs (blocks until the command finishes or the deadline, up to 600000) and sinceOffset (the offset a previous run_terminal/read_terminal returned) to get only the new output — that's one call, not a poll loop. lastExitCode is the most recently finished command's exit code when known.",
      parameters: {
        terminalId: z.string().describe("Terminal id from run_terminal"),
        sinceOffset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Return only output after this buffer offset (from a previous call's `offset`)",
          ),
        waitForIdleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Block until the foreground command finishes, up to this many ms",
          ),
      },
      execute: async (input, ctx) => {
        const state = await bridge.readTerminal(
          ctx.projectId,
          String(input.terminalId),
          {
            ...(typeof input.sinceOffset === "number"
              ? { sinceOffset: input.sinceOffset }
              : {}),
            ...(typeof input.waitForIdleMs === "number"
              ? { waitForIdleMs: input.waitForIdleMs }
              : {}),
          },
        );
        if (!state) {
          throw new Error(
            "No such terminal (closed?). Check workspace_overview.",
          );
        }
        return state;
      },
    },
    {
      name: "write_terminal",
      description:
        "Send raw input to a terminal you control: answer a prompt, drive an interactive command (REPLs, installers), or send control sequences. End a line with \\r to press Enter; '\\u0003' sends Ctrl+C to stop the foreground process. Targeting the user's own terminal takes it over first (they see the handoff). Fails if the user has taken the terminal over.",
      parameters: {
        terminalId: z.string().describe("Terminal id from run_terminal"),
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
        "Sync this project with its linked remote repository (e.g. GitHub) now: pull new remote commits, push local checkpoints. Sync also runs automatically after your turns — call this when the user asks to sync/push/pull/share changes, or when you need the freshest remote state before working. Never run raw git push/pull in a terminal for a linked project; this tool applies the safe policy. Outcomes: up-to-date, pushed, pulled, merged (histories combined cleanly), deferred (unsaved edits in the tree; retried automatically), diverged (automatic merge conflicted — local work was pushed to a rescue branch on the remote; tell the user and offer a pull request from it), no-remote (project isn't linked to a remote).",
      parameters: {},
      execute: async (_input, ctx) => {
        if (!gitBridge) throw new Error("Remote sync is not available yet.");
        return gitBridge.sync(ctx.projectId);
      },
    },
    {
      name: "create_pull_request",
      description:
        "Propose the project's current changes for review: commits any pending edits, pushes them to a new branch on the linked remote (e.g. GitHub), and opens a pull request. Use this instead of syncing straight to the main branch when the change is risky, collaborators are active on this project, or the user asks for review. Returns the PR URL — share it with the user (open_surface can open it).",
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
        if (!gitBridge) {
          throw new Error("Pull requests are not available yet.");
        }
        return gitBridge.createPullRequest(ctx.projectId, {
          title: String(input.title),
          ...(typeof input.body === "string" ? { body: input.body } : {}),
        });
      },
    },
    {
      name: "surface_control",
      description:
        "Manage a browser tab or terminal you control: 'release' hands it to the user once you're done driving it (do this whenever you finish a page or an interactive command; the tab stays open for them); 'reclaim' takes a surface back after the user took over (only when your task still needs it, and if they're actively using it, ask first); 'close' closes the tab entirely (terminals also end their process). Close surfaces that were only scaffolding; release ones the user will want.",
      parameters: {
        key: z.string().describe("Surface key, e.g. 'browser:<id>'"),
        action: z.enum(["release", "reclaim", "close"]),
      },
      execute: async (input, ctx) => {
        const key = String(input.key);
        switch (input.action) {
          case "release":
            await bridge.setControl(ctx.projectId, key, false);
            return { ok: true, note: "The user can now use this surface." };
          case "reclaim":
            await bridge.setControl(ctx.projectId, key, true);
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
  };
}

function parseBrowserAction(
  input: Record<string, unknown>,
): Parameters<WorkspaceBridge["browserAct"]>[2] {
  const action = String(input.action);
  const uid = typeof input.uid === "number" ? input.uid : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;
  switch (action) {
    case "click":
      if (uid === undefined) throw new Error("click needs a uid");
      return { type: "click", uid };
    case "fill":
      if (uid === undefined || text === undefined) {
        throw new Error("fill needs a uid and text");
      }
      return { type: "fill", uid, text };
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
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}
