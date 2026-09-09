"use client";
import type { PendingAgentTurn } from "@catamorphic/react";
import { ChevronUp, Pencil, Trash2, Zap } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

function DefaultHint({ children }: { label: string; children: ReactNode }) {
  return <>{children}</>;
}
/** How many queued messages stay visible while collapsed. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

/**
 * The outgoing queue, rendered at the end of the chat as ghost bubbles:
 * dashed, right-aligned, each editable (which pauses its dispatch),
 * deletable, or promotable ("send now" interrupts the running turn). Long
 * queues collapse behind a "N queued" toggle.
 */
export function ChatQueue({
  queue,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
  renderContent,
  renderAttachments,
  Hint = DefaultHint,
}: {
  queue: PendingAgentTurn[];
  onUpdate?: (
    id: string,
    content: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onRemove?: (id: string) => undefined | boolean | Promise<undefined | boolean>;
  onSendNow?: (
    id: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onHold?: (
    id: string | null,
  ) => undefined | boolean | Promise<undefined | boolean>;
  renderContent?: (turn: PendingAgentTurn) => ReactNode;
  renderAttachments?: (turn: PendingAgentTurn) => ReactNode;
  Hint?: ComponentType<{ label: string; children: ReactNode }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && queue.length > QUEUE_COLLAPSE_THRESHOLD;
  const visible = collapsed ? queue.slice(0, 1) : queue;
  const hidden = queue.length - visible.length;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="chat-queue">
      {visible.map((queued) => (
        <QueuedBubble
          key={queued.id}
          queued={queued}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onSendNow={onSendNow}
          onHold={onHold}
          renderContent={renderContent}
          renderAttachments={renderAttachments}
          Hint={Hint}
        />
      ))}
      {queue.length > QUEUE_COLLAPSE_THRESHOLD && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex cursor-pointer items-center gap-1 rounded-full border border-border bg-bg-inset px-2.5 py-1 text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg"
          aria-expanded={!collapsed}
          data-testid="chat-queue-toggle"
        >
          {collapsed ? `+${hidden} more queued` : "Collapse queue"}
          <ChevronUp
            className={`size-3 transition-transform duration-150 ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      )}
    </div>
  );
}

function QueuedBubble({
  queued,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
  renderContent,
  renderAttachments,
  Hint = DefaultHint,
}: {
  queued: PendingAgentTurn;
  onUpdate?: (
    id: string,
    content: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onRemove?: (id: string) => undefined | boolean | Promise<undefined | boolean>;
  onSendNow?: (
    id: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onHold?: (
    id: string | null,
  ) => undefined | boolean | Promise<undefined | boolean>;
  renderContent?: (turn: PendingAgentTurn) => ReactNode;
  renderAttachments?: (turn: PendingAgentTurn) => ReactNode;
  Hint?: ComponentType<{ label: string; children: ReactNode }>;
}) {
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queued.content);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Refs, not deps: the callbacks are re-created every host render, and an
  // effect keyed on them would run its cleanup constantly — releasing the
  // hold the moment it was taken.
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const editingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (editing && !saving) editRef.current?.focus();
  }, [editing, saving]);
  // True unmount only: if this bubble disappears mid-edit, never leave the
  // queue paused — but don't touch holds owned by other bubbles.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(removeTimer.current);
      if (editingRef.current) void onHoldRef.current?.(null);
    };
  }, []);

  const attempt = async (
    action: () => undefined | boolean | Promise<undefined | boolean>,
  ) => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setActionError(null);
    try {
      const result = await action();
      if (result === false)
        setActionError("The change was not saved. Try again.");
      return result !== false;
    } catch {
      setActionError("The change was not saved. Try again.");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const beginEdit = async () => {
    if (savingRef.current) return;
    editingRef.current = true;
    if (!(await attempt(() => onHold?.(queued.id)))) {
      editingRef.current = false;
      return;
    }
    if (!mountedRef.current) return;
    setDraft(queued.content);
    setEditing(true);
  };
  const commitEdit = async () => {
    const content = draft.trim();
    const saved = await attempt(() =>
      content && content !== queued.content
        ? onUpdate?.(queued.id, content)
        : onHold?.(null),
    );
    if (saved) {
      setEditing(false);
      editingRef.current = false;
    } else editRef.current?.focus();
  };
  const cancelEdit = async () => {
    if (!(await attempt(() => onHold?.(null)))) return;
    setDraft(queued.content);
    setEditing(false);
    editingRef.current = false;
  };
  const remove = () => {
    // Animate out, then actually delete.
    setLeaving(true);
    removeTimer.current = setTimeout(() => {
      void attempt(() => onRemove?.(queued.id)).then((removed) => {
        if (removed) {
          editingRef.current = false;
          setEditing(false);
        }
        // The server owns removal; rejected requests stay actionable.
        setLeaving(false);
      });
    }, 200);
  };

  const shown = entered && !leaving;
  return (
    <div
      className={`group/queued relative max-w-[85%] motion-safe:transition-[opacity,translate,scale] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"}`}
      data-testid="chat-queued-message"
    >
      <div className="rounded-xl rounded-br-sm border border-dashed border-info/40 bg-info/5 px-3 py-2 text-sm text-fg-muted">
        {editing ? (
          <textarea
            ref={editRef}
            className="field-sizing-content w-full min-w-48 resize-none bg-transparent leading-6 text-fg outline-none"
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              // Chromium can briefly drop focus to nowhere while the
              // timeline settles a streamed turn. That is not a user commit:
              // keep the edit and queue hold intact. A real focus target,
              // Enter, or Escape still completes the edit normally.
              if (event.relatedTarget === null) {
                requestAnimationFrame(() => editRef.current?.focus());
                return;
              }
              commitEdit();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                commitEdit();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                void cancelEdit();
              }
            }}
            aria-label="Edit queued message"
            data-testid="chat-queued-edit"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words leading-6">
            {renderContent ? renderContent(queued) : queued.content}
          </div>
        )}
        {renderAttachments
          ? renderAttachments(queued)
          : queued.attachments.length > 0 && (
              <p className="mt-1 text-xs">
                {queued.attachments.length} attachment(s)
              </p>
            )}
        {actionError && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {actionError}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
          Queued
          <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100">
            {!editing && (
              <Hint label="Edit before it sends">
                <button
                  type="button"
                  onClick={() => void beginEdit()}
                  disabled={saving}
                  className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                  aria-label="Edit queued message"
                >
                  <Pencil className="size-3" />
                </button>
              </Hint>
            )}
            <Hint label="Delete from queue">
              <button
                type="button"
                onClick={remove}
                disabled={saving || leaving}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-danger"
                aria-label="Delete queued message"
                data-testid="chat-queued-delete"
              >
                <Trash2 className="size-3" />
              </button>
            </Hint>
            <Hint label="Send now (interrupts the agent)">
              <button
                type="button"
                onClick={() => void attempt(() => onSendNow?.(queued.id))}
                disabled={saving}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-accent"
                aria-label="Send queued message now"
                data-testid="chat-queued-send-now"
              >
                <Zap className="size-3" />
              </button>
            </Hint>
          </span>
        </div>
      </div>
    </div>
  );
}
