import type { AgentSession } from "@catamorphic/react/types";
import {
  chatBookmarkUrl,
  parseChatBookmarkUrl,
} from "../../shared/bookmark-target.js";
import { openModeForAction } from "../../shared/open-mode.js";
import type { SidebarBadge, SidebarMenuEntry } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { importedHarnessLabel } from "../components/harness-icon.js";
import {
  type ChatSessionAction,
  chatSessionMenu,
} from "../lib/chat-session-actions.js";
import { desktopApi } from "../lib/desktop-api.js";
import { sessionLabel } from "../lib/session-label.js";
import {
  readSessionRows,
  readSidebarSessionPage,
  sessionPollPages,
  subscribeSidebarSessions,
} from "../lib/sidebar-sessions.js";
import { capabilitiesOf, type SectionSource } from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";

/** Up to how many chats above an open fork the list looks for its row. */
const REVEAL_ANCESTORS = 8;

const CHAT_ACTIONS = new Set<string>([
  "new-subsession",
  "open-terminal",
  "open-preview",
  "mark-read",
  "mark-unread",
  "archive",
  "unarchive",
]);
const isChatAction = (action: string): action is ChatSessionAction =>
  CHAT_ACTIONS.has(action);

interface Checkout {
  sessionId: string;
  kind: string;
  branch?: string | null;
}

/** Which checkout each chat works in, read once a moment for every row. */
async function checkouts(deps: WorkSourceDeps): Promise<Map<string, Checkout>> {
  if (deps.remote) return new Map();
  try {
    const rows = await deps.queryClient.fetchQuery({
      queryKey: ["desktop", "session-checkouts", deps.projectId],
      queryFn: () => desktopApi.sessionCheckouts(deps.projectId),
      staleTime: 2000,
    });
    return new Map(rows.map((row) => [row.sessionId, row]));
  } catch {
    return new Map();
  }
}

/** A chat as a row: what it is doing, where it works, and its own verbs. */
export function chatRow({
  deps,
  session,
  parentId,
  checkout,
}: {
  deps: WorkSourceDeps;
  session: AgentSession;
  parentId: string | null;
  checkout?: Checkout;
}): SidebarSourceItem {
  const host = deps.host();
  const unread = host.unreadSessionIds.has(session.id);
  const branch = checkout
    ? checkout.kind === "external"
      ? "External"
      : (checkout.branch ?? "Worktree")
    : undefined;
  // A chat run in Claude Code or Codex, outside Work (ADR 0233).
  const imported = session.imported
    ? importedHarnessLabel(session.imported.harness)
    : undefined;
  const badges: SidebarBadge[] = [];
  if (imported) badges.push({ label: imported });
  if (session.owner === "project")
    badges.push({ label: "Project", icon: "Box" });
  if (branch) badges.push({ label: branch, icon: "GitBranch" });
  const menu: SidebarMenuEntry[] = chatSessionMenu({
    unread,
    archived: session.visibility === "archived",
    remote: deps.remote,
  }).map((entry) => ({ label: entry.label, action: entry.action }));
  return {
    id: session.id,
    parentId,
    hasChildren: Boolean(session.childCount),
    label: sessionLabel(session),
    url: chatBookmarkUrl({ projectId: deps.projectId, sessionId: session.id }),
    // A chat's own glyph ("<name>:<color>"), or the fork or chat default.
    icon:
      session.icon ?? (session.parentSessionId ? "GitFork" : "MessageSquare"),
    signal: session.attentionRequired
      ? "attention"
      : session.running
        ? "working"
        : unread
          ? "unread"
          : undefined,
    badges,
    menu,
    preview: {
      title: sessionLabel(session),
      description: session.activity ?? undefined,
      metadata: [
        ...(imported ? [{ label: "From", value: imported }] : []),
        {
          label: "Agent",
          value: host.agentName(session.agentId) ?? "Unknown agent",
        },
        ...(session.owner === "project"
          ? [{ label: "Belongs to", value: "The project" }]
          : []),
        { label: "Environment", value: session.environment ?? "Default" },
        {
          label: "Status",
          value: session.running
            ? "Working"
            : session.status === "closed"
              ? "Closed"
              : "Ready",
        },
        ...(branch ? [{ label: "Checkout", value: branch }] : []),
      ],
    },
    data: { ...session },
  };
}

/** Run a chat row's verb in the window that shows it. */
export function chatAction(
  deps: WorkSourceDeps,
  itemId: string,
  action: string,
) {
  if (!isChatAction(action))
    throw new Error("This chat does not support that action");
  deps.host().sessionAction(itemId, action);
}

