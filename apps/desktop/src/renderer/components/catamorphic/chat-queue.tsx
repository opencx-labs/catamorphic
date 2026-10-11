"use client";
import {
  type AgentAttachment,
  ATTACHMENT_MARKER,
  messageWithAttachmentNames,
  type QueuedMessage,
} from "@catamorphic/react";
import { ChevronUp, Pencil, Trash2, Zap } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

/** What a host action resolves to: false keeps the control actionable. */
type ActionResult = undefined | boolean | Promise<undefined | boolean>;

/** A control's name, and its keyboard shortcut when it has one. */
export interface HintProps {
  label: string;
  /** Display form of the shortcut, e.g. "⌘B". */
  shortcut?: string;
  children: ReactNode;
}

/** How a host names its controls on hover: a tooltip of its own. */
export type HintComponent = ComponentType<HintProps>;

/** The default hint: the browser's own tooltip. */
export function TitleHint({ label, shortcut, children }: HintProps) {
  return (
    <span
      className="contents"
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {children}
    </span>
  );
}

/** How many queued messages stay visible while collapsed. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

/** A queued message's draft: its words, each attachment named where it sits. */
function editableText(queued: QueuedMessage): string {
  return queued.item?.kind === "user_message"
    ? messageWithAttachmentNames(queued.item.text, queued.item.attachments)
    : "";
}

/**
 * A draft's attachment names back as the attachments, in order, so each
 * stays where the person left it; a name they removed comes back at the end.
 */
function withAttachmentMarkers(
  draft: string,
  attachments: readonly AgentAttachment[],
): string {
  let text = draft;
  let from = 0;
  for (const attachment of attachments) {
    const name = `[${attachment.name}]`;
    const at = text.indexOf(name, from);
    if (at === -1) continue;
    text = text.slice(0, at) + ATTACHMENT_MARKER + text.slice(at + name.length);
    from = at + ATTACHMENT_MARKER.length;
  }
  return text;
}

/**
 * The session's turn queue (ADR 0197), rendered at the end of the chat.
 * The person's own messages are ghost bubbles: dashed, right-aligned, each
 * editable (which holds the turn so it does not start under the cursor),
 * cancellable, or promotable ("send now" stops the running turn and runs
 * this one). What another agent, a workflow or Work queued (ADR 0217) is
 * one quiet line on the left, withdrawn or run now but never edited;
 * `renderInput` draws it. Long queues collapse behind a "N queued" toggle.
 * Callbacks take the turn id: wire them to `useAgentChat`'s `editQueued`,
 * `cancelQueued`, `sendQueuedNow` and `holdQueued`.
 */
