import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { desktopApi, type SessionCheckoutDetail } from "../lib/desktop-api.js";
import { ipcErrorText } from "../lib/remote-workspace.js";
import {
  useSessionCheckout,
  useWorktreesAvailable,
} from "../lib/use-session-checkout.js";

const BUSY_REASON = "Change the folder after the current turn finishes.";

export type ChatFolderAction =
  | "own-worktree"
  | "project-folder"
  | "bring"
  | "discard";

export interface ChatFolderView {
  /** `data-folder-kind`: primary, managed (chosen or checked out), external. */
  kind: "primary" | "managed" | "external" | "pending";
  value: string;
  /** Faint qualifier after the value. */
  tag?: string;
  lines: string[];
  actions: Array<{ id: ChatFolderAction; label: string; danger?: boolean }>;
}

/**
 * What the Folder row says and offers (ADR 0215), for a chat before its
 * first message (`draftWorktree`) or with a session (`detail`).
 */
export function chatFolderView(input: {
  started: boolean;
  detail: SessionCheckoutDetail | undefined;
  draftWorktree: boolean;
  worktreesAvailable: boolean;
}): ChatFolderView {
  const { detail } = input;
  const own = {
    id: "own-worktree" as const,
    label: "Use own worktree",
  };
  const folder = {
    id: "project-folder" as const,
    label: "Use project folder",
  };
  if (!input.started)
    return input.draftWorktree
      ? {
          kind: "managed",
          value: "Own worktree",
          tag: "with the first message",
          lines: [],
          actions: [folder],
        }
      : {
          kind: "primary",
          value: "Project folder",
          lines: [],
          actions: input.worktreesAvailable ? [own] : [],
        };
  if (!detail)
    return { kind: "pending", value: "Project folder", lines: [], actions: [] };
  if (detail.kind === "primary")
    return {
      kind: "primary",
      value: "Project folder",
      lines: [],
      actions: detail.worktreesAvailable ? [own] : [],
    };
  if (detail.kind === "external")
    return {
      kind: "external",
      value: "External worktree",
      ...(detail.branch ? { tag: detail.branch } : {}),
      lines: [detail.path],
      actions: [folder],
    };
  // Chosen; its next turn checks it out.
  if (!detail.branch)
    return {
      kind: "managed",
      value: "Own worktree",
      tag: "with the next message",
      lines: [],
      actions: [folder],
    };
  const changed = detail.changedFiles;
  return {
    kind: "managed",
    value: detail.branch,
    ...(detail.present ? {} : { tag: "put away" }),
    lines: [
      detail.present ? detail.path : "Checked out again with the next message.",
      ...(changed === null
        ? []
        : [
            changed === 0
              ? "No changes yet"
              : `${changed} changed ${changed === 1 ? "file" : "files"}`,
          ]),
    ],
    // With nothing to bring, moving back is simply using the folder.
    actions:
      changed === 0
        ? [{ id: "bring", label: "Use project folder" }]
        : [
            { id: "bring", label: "Bring to project folder" },
            { id: "discard", label: "Discard", danger: true },
          ],
  };
}

const PENDING_LABELS: Record<ChatFolderAction, string> = {
  "own-worktree": "Choosing…",
  "project-folder": "Changing folder…",
  bring: "Bringing…",
  discard: "Discarding…",
};

/**
 * The Folder row of a chat's status popup (ADR 0215): where the chat
 * works, and, between turns, moving it between the project folder and its
 * own worktree. Rendered inside the popup's definition list.
 */