/**
 * `work:chats`: the project's chats, newest first, each with its own
 * children. `work:subsessions`: the children of the chat beside the
 * section, latent ones included. Both follow this computer's hints and the
 * server's polls (ADR 0229).
 */
export function chatsSource(
  deps: WorkSourceDeps,
  kind: "chats" | "subsessions",
): SectionSource {
  const source: SectionSource = {
    title: kind === "chats" ? "Chats" : "Subsessions",
    empty: kind === "chats" ? "No chats yet." : "No subsessions yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, cursor, session, signal, size }) => {
      const parent =
        parentId ?? (kind === "subsessions" ? (session?.id ?? null) : null);
      if (kind === "subsessions" && !parent) return { items: [] };
      const [page, checkout] = await Promise.all([
        readSessionRows({
          apiClient: deps.apiClient,
          client: deps.queryClient,
          projectId: deps.projectId,
          parentId: parent,
          cursor,
          signal,
          promotedOnly: kind === "chats",
          ...(size ? { limit: size } : {}),
        }),
        checkouts(deps),
      ]);
      return {
        items: page.items.map((row) =>
          chatRow({
            deps,
            session: row,
            parentId,
            checkout: checkout.get(row.id),
          }),
        ),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    },
    subscribe: (publish, { branches, branchSize }) => {
      const stopWindow = deps.onWindowChange("unread", () => {
        // What was read changes the rows' signals, not the list.
        for (const parentId of branches())
          publish({ type: "invalidate", parentId, quiet: true });
      });
      const stopSessions = subscribeSidebarSessions({
        client: deps.queryClient,
        projectId: deps.projectId,
        listener: (pages, asked) => {
          for (const parentId of branches().length ? branches() : [null])
            publish({
              type: "invalidate",
              parentId,
              // Polls and other routine checks change the list only when
              // its rows do (no refreshing spinner every poll).
              quiet: !asked,
              // A short list is read whole, so no row of it lags.
              pages:
                pages === "first"
                  ? sessionPollPages(branchSize(parentId))
                  : "loaded",
            });
        },
      });
      return () => {
        stopWindow();
        stopSessions();
      };
    },
    action: async ({ itemId, action }) => {
      // A chat opens through its address; these are its own verbs.
      if (openModeForAction(action) || action === "open")
        return {
          open: chatBookmarkUrl({
            projectId: deps.projectId,
            sessionId: itemId,
          }),
          mode: openModeForAction(action),
        };
      chatAction(deps, itemId, action);
      return undefined;
    },
    ...(kind === "chats"
      ? {
          /**
           * The open chat when it is older than every loaded row: shown past
           * the loaded rows instead of reading every page above it. A fork
           * brings in the top-level chat it hangs under.
           */
          reveal: async ({ url, after, signal }) => {
            const target = parseChatBookmarkUrl(url);
            if (!target || target.projectId !== deps.projectId) return null;
            const read = async (id: string) => {
              const response = await deps.apiClient.GET(
                "/api/projects/{projectId}/agent/sessions/{sessionId}",
                {
                  params: {
                    path: { projectId: deps.projectId, sessionId: id },
                  },
                  signal,
                },
              );
              return response.data ?? null;
            };
            let row = await read(target.sessionId);
            for (
              let depth = 0;
              row?.parentSessionId && depth < REVEAL_ANCESTORS;
              depth += 1
            ) {
              const parent = await read(row.parentSessionId);
              if (parent?.visibility !== "promoted") break;
              row = parent;
            }
            // Only a chat older than the loaded rows belongs past their
            // end; a newer one arrives with the next poll.
            const last =
              typeof after?.data?.createdAt === "string"
                ? Date.parse(after.data.createdAt)
                : Number.NaN;
            if (
              row?.visibility !== "promoted" ||
              !(last >= Date.parse(row.createdAt))
            )
              return null;
            return {
              ...chatRow({ deps, session: row, parentId: null }),
              hasChildren: false,
            };
          },
        }
      : {}),
  };
  return source;
}

/** `work:activity`'s chats: those working or waiting for the person, at any depth. */
export async function activeChatRows(
  deps: WorkSourceDeps,
  signal: AbortSignal,
): Promise<SidebarSourceItem[]> {
  const page = await readSidebarSessionPage({
    apiClient: deps.apiClient,
    client: deps.queryClient,
    projectId: deps.projectId,
    signal,
    query: { limit: 100, offset: 0 },
  });
  return page.items
    .filter(
      (session) =>
        session.visibility !== "archived" &&
        (session.running || Boolean(session.attentionRequired)),
    )
    .map((session) => ({
      ...chatRow({ deps, session, parentId: null }),
      hasChildren: false,
    }));
}
