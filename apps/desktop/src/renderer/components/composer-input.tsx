import type { AgentChatAttachment } from "@catamorphic/react";
import {
  type AnimationEvent,
  type ClipboardEvent,
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  PILL_ATTR,
  type SerializedComposer,
  serializeComposer,
} from "../lib/composer-serialize";
import { ContextPill } from "./context-pill";

/**
 * The chat composer's input: a contenteditable that holds prose and
 * inline context pills (pastes, selections, links, paths, tabs, images,
 * documents) in one flow — "look at ⟨sel.md · 3–10⟩ and fix ⟨shot.png⟩".
 *
 * Design:
 * - Chromium owns the text (typing, IME, undo, selection). The DOM is the
 *   source of truth; {@link serializeComposer} reads it back on every
 *   input event.
 * - A pill is a `contenteditable=false` host span the editor treats as one
 *   atomic character, and a React portal renders the {@link ContextPill}
 *   into it. Hosts are inserted with `execCommand("insertHTML")` so they
 *   ride Chromium's undo stack like typed text; a natively deleted host
 *   (select-all + delete, undo) is noticed on the next input event and its
 *   pill state dropped — and a host undo brings BACK is revived, because
 *   attachments are remembered by id until the composer clears.
 * - Removal is animated: ✕ or Backspace/Delete against a pill marks it
 *   exiting, pill-out plays, then the host leaves the DOM. An exiting pill
 *   never ships.
 * - Recall (↑/↓) swaps the prose and keeps the pills.
 */

export type ComposerAttachment = AgentChatAttachment & { id: string };

export interface ComposerState {
  /** Prose without markers — what the draft says. */
  text: string;
  /** Live (non-exiting) pills. */
  pillCount: number;
}

export interface ComposerInputHandle {
  focus(): void;
  element(): HTMLDivElement | null;
  /** Insert pills at the caret (or the end when the caret is elsewhere). */
  insertPills(
    attachments: ComposerAttachment[],
    opts?: { at?: { x: number; y: number } },
  ): void;
  /** Insert plain text at the caret (undoable, like typing). */
  insertText(text: string): void;
  /** Swap the prose, keep the pills (history recall). Caret lands at end. */
  replaceText(text: string): void;
  /** The wire shape: prose with markers + attachments in marker order. */
  read(): SerializedComposer<AgentChatAttachment>;
  /** Drop everything (after send). */
  clear(): void;
  /** Animate the newest live pill out; false when there is none. */
  removeLastPill(): boolean;
  /** Ids of live pills, in document order. */
  livePillIds(): string[];
}

export interface ComposerInputProps {
  placeholder: string;
  ariaLabel: string;
  /** Layout classes for the height-animated frame around the editable. */
  wrapperClassName?: string;
  className?: string;
  onChange: (state: ComposerState) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onAnimationEnd?: (event: AnimationEvent<HTMLDivElement>) => void;
  /** Tab pills open their tab on click. */
  onOpenTab?: (key: string) => void;
  /** Server-side cap, mirrored: inserts past it are dropped. */
  maxPills?: number;
}

interface PillEntry {
  id: string;
  attachment: ComposerAttachment;
  host: HTMLElement;
  exiting: boolean;
}

const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/g;