export function ChatQueue({
  queue,
  onEdit,
  onCancel,
  onSendNow,
  onHold,
  renderContent,
  renderAttachments,
  renderInput,
  Hint = TitleHint,
}: {
  queue: QueuedMessage[];
  onEdit?: (turnId: string, text: string) => ActionResult;
  onCancel?: (turnId: string) => ActionResult;
  onSendNow?: (turnId: string) => ActionResult;
  onHold?: (turnId: string | null) => ActionResult;
  renderContent?: (queued: QueuedMessage) => ReactNode;
  renderAttachments?: (queued: QueuedMessage) => ReactNode;
  /** One line for a waiting turn that is not the person's own message. */
  renderInput?: (queued: QueuedMessage) => ReactNode;
  /** Names each control on hover; defaults to the browser's tooltip. */
  Hint?: HintComponent;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && queue.length > QUEUE_COLLAPSE_THRESHOLD;
  const visible = collapsed ? queue.slice(0, 1) : queue;
  const hidden = queue.length - visible.length;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="chat-queue">
      {visible.map((queued) =>
        queued.item?.kind === "user_message" ? (
          <QueuedBubble
            key={queued.turn.id}
            queued={queued}
            onEdit={onEdit}
            onCancel={onCancel}
            onSendNow={onSendNow}
            onHold={onHold}
            renderContent={renderContent}
            renderAttachments={renderAttachments}
            Hint={Hint}
          />
        ) : (
          <QueuedInput
            key={queued.turn.id}
            queued={queued}
            onCancel={onCancel}
            onSendNow={onSendNow}
            renderInput={renderInput}
            Hint={Hint}
          />
        ),
      )}
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

/** A waiting turn someone other than the person queued: one quiet line. */
function QueuedInput({
  queued,
  onCancel,
  onSendNow,
  renderInput,
  Hint,
}: {
  queued: QueuedMessage;
  onCancel?: (turnId: string) => ActionResult;
  onSendNow?: (turnId: string) => ActionResult;
  renderInput?: (queued: QueuedMessage) => ReactNode;
  Hint: HintComponent;
}) {
  const turnId = queued.turn.id;
  const [busy, setBusy] = useState(false);
  const act = async (action?: (turnId: string) => ActionResult) => {
    if (!action || busy) return;
    setBusy(true);
    try {
      await action(turnId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="group/queued flex min-w-0 max-w-[85%] items-center gap-2 self-start rounded-lg border border-dashed border-border px-2 py-1 text-xs text-fg-muted"
      data-testid="chat-queued-input"
      data-turn-id={turnId}
    >
      <span className="min-w-0 flex-1">
        {renderInput ? (
          renderInput(queued)
        ) : (
          <span className="block truncate">
            {queued.item?.kind === "task_notification"
              ? queued.item.summary
              : (queued.item?.text ?? "Carry on where it stopped")}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-fg-faint">
        {queued.turn.status === "held" ? "Held" : "Queued"}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100 pointer-coarse:opacity-100">
        {onCancel && (
          <Hint label="Remove from queue">
            <button
              type="button"
              onClick={() => void act(onCancel)}
              disabled={busy}
              className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-danger"
              aria-label="Remove from queue"
              data-testid="chat-queued-delete"
            >
              <Trash2 className="size-3" />
            </button>
          </Hint>
        )}
        {onSendNow && (
          <Hint label="Run now (stops the agent)">
            <button
              type="button"
              onClick={() => void act(onSendNow)}
              disabled={busy}
              className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-accent"
              aria-label="Run now"
              data-testid="chat-queued-send-now"
            >
              <Zap className="size-3" />
            </button>
          </Hint>
        )}
      </span>
    </div>
  );
}

function QueuedBubble({
  queued,
  onEdit,
  onCancel,
  onSendNow,
  onHold,
  renderContent,
  renderAttachments,
  Hint,
}: {
  queued: QueuedMessage;
  onEdit?: (turnId: string, text: string) => ActionResult;
  onCancel?: (turnId: string) => ActionResult;
  onSendNow?: (turnId: string) => ActionResult;
  onHold?: (turnId: string | null) => ActionResult;
  renderContent?: (queued: QueuedMessage) => ReactNode;
  renderAttachments?: (queued: QueuedMessage) => ReactNode;
  Hint: HintComponent;
}) {
  const turnId = queued.turn.id;
  const text = editableText(queued);
  const attachments =
    queued.item?.kind === "user_message" ? queued.item.attachments : [];
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Refs, not deps: the callbacks are re-created every host render, and an
  // effect keyed on them would run its cleanup constantly, releasing the
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
  // turn held, but don't touch holds owned by other bubbles.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(removeTimer.current);
      if (editingRef.current) void onHoldRef.current?.(null);
    };
  }, []);

  const attempt = async (action: () => ActionResult) => {
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
    if (!(await attempt(() => onHold?.(turnId)))) {
      editingRef.current = false;
      return;
    }
    if (!mountedRef.current) return;
    setDraft(text);
    setEditing(true);
  };
  const commitEdit = async () => {
    const content = withAttachmentMarkers(draft.trim(), attachments);
    const sent =
      queued.item?.kind === "user_message" ? queued.item.text.trim() : "";
    const saved = await attempt(() =>
      content && content !== sent ? onEdit?.(turnId, content) : onHold?.(null),
    );
    if (saved) {
      setEditing(false);
      editingRef.current = false;
    } else editRef.current?.focus();
  };
  const cancelEdit = async () => {
    if (!(await attempt(() => onHold?.(null)))) return;
    setDraft(text);
    setEditing(false);
    editingRef.current = false;
  };
  const remove = () => {
    // Animate out, then actually withdraw it.
    setLeaving(true);
    removeTimer.current = setTimeout(() => {
      void attempt(() => onCancel?.(turnId)).then((removed) => {
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
      data-turn-id={turnId}
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
              // keep the edit and the hold intact. A real focus target,
              // Enter, or Escape still completes the edit normally.
              if (event.relatedTarget === null) {
                requestAnimationFrame(() => editRef.current?.focus());
                return;
              }
              void commitEdit();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void commitEdit();
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
            {renderContent
              ? renderContent(queued)
              : messageWithAttachmentNames(
                  queued.item?.kind === "user_message" ? queued.item.text : "",
                  attachments,
                )}
          </div>
        )}
        {renderAttachments?.(queued)}
        {/* The draft names each attachment where it sits; all of them stay. */}
        {editing && attachments.length > 0 && (
          <p className="mt-1 text-xs">
            {attachments.length === 1
              ? "1 attachment stays with it"
              : `${attachments.length} attachments stay with it`}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {actionError}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
          {queued.turn.status === "held" && !editing ? "Held" : "Queued"}
          <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100 pointer-coarse:opacity-100">
            {!editing && onEdit && (
              <Hint label="Edit before it sends">
                <button
                  type="button"
                  onClick={() => void beginEdit()}
                  disabled={saving}
                  className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                  aria-label="Edit queued message"
                  data-testid="chat-queued-edit-button"
                >
                  <Pencil className="size-3" />
                </button>
              </Hint>
            )}
            {onCancel && (
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
            )}
            {onSendNow && (
              <Hint label="Send now (stops the agent)">
                <button
                  type="button"
                  onClick={() => void attempt(() => onSendNow(turnId))}
                  disabled={saving}
                  className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-accent"
                  aria-label="Send queued message now"
                  data-testid="chat-queued-send-now"
                >
                  <Zap className="size-3" />
                </button>
              </Hint>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
