import type { ExtraTool } from "@catamorphic/sandbox";
import { z } from "zod";
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

export interface WorkspaceToolkit {
  tools: ExtraTool[];
  /** Late-bound: the chat store exists only after the server boots. */
  setChatTranscriptReader(reader: ChatTranscriptReader): void;
}

const TRANSCRIPT_MESSAGE_CAP = 40;
const TRANSCRIPT_CHARS_CAP = 24_000;

export function buildWorkspaceToolkit(
  bridge: WorkspaceBridge,
): WorkspaceToolkit {
  let readChatTranscript: ChatTranscriptReader | null = null;

  const tools: ExtraTool[] = [
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
        "Expand one workspace tab by key (from workspace_overview): browser tabs return the page's visible text, terminals their recent output, chats their conversation transcript, editors the open file's path. Use it to look into anything the user can see — or anything running in the background.",
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
        "Open a new browser tab in the user's workspace and take control of it. The tab is visible to the user (marked as agent-driven; they can watch you work live) and appears as a chip on your chat. Returns the tab key — call browser_snapshot next to see the page's interactive elements. Prefer this over web fetching whenever a task needs logins, clicks, forms, or the user's own browser profile.",
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
        "List a browser tab's interactive elements (links, buttons, inputs …) as numbered uids plus the page url/title. Snapshot before acting, and take a fresh snapshot after anything that changes the page (navigation, submit, dynamic content) — uids go stale.",
      parameters: {
        key: z.string().describe("Browser tab key, e.g. 'browser:<id>'"),
      },
      execute: (input, ctx) =>
        bridge.browserSnapshot(ctx.projectId, String(input.key)),
    },
    {
      name: "browser_act",
      description:
        "Act on a browser tab: 'click' or 'fill' an element by uid (from browser_snapshot), 'press' a key (e.g. Enter) on the focused element, 'navigate' to a url, 'scroll' up/down, 'read' the page's visible text, or 'wait_for' text to appear. The user sees each action highlighted live. Fails if the user has taken over the tab — respect that and continue without it, or reclaim with surface_control only if your task requires the tab.",
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
        "Run a shell command in a real terminal tab in the user's workspace (project directory, user's login shell) — the user watches it live. By default a NEW terminal opens (a chip on your chat); pass terminalId to reuse one — a terminal you opened earlier, or any terminal from workspace_overview (running in the user's own terminal marks it agent-controlled until you release it). Prefer reusing one terminal for routine sequential commands. Waits for the command to finish (up to ~15s) and returns the output it produced; longer commands return early with commandRunning: true — poll read_terminal. Close scaffolding terminals with surface_control.",
      parameters: {
        command: z.string().describe("The shell command to run"),
        terminalId: z
          .string()
          .optional()
          .describe(
            "Existing terminal to run in (from workspace_overview or a previous run_terminal); omit for a new terminal",
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
        ),
    },
    {
      name: "read_terminal",
      description:
        "Read a terminal's recent output, whether its shell is alive (running), and whether a command is executing right now (busy). Works on any terminal from workspace_overview. Poll it to follow long-running commands.",
      parameters: {
        terminalId: z.string().describe("Terminal id from run_terminal"),
      },
      execute: async (input, ctx) => {
        const state = await bridge.readTerminal(
          ctx.projectId,
          String(input.terminalId),
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
        "Send input to a terminal you spawned — answer a prompt, or send control sequences. End a line with \\r to press Enter; '\\u0003' sends Ctrl+C to stop the foreground process. Fails if the user has taken the terminal over.",
      parameters: {
        terminalId: z.string().describe("Terminal id from run_terminal"),
        data: z
          .string()
          .describe("Raw input, e.g. 'y\\r' or '\\u0003' for Ctrl+C"),
      },
      execute: async (input) => {
        const accepted = await bridge.writeTerminal(
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
      name: "surface_control",
      description:
        "Manage a browser tab or terminal you control: 'release' hands it to the user once you're done driving it (do this whenever you finish a page or an interactive command — the tab stays open for them); 'reclaim' takes a surface back after the user took over (only when your task still needs it — if they're actively using it, ask first); 'close' closes the tab entirely (terminals also end their process). Close surfaces that were only scaffolding; release ones the user will want.",
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