/** Put the caret at the end of the editable. */
function caretToEnd(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Delete a pill host through the editing stack (so ⌘Z brings it back),
 * keeping the user's caret where it was. Falls back to a plain removal
 * when the editable isn't focused or the command is refused.
 */
function removeHost(root: HTMLElement, host: HTMLElement) {
  if (!host.isConnected) return;
  const selection = window.getSelection();
  const focused = document.activeElement === root;
  const saved =
    focused && selection && selection.rangeCount > 0
      ? selection.getRangeAt(0).cloneRange()
      : null;
  if (!focused || !selection) {
    host.remove();
    return;
  }
  const range = document.createRange();
  range.selectNode(host);
  // The space inserted after the pill goes with it, so "see ⟨pill⟩ tail"
  // reads "see tail", not "see  tail".
  const next = host.nextSibling;
  if (
    next?.nodeType === Node.TEXT_NODE &&
    /^[ \u00a0]/.test(next.nodeValue ?? "")
  ) {
    range.setEnd(next, 1);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  const deleted = document.execCommand("delete");
  if (!deleted && host.isConnected) host.remove();
  if (saved) {
    try {
      selection.removeAllRanges();
      selection.addRange(saved);
    } catch {
      caretToEnd(root);
    }
  }
}

/** Make sure edits land in the editable: focus it, caret inside it. */
function claimSelection(root: HTMLElement, at?: { x: number; y: number }) {
  if (document.activeElement !== root) root.focus();
  const selection = window.getSelection();
  if (at) {
    const range = document.caretRangeFromPoint(at.x, at.y);
    if (range && root.contains(range.startContainer) && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }
  const anchor = selection?.anchorNode;
  if (!anchor || !root.contains(anchor)) caretToEnd(root);
}

/** The pill host: what `insertHTML` inserts and the portal fills. */
const hostHtml = (id: string) =>
  `<span ${PILL_ATTR}="${id}" contenteditable="false" class="cat-pill-host"></span>`;

export const ComposerInput = forwardRef<
  ComposerInputHandle,
  ComposerInputProps
>(function ComposerInput(
  {
    placeholder,
    ariaLabel,
    wrapperClassName = "",
    className = "",
    onChange,
    onKeyDown,
    onPaste,
    onAnimationEnd,
    onOpenTab,
    maxPills = 32,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Attachments by id — kept (not pruned on native deletion) so an undo
  // that brings a host back finds its pill again. Cleared with the draft.
  const attachmentsRef = useRef(new Map<string, ComposerAttachment>());
  const exitingRef = useRef(new Set<string>());
  const [pills, setPills] = useState<PillEntry[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const resolve = useCallback((id: string) => {
    if (exitingRef.current.has(id)) return null;
    return attachmentsRef.current.get(id) ?? null;
  }, []);

  const read = useCallback((): SerializedComposer<AgentChatAttachment> => {
    const root = rootRef.current;
    if (!root) return { message: "", attachments: [], text: "" };
    const raw = serializeComposer(root, resolve);
    return {
      ...raw,
      attachments: raw.attachments.map(({ id: _id, ...rest }) => rest),
    };
  }, [resolve]);

  /** Re-derive pill state from the DOM and tell the parent what changed. */
  const sync = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const hosts = [...root.querySelectorAll<HTMLElement>(`[${PILL_ATTR}]`)];
    setPills((previous) => {
      const next: PillEntry[] = [];
      for (const host of hosts) {
        const id = host.getAttribute(PILL_ATTR) ?? "";
        const attachment = attachmentsRef.current.get(id);
        if (!attachment) {
          // A host we don't know (a foreign paste, a stale undo): gone.
          host.remove();
          continue;
        }
        next.push({
          id,
          attachment,
          host,
          exiting: exitingRef.current.has(id),
        });
      }
      const same =
        previous.length === next.length &&
        previous.every(
          (entry, index) =>
            entry.id === next[index]?.id &&
            entry.host === next[index]?.host &&
            entry.exiting === next[index]?.exiting,
        );
      return same ? previous : next;
    });
    const state = serializeComposer(root, resolve);
    const empty = state.message === "" && state.attachments.length === 0;
    root.toggleAttribute("data-empty", empty);
    onChangeRef.current({
      text: state.text,
      pillCount: state.attachments.length,
    });
  }, [resolve]);

  const removePill = useCallback(
    (id: string) => {
      if (exitingRef.current.has(id)) return;
      exitingRef.current.add(id);
      sync();
    },
    [sync],
  );

  const dropExited = useCallback(
    (id: string) => {
      const entry = pills.find((pill) => pill.id === id);
      const root = rootRef.current;
      exitingRef.current.delete(id);
      if (entry && root) removeHost(root, entry.host);
      // The attachment stays known: an undo that brings the host back
      // (removal goes through the editing stack) revives the pill.
      sync();
    },
    [pills, sync],
  );

  const insertPills = useCallback(
    (
      attachments: ComposerAttachment[],
      opts?: { at?: { x: number; y: number } },
    ) => {
      const root = rootRef.current;
      if (!root || attachments.length === 0) return;
      const live = read().attachments.length;
      const room = Math.max(0, maxPills - live);
      const accepted = attachments.slice(0, room);
      if (accepted.length === 0) return;
      for (const attachment of accepted) {
        attachmentsRef.current.set(attachment.id, attachment);
      }
      claimSelection(root, opts?.at);
      // One insertHTML per batch: one undo step, hosts + a trailing space
      // each so typing continues naturally after the token.
      const html = accepted
        .map((attachment) => `${hostHtml(attachment.id)} `)
        .join("");
      const inserted = document.execCommand("insertHTML", false, html);
      if (!inserted) {
        // execCommand refused (no selection in an editable): append.
        for (const attachment of accepted) {
          const template = document.createElement("template");
          template.innerHTML = `${hostHtml(attachment.id)} `;
          root.append(...template.content.childNodes);
        }
        caretToEnd(root);
      }
      sync();
    },
    [maxPills, read, sync],
  );

  const insertText = useCallback(
    (text: string) => {
      if (!text) return;
      const root = rootRef.current;
      if (!root) return;
      claimSelection(root);
      if (!document.execCommand("insertText", false, text)) {
        root.append(document.createTextNode(text));
        caretToEnd(root);
      }
      sync();
    },
    [sync],
  );

  const replaceText = useCallback(
    (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      const hosts = [...root.querySelectorAll<HTMLElement>(`[${PILL_ATTR}]`)];
      const spacer = hosts.length > 0 && text ? " " : "";
      root.replaceChildren(
        ...hosts,
        ...(text || spacer
          ? [document.createTextNode(`${spacer}${text}`)]
          : []),
      );
      caretToEnd(root);
      sync();
    },
    [sync],
  );

  const clear = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren();
    attachmentsRef.current.clear();
    exitingRef.current.clear();
    sync();
  }, [sync]);

  const livePillIds = useCallback(() => {
    const root = rootRef.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>(`[${PILL_ATTR}]`)]
      .map((host) => host.getAttribute(PILL_ATTR) ?? "")
      .filter((id) => id && !exitingRef.current.has(id));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => rootRef.current?.focus(),
      element: () => rootRef.current,
      insertPills,
      insertText,
      replaceText,
      read,
      clear,
      removeLastPill: () => {
        const last = livePillIds().at(-1);
        if (!last) return false;
        removePill(last);
        return true;
      },
      livePillIds,
    }),
    [
      insertPills,
      insertText,
      replaceText,
      read,
      clear,
      livePillIds,
      removePill,
    ],
  );

  // Initial state: empty, placeholder on.
  useEffect(() => {
    sync();
  }, [sync]);

  /**
   * Backspace/Delete against a pill removes it with animation instead
   * of letting Chromium yank the node. Only for a collapsed caret whose
   * neighbour (past any zero-width guards) is a host.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const backward = event.key === "Backspace";
    if (
      (backward || event.key === "Delete") &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.nativeEvent.isComposing
    ) {
      const host = adjacentPillHost(rootRef.current, backward);
      if (host) {
        event.preventDefault();
        const id = host.getAttribute(PILL_ATTR);
        if (id) removePill(id);
        return;
      }
    }
    onKeyDown?.(event);
  };

  // Size changes glide instead of snapping: a frame around the editable
  // tweens to the editable's measured height (Shift+Enter, a wrapping
  // pill, recall of a longer draft, growth while typing). The editable
  // itself stays auto-height (its own max-h + overflow handle scrolling);
  // the frame just follows it via ResizeObserver.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const frame = frameRef.current;
    if (!root || !frame) return;
    const follow = () => {
      const height = `${root.offsetHeight}px`;
      if (frame.style.height !== height) frame.style.height = height;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className={`overflow-hidden transition-[height] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${wrapperClassName}`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold inline pills; this contenteditable is the multiline textbox */}
      <div
        ref={rootRef}
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-composer-input
        data-placeholder={placeholder}
        data-testid="composer-input"
        className={`cat-composer whitespace-pre-wrap break-words outline-none ${className}`}
        onInput={sync}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        onAnimationEnd={onAnimationEnd}
      />
      {pills.map((pill) =>
        createPortal(
          <ContextPill
            key={pill.id}
            view={pill.attachment}
            exiting={pill.exiting}
            onRemove={() => removePill(pill.id)}
            onExited={() => dropExited(pill.id)}
            onOpen={
              onOpenTab &&
              pill.attachment.kind === "text" &&
              pill.attachment.source.type === "tab"
                ? (() => {
                    const key = pill.attachment.source.key;
                    return () => onOpenTab(key);
                  })()
                : undefined
            }
            testId="composer-pill"
          />,
          pill.host,
          pill.id,
        ),
      )}
    </div>
  );
});