export function ChatFolder({
  projectId,
  sessionId,
  busy,
  draftWorktree = false,
  onDraftWorktreeChange,
}: {
  projectId: string;
  /** Absent until the chat's first message creates its session. */
  sessionId: string | undefined;
  /** A turn runs: the folder changes after it. */
  busy: boolean;
  /** Before the first message: whether it gives the chat its own worktree. */
  draftWorktree?: boolean;
  onDraftWorktreeChange?: (worktree: boolean) => void;
}) {
  const client = useQueryClient();
  const checkout = useSessionCheckout(projectId, sessionId);
  const available = useWorktreesAvailable(projectId, {
    enabled: !sessionId,
  });
  const [pending, setPending] = useState<ChatFolderAction | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const view = chatFolderView({
    started: Boolean(sessionId),
    detail: sessionId ? checkout.data : undefined,
    draftWorktree,
    worktreesAvailable: available.data ?? false,
  });
  const changed = checkout.data?.changedFiles ?? 0;

  const run = async (
    action: ChatFolderAction,
    ids: { projectId: string; sessionId: string },
  ) => {
    setPending(action);
    setError(null);
    setStatus(null);
    try {
      if (action === "own-worktree") {
        await desktopApi.sessionUseOwnWorktree(ids);
        setStatus("The next message checks out the chat's own worktree.");
      } else if (action === "project-folder") {
        await desktopApi.sessionUseProjectFolder(ids);
        if (view.kind === "external")
          setStatus(
            "Future work uses the project folder. Existing files stay in the worktree.",
          );
      } else if (action === "bring") {
        const { files } = await desktopApi.sessionBringToProjectFolder(ids);
        setStatus(
          files.length > 0
            ? `Brought ${files.length} changed ${files.length === 1 ? "file" : "files"} to the project folder.`
            : "The chat works in the project folder again.",
        );
      } else {
        await desktopApi.sessionDiscardWorktree(ids);
        setStatus(
          "Discarded the worktree. The chat works in the project folder again.",
        );
      }
    } catch (cause) {
      setError(ipcErrorText(cause));
    } finally {
      setPending(null);
      setConfirmDiscard(false);
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["desktop", "session-checkout", projectId],
        }),
        client.invalidateQueries({
          queryKey: ["desktop", "session-checkouts", projectId],
        }),
      ]);
    }
  };
  const choose = (action: ChatFolderAction) => {
    if (!sessionId) {
      onDraftWorktreeChange?.(action === "own-worktree");
      return;
    }
    if (action === "discard") {
      setConfirmDiscard(true);
      return;
    }
    void run(action, { projectId, sessionId });
  };
  const actions = !sessionId && !onDraftWorktreeChange ? [] : view.actions;
  const disabledReason = busy ? BUSY_REASON : undefined;
  return (
    <>
      <dt className="text-fg-faint">Folder</dt>
      <dd
        className="min-w-0 text-fg"
        data-testid="chat-folder"
        data-folder-kind={view.kind}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate">{view.value}</span>
          {view.tag ? (
            <span className="shrink-0 text-fg-faint">{view.tag}</span>
          ) : null}
        </span>
        {view.lines.map((line) => (
          <p key={line} className="mt-0.5 break-all text-fg-muted">
            {line}
          </p>
        ))}
        {confirmDiscard && sessionId ? (
          <div className="mt-2 space-y-1" data-testid="chat-folder-confirm">
            <p className="break-normal text-fg-muted">
              Discard {changed} changed {changed === 1 ? "file" : "files"} with
              this chat's worktree? The chat continues in the project folder.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={pending !== null}
                className="cursor-pointer text-danger hover:underline disabled:cursor-default disabled:opacity-50"
                onClick={() => void run("discard", { projectId, sessionId })}
              >
                {pending === "discard" ? PENDING_LABELS.discard : "Discard"}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                className="cursor-pointer text-fg-muted hover:text-fg hover:underline disabled:cursor-default disabled:opacity-50"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep
              </button>
            </div>
          </div>
        ) : actions.length > 0 ? (
          <div
            className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1"
            data-disabled-reason={disabledReason}
          >
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                data-folder-action={action.id}
                disabled={Boolean(disabledReason) || pending !== null}
                aria-description={disabledReason}
                className={`cursor-pointer hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-50 ${
                  action.danger ? "text-danger" : "text-accent"
                }`}
                onClick={() => choose(action.id)}
              >
                {pending === action.id
                  ? PENDING_LABELS[action.id]
                  : action.label}
              </button>
            ))}
          </div>
        ) : null}
        {status ? (
          <p role="status" className="mt-1.5 break-normal text-fg-faint">
            {status}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1.5 break-normal text-danger">
            {error}
          </p>
        ) : null}
      </dd>
    </>
  );
}
