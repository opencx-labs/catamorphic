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
  useLayoutEffect,
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

/** How long a bubble's place waits for what takes it over. */
const HANDOVER_MS = 1_000;

/**
 * Where a message's bubble last was as it changed hands, by key: a sent
 * message's pending bubble (`send:<command>`) taken over by its queued
 * bubble, and a queued bubble (`item:<id>`) taken over by the sent message
 * once its turn starts. What takes over arrives from there, already shown,
 * instead of rising in anew somewhere else.
 */
const handovers = new Map<string, { rect: DOMRect; at: number }>();

/** Where the bubble with this key last was, if it just changed hands. */
export function handoverFrom(key: string): DOMRect | undefined {
  const entry = handovers.get(key);
  return entry && performance.now() - entry.at <= HANDOVER_MS
    ? entry.rect
    : undefined;
}

/** What took over has taken the bubble's place. */
export function forgetHandover(key: string): void {
  handovers.delete(key);
}

/** A bubble leaving: where it was, for what takes it over. */
export function recordHandover(key: string, rect: DOMRect): void {
  const now = performance.now();
  for (const [id, entry] of handovers)
    if (now - entry.at > HANDOVER_MS) handovers.delete(id);
  handovers.set(key, { rect, at: now });
}

/** The command a person's message was sent with, from its idempotency key. */
export function sentWith(item: {
  idempotencyKey: string | null;
}): string | undefined {
  return item.idempotencyKey?.match(/^user:[^:]*:(.+)$/)?.[1];
}

/** A hand-over's glide, on the standard easing. */
const GLIDE_MS = 250;

/**
 * Glides `element` from where its bubble was (`from`) to where it is, for
 * what took a bubble over. Both sit at the conversation's right edge, words
 * at the top. Nothing moves when motion is reduced.
 */
export function glideFrom(element: HTMLElement, from: DOMRect): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const now = element.getBoundingClientRect();
  const dx = from.right - now.right;
  const dy = from.top - now.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  element.animate(
    [{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }],
    { duration: GLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  );
}

/**
 * A queued message's controls: they slide out of its label on hover or
 * focus (always shown on a touch screen, where nothing hovers).
 */
const QUEUED_ACTIONS =
  "flex items-center gap-0.5 opacity-0 translate-x-1 transition-[opacity,translate] duration-150 ease-[cubic-bezier(0.2,0,0,1)] group-hover/queued:opacity-100 group-hover/queued:translate-x-0 group-focus-within/queued:opacity-100 group-focus-within/queued:translate-x-0 pointer-coarse:opacity-100 pointer-coarse:translate-x-0";

/** One control: its colour and a soft ground ease in under the pointer. */
const QUEUED_BUTTON =
  "grid size-5 cursor-pointer place-items-center rounded-md text-fg-faint transition-[color,background-color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-90 disabled:cursor-default disabled:opacity-50";

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
      <span className={`shrink-0 ${QUEUED_ACTIONS}`}>
        {onCancel && (
          <Hint label="Remove from queue">
            <button
              type="button"
              onClick={() => void act(onCancel)}
              disabled={busy}
              className={`${QUEUED_BUTTON} hover:bg-danger/10 hover:text-danger`}
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
              className={`${QUEUED_BUTTON} hover:bg-accent/10 hover:text-accent`}
              aria-label="Run now"
              data-testid="chat-queued-send-now"
            >
              <Zap className="size-3" />
            </button>
          </Hint>
        )}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-fg-faint">
        {queued.turn.status === "held" ? "Held" : "Queued"}
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
  // Sent now, here or with ⌘↵ (an interrupting turn): it looks sent while
  // the agent stops, then its message takes its place (handoverFrom).
  const [sending, setSending] = useState(false);
  const sent = sending || queued.turn.dispatch === "interrupt";
  const bubbleRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef(false);
  leavingRef.current = leaving;
  const itemId = queued.item?.id;
  const command =
    queued.item?.kind === "user_message" ? sentWith(queued.item) : undefined;
  // Taking over from the message's pending bubble, it arrives from there.
  const [takeover, setTakeover] = useState<DOMRect | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Mount only: read in the commit, once the pending bubble has left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useLayoutEffect(() => {
    const from = command ? handoverFrom(`send:${command}`) : undefined;
    if (!command || !from) return;
    forgetHandover(`send:${command}`);
    setTakeover(from);
  }, []);
  useLayoutEffect(() => {
    if (takeover && bubbleRef.current) glideFrom(bubbleRef.current, takeover);
  }, [takeover]);
  // Leaving the queue because its turn started (sent now, or the queue
  // drained), not because the person deleted it: where it was is where its
  // message arrives from. Read before the bubble leaves the page.
  useLayoutEffect(
    () => () => {
      const bubble = bubbleRef.current;
      if (bubble && itemId && !leavingRef.current)
        recordHandover(`item:${itemId}`, bubble.getBoundingClientRect());
    },
    [itemId],
  );
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

  const sendNow = async () => {
    if (!onSendNow) return;
    setSending(true);
    if (!(await attempt(() => onSendNow(turnId))) && mountedRef.current)
      setSending(false);
  };

  const shown = (entered || takeover !== null) && !leaving;
  return (
    <div
      className={`group/queued relative max-w-[85%] ${
        // Taking over, it is already shown: no entrance to play.
        takeover && !leaving
          ? ""
          : "motion-safe:transition-[opacity,translate,scale] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]"
      } ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"}`}
      data-testid="chat-queued-message"
      data-turn-id={turnId}
      data-sending={sent || undefined}
    >
      <div
        ref={bubbleRef}
        // Sending, it takes the sent message's look at once: its message
        // then arrives looking the same, where the bubble was.
        className={`rounded-xl rounded-br-sm border px-3 py-2 text-sm transition-[background-color,border-color,color] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          sent
            ? "border-info/30 bg-info/10 text-fg"
            : "border-dashed border-info/40 bg-info/5 text-fg-muted"
        }`}
      >
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
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wider text-fg-faint">
          {/* Sending, it can still be withdrawn: the agent may take a while
              to stop, and the turn stays queued until it does. */}
          {(!sent || onCancel) && (
            <span className={QUEUED_ACTIONS}>
              {!sent && !editing && onEdit && (
                <Hint label="Edit before it sends">
                  <button
                    type="button"
                    onClick={() => void beginEdit()}
                    disabled={saving}
                    className={`${QUEUED_BUTTON} hover:bg-bg-overlay hover:text-fg`}
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
                    className={`${QUEUED_BUTTON} hover:bg-danger/10 hover:text-danger`}
                    aria-label="Delete queued message"
                    data-testid="chat-queued-delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </Hint>
              )}
              {!sent && onSendNow && (
                <Hint label="Send now (stops the agent)">
                  <button
                    type="button"
                    onClick={() => void sendNow()}
                    disabled={saving}
                    className={`${QUEUED_BUTTON} hover:bg-accent/10 hover:text-accent`}
                    aria-label="Send queued message now"
                    data-testid="chat-queued-send-now"
                  >
                    <Zap className="size-3" />
                  </button>
                </Hint>
              )}
            </span>
          )}
          <span data-testid="chat-queued-state">
            {sent
              ? "Sending"
              : queued.turn.status === "held" && !editing
                ? "Held"
                : "Queued"}
          </span>
        </div>
      </div>
    </div>
  );
}