/**
 * The pill host immediately before (backward) / after the collapsed caret,
 * skipping empty and zero-width text. Null when the caret isn't collapsed,
 * isn't in the editable, or has real content between it and any pill.
 */
function adjacentPillHost(
  root: HTMLElement | null,
  backward: boolean,
): HTMLElement | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  let node: Node | null = range.startContainer;
  const offset = range.startOffset;
  // Inside a text node: any real character between caret and edge means
  // ordinary deletion.
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue ?? "";
    const between = backward ? value.slice(0, offset) : value.slice(offset);
    if (between.replace(ZERO_WIDTH, "").length > 0) return null;
    node = backward ? node.previousSibling : node.nextSibling;
  } else {
    node = backward
      ? (node.childNodes[offset - 1] ?? null)
      : (node.childNodes[offset] ?? null);
  }
  // Skip zero-width / empty text, and climb out of a wrapper when the
  // caret sits at its edge (Chromium wraps lines in <div> at times).
  let cursor: Node | null = node;
  let container: Node = range.startContainer;
  for (let steps = 0; steps < 8; steps += 1) {
    if (cursor === null) {
      if (container === root || !container.parentNode) return null;
      const parent: Node = container.parentNode;
      cursor = backward ? container.previousSibling : container.nextSibling;
      container = parent;
      if (cursor === null) continue;
    }
    if (
      cursor.nodeType === Node.TEXT_NODE &&
      (cursor.nodeValue ?? "").replace(ZERO_WIDTH, "").length === 0
    ) {
      cursor = backward ? cursor.previousSibling : cursor.nextSibling;
      continue;
    }
    if (cursor instanceof HTMLElement && cursor.hasAttribute(PILL_ATTR)) {
      return cursor;
    }
    return null;
  }
  return null;
}
