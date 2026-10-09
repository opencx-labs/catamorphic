import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { desktopApi, type SessionCheckoutDetail } from "../lib/desktop-api.js";
import { ipcErrorText } from "../lib/remote-workspace.js";
import {
  sessionCheckoutKey,
  useSessionCheckout,
  useWorktreesAvailable,
} from "../lib/use-session-checkout.js";
import { PendingButton } from "./pending-button.js";

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
  /**
   * The choice lives on the chat until its first message records it, so
   * the row's actions change the choice, not the session.
   */
  draft: boolean;
}

/**
 * What the Folder row says and offers (ADR 0215), for a chat before its
 * first message records its choice (`draftWorktree`) or with a session
 * (`detail`).
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
  if (input.draftWorktree && detail?.kind !== "managed")
    return {
      kind: "managed",
      value: "Own worktree",
      tag: "with the first message",
      lines: [],
      actions: [folder],
      draft: true,
    };
  if (!input.started)
    return {
      kind: "primary",
      value: "Project folder",
      lines: [],
      actions: input.worktreesAvailable ? [own] : [],
      draft: true,
    };
  if (!detail)
    return {
      kind: "pending",
      value: "Checking",
      lines: [],
      actions: [],
      draft: false,
    };
  if (!detail.available)
    return {
      kind: detail.kind === "primary" ? "pending" : detail.kind,
      value: detail.kind === "managed" ? "Own worktree" : "Assigned worktree",
      tag: "unavailable",
      lines: [
        detail.path,
        "This folder is gone or no longer belongs to this project.",
      ],
      actions: [folder],
      draft: false,
    };
  if (detail.kind === "primary")
    return {
      kind: "primary",
      value: "Project folder",
      lines: [],
      actions: detail.worktreesAvailable ? [own] : [],
      draft: false,
    };
  if (detail.kind === "external")
    return {
      kind: "external",
      value: "Assigned worktree",
      ...(detail.branch ? { tag: detail.branch } : {}),
      lines: [detail.path],
      actions: [folder],
      draft: false,
    };
  // Chosen; its next turn checks it out.
  if (!detail.branch)
    return {
      kind: "managed",
      value: "Own worktree",
      tag: "with the next message",
      lines: [],
      actions: [folder],
      draft: false,
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
    draft: false,
  };
}

const PENDING_LABELS: Record<ChatFolderAction, string> = {
  "own-worktree": "Choosing…",
  "project-folder": "Changing…",
  bring: "Bringing…",
  discard: "Discarding…",
};

/** What one action does, and what the row says once it is done. */
async function perform(
  action: ChatFolderAction,
  ids: { projectId: string; sessionId: string },
  kind: ChatFolderView["kind"],
): Promise<string | null> {
  if (action === "own-worktree") {
    await desktopApi.sessionUseOwnWorktree(ids);
    return "The next message checks out the chat's own worktree.";
  }
  if (action === "project-folder") {
    await desktopApi.sessionUseProjectFolder(ids);
    return kind === "external"
      ? "Future work uses the project folder. Existing files stay in the worktree."
      : null;
  }
  if (action === "bring") {
    const { files } = await desktopApi.sessionBringToProjectFolder(ids);
    return files.length > 0
      ? `Brought ${files.length} changed ${files.length === 1 ? "file" : "files"} to the project folder.`
      : "The chat works in the project folder again.";
  }
  await desktopApi.sessionDiscardWorktree(ids);
  return "Discarded the worktree. The chat works in the project folder again.";
}

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
  /** Before the first message records it: the chat's own worktree is chosen. */
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
  const rowRef = useRef<HTMLElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // Focus follows the row as it changes under the keyboard.
  const focusAfter = useRef<"keep" | "discard" | "status" | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "keep") keepRef.current?.focus();
    else if (target === "discard")
      rowRef.current
        ?.querySelector<HTMLButtonElement>('[data-folder-action="discard"]')
        ?.focus();
    else if (target === "status") statusRef.current?.focus();
  });
  const view = chatFolderView({
    started: Boolean(sessionId),
    detail: sessionId ? checkout.data : undefined,
    draftWorktree,
    worktreesAvailable: available.data ?? false,
  });
  const changed = checkout.data?.changedFiles ?? null;
  const actions = view.draft && !onDraftWorktreeChange ? [] : view.actions;

  const run = async (action: ChatFolderAction, id: string) => {
    setPending(action);
    setError(null);
    setStatus(null);
    const outcome = await perform(
      action,
      { projectId, sessionId: id },
      view.kind,
    ).then(
      (message) => ({ message, error: null }),
      (cause: unknown) => ({ message: null, error: ipcErrorText(cause) }),
    );
    // The row shows where the chat works now before its actions return.
    await Promise.all([
      client.invalidateQueries({
        queryKey: sessionCheckoutKey(projectId, id),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: ["desktop", "session-checkouts", projectId],
      }),
    ]);
    setStatus(outcome.message);
    setError(outcome.error);
    setConfirmDiscard(false);
    setPending(null);
    focusAfter.current = "status";
  };
  const choose = (action: ChatFolderAction) => {
    if (view.draft) {
      onDraftWorktreeChange?.(action === "own-worktree");
      return;
    }
    if (!sessionId) return;
    if (action === "discard") {
      setConfirmDiscard(true);
      focusAfter.current = "keep";
      return;
    }
    void run(action, sessionId);
  };
  const disabledReason = busy ? BUSY_REASON : undefined;
  return (
    <>
      <dt className="text-fg-faint">Folder</dt>
      <dd
        ref={rowRef}
        className="min-w-0 text-fg"
        data-testid="chat-folder"
        data-folder-kind={view.kind}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={`min-w-0 truncate ${view.kind === "pending" ? "text-fg-faint" : ""}`}
          >
            {view.value}
          </span>
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
              {changed
                ? `Discard ${changed} changed ${changed === 1 ? "file" : "files"} with this chat's worktree?`
                : "Discard this chat's worktree?"}{" "}
              The chat continues in the project folder.
            </p>
            <div className="flex gap-3">
              <PendingButton
                type="button"
                pending={pending === "discard"}
                pendingLabel={PENDING_LABELS.discard}
                disabled={Boolean(disabledReason)}
                data-disabled-reason={disabledReason}
                className="cursor-pointer text-danger hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-50"
                onClick={() => void run("discard", sessionId)}
              >
                Discard
              </PendingButton>
              <button
                ref={keepRef}
                type="button"
                disabled={pending !== null}
                data-disabled-reason={
                  pending !== null
                    ? "Wait for this action to finish"
                    : undefined
                }
                className="cursor-pointer text-fg-muted hover:text-fg hover:underline disabled:cursor-default disabled:opacity-50"
                onClick={() => {
                  setConfirmDiscard(false);
                  focusAfter.current = "discard";
                }}
              >
                Keep
              </button>
            </div>
          </div>
        ) : actions.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {actions.map((action) => (
              <PendingButton
                key={action.id}
                type="button"
                data-folder-action={action.id}
                pending={pending === action.id}
                pendingLabel={PENDING_LABELS[action.id]}
                disabled={
                  Boolean(disabledReason) ||
                  (pending !== null && pending !== action.id)
                }
                data-disabled-reason={
                  disabledReason ??
                  (pending !== null && pending !== action.id
                    ? "Wait for this action to finish"
                    : undefined)
                }
                className={`cursor-pointer hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-50 ${
                  action.danger ? "text-danger" : "text-accent"
                }`}
                onClick={() => choose(action.id)}
              >
                {action.label}
              </PendingButton>
            ))}
          </div>
        ) : null}
        {disabledReason && actions.length > 0 ? (
          <p className="mt-1 break-normal text-fg-faint">{disabledReason}</p>
        ) : null}
        <p
          ref={statusRef}
          role="status"
          tabIndex={-1}
          className={`break-normal text-fg-faint ${status ? "mt-1.5" : ""}`}
        >
          {status}
        </p>
        <p
          role="alert"
          className={`break-normal text-danger ${error ? "mt-1.5" : ""}`}
        >
          {error}
        </p>
      </dd>
    </>
  );
}
