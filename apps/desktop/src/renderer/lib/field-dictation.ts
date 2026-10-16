/**
 * Dictation's words written into the text field the person is in (ADR
 * 0236): an input, a text area or an editable element, in Work's windows
 * and in web pages alike. Each page runs this once; the main process
 * sends the words to the page whose field had focus last.
 *
 * While the person talks, the words so far show at the caret and change
 * as recognition firms up: in inputs and text areas, and in editors that
 * ask for it (`data-dictation-preview`, the chat composer). Other editors
 * keep their own document model, so they get each stretch once it is
 * said. The words said go in as typing does: one undo step, an input
 * event the page hears, the caret after them. Words still showing that
 * the person or the page removed (a message sent) are gone for good.
 */

import type { VoiceDictation } from "../../shared/voice.js";

/** Where the words still being said show, inside an editor. */
export const DICTATION_ATTR = "data-dictation";
/** An editor that shows the words while they are said. */
export const DICTATION_PREVIEW_ATTR = "data-dictation-preview";

const ZERO_WIDTH = /​|‌|‍|﻿/g;
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", ""]);

type ValueField = HTMLInputElement | HTMLTextAreaElement;

/**
 * The text field an element is, or belongs to; null for anything else.
 * Not a password or a number: dictated words never belong there.
 */
export function textFieldOf(element: Element | null): HTMLElement | null {
  if (element instanceof HTMLTextAreaElement)
    return element.disabled || element.readOnly ? null : element;
  if (element instanceof HTMLInputElement)
    return element.disabled ||
      element.readOnly ||
      !TEXT_INPUTS.has(element.type)
      ? null
      : element;
  if (!(element instanceof HTMLElement) || !element.isContentEditable)
    return null;
  let host = element;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

function isValueField(field: HTMLElement): field is ValueField {
  return (
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
  );
}

/** Text spaced from the character before it: a stretch is a sentence. */
function spaced(before: string | undefined, text: string): string {
  return before === undefined || /\s/.test(before) ? text : ` ${text}`;
}

/** Tells the field its text changed, as typing would. */
function changed(field: HTMLElement, data: string) {
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data }),
  );
}

/** The words of the stretch under way, as they show in their field. */
type Shown =
  | { segment: number; field: ValueField; start: number; text: string }
  | { segment: number; field: HTMLElement; node: HTMLElement };

/** Dictation into one page's text fields. */
export class FieldDictation {
  private shown: Shown | null = null;
  /** Stretches settled: their words are in, or were taken away. */
  private through = 0;

  /** The field the words still being said show in, if any. */
  get showing(): HTMLElement | null {
    return this.shown?.field ?? null;
  }

  apply(field: HTMLElement, words: VoiceDictation): void {
    if (words.segment <= this.through) return;
    // Another stretch, or another field: what showed is the person's.
    if (
      this.shown &&
      (this.shown.segment !== words.segment || this.shown.field !== field)
    ) {
      this.settle();
      if (words.segment <= this.through) return;
    }
    if (isValueField(field)) this.applyToValue(field, words);
    else this.applyToEditor(field, words);
  }

  /**
   * The person took over the words still showing: they typed, moved the
   * caret, or went to another field. What showed stays as plain text, and
   * the rest of that stretch is theirs, as in other apps.
   */
  settle(): void {
    const shown = this.shown;
    if (!shown) return;
    this.shown = null;
    this.through = Math.max(this.through, shown.segment);
    if (!("node" in shown) || !shown.node.isConnected) return;
    const text = shown.node.textContent ?? "";
    shown.node.replaceWith(shown.node.ownerDocument.createTextNode(text));
    changed(shown.field, text);
  }

  private applyToValue(
    field: ValueField,
    { segment, text, final }: VoiceDictation,
  ): void {
    const shown = this.shown && "start" in this.shown ? this.shown : null;
    let start = field.selectionStart ?? field.value.length;
    let end = field.selectionEnd ?? start;
    if (shown) {
      // Removed while showing (a message sent): the stretch is over.
      if (
        field.value.slice(shown.start, shown.start + shown.text.length) !==
        shown.text
      ) {
        this.shown = null;
        this.through = segment;
        return;
      }
      start = shown.start;
      end = start + shown.text.length;
    }
    if (!final) {
      const preview = spaced(field.value.slice(0, start).at(-1), text);
      field.setRangeText(preview, start, end, "end");
      this.shown = { segment, field, start, text: preview };
      changed(field, preview);
      return;
    }
    this.shown = null;
    this.through = segment;
    if (end > start) field.setRangeText("", start, end, "start");
    if (!text) {
      if (end > start) changed(field, "");
      return;
    }
    const typed = spaced(field.value.slice(0, start).at(-1), text);
    if (field.ownerDocument.activeElement === field) {
      field.setSelectionRange(start, start);
      if (field.ownerDocument.execCommand("insertText", false, typed)) return;
    }
    field.setRangeText(typed, start, start, "end");
    changed(field, typed);
  }

  private applyToEditor(
    field: HTMLElement,
    { segment, text, final }: VoiceDictation,
  ): void {
    const document = field.ownerDocument;
    const selection = document.getSelection();
    const caret =
      selection &&
      selection.rangeCount > 0 &&
      field.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const atEnd = () => {
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      return range;
    };
    const charBefore = (range: Range) => {
      const before = document.createRange();
      before.setStart(field, 0);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().replace(ZERO_WIDTH, "").at(-1);
    };
    const shown = this.shown && "node" in this.shown ? this.shown : null;
    if (shown && !shown.node.isConnected) {
      // Removed while showing (a message sent): the stretch is over.
      this.shown = null;
      this.through = segment;
      return;
    }
    if (!final) {
      if (!field.hasAttribute(DICTATION_PREVIEW_ATTR)) return;
      let node = shown?.node;
      if (!node) {
        const at = caret ?? atEnd();
        at.collapse(true);
        node = document.createElement("span");
        node.setAttribute(DICTATION_ATTR, "");
        node.setAttribute("contenteditable", "false");
        node.dataset.space = spaced(charBefore(at), "x") === "x" ? "" : " ";
        at.insertNode(node);
        this.shown = { segment, field, node };
        // The caret stays after the words, where typing carries on.
        if (caret) {
          const after = document.createRange();
          after.setStartAfter(node);
          after.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(after);
        }
      }
      node.textContent = `${node.dataset.space ?? ""}${text}`;
      changed(field, text);
      return;
    }
    this.shown = null;
    this.through = segment;
    // The words said go in where they showed, else at the caret; the
    // words shown were never typed, so undo takes back only these.
    let at = caret ?? atEnd();
    if (shown) {
      at = document.createRange();
      at.setStartBefore(shown.node);
      at.collapse(true);
      shown.node.remove();
    }
    if (!text) {
      if (shown) changed(field, "");
      return;
    }
    const typed = spaced(charBefore(at), text);
    const focused = field.contains(document.activeElement);
    if (focused) {
      selection?.removeAllRanges();
      selection?.addRange(at);
      if (document.execCommand("insertText", false, typed)) return;
    }
    const node = document.createTextNode(typed);
    at.insertNode(node);
    changed(field, typed);
  }
}

/** How a page meets the main process. */
export interface DictationPort {
  /** A text field here has focus: dictation writes into this page. */
  fieldFocused(): void;
  /** The person sent what they dictated: listening on its own ends. */
  sent(): void;
  onWords(listener: (words: VoiceDictation) => void): () => void;
}

/** The element with focus, inside shadow roots too. */
function focusedElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement)
    element = element.shadowRoot.activeElement;
  return element;
}

/**
 * An editor that keeps its own text and takes none from the page (the
 * code editor's EditContext): dictation cannot write there.
 */
function ownsItsText(element: Element | null): boolean {
  return !!element && "editContext" in element && !!element.editContext;
}

/** A field dictation can write into: there, and not shut away. */
function usable(field: HTMLElement): boolean {
  return (
    field.isConnected &&
    !field.closest("[inert], [hidden]") &&
    (typeof field.checkVisibility !== "function" || field.checkVisibility())
  );
}

/** The text a field holds, as the person reads it. */
function textOf(field: HTMLElement): string {
  return isValueField(field)
    ? field.value
    : (field.textContent ?? "").replace(ZERO_WIDTH, "");
}

/**
 * Where the person writes and dictation must not: a password, or an editor
 * that keeps its own text.
 */
function unwritable(element: Element | null): boolean {
  return (
    ownsItsText(element) ||
    (element instanceof HTMLInputElement && element.type === "password")
  );
}

/** Keys that move the caret away from the words showing. */
const CARET_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);
/** A sent message has left its field by then. */
const SENT_MS = 500;

/**
 * Dictation in this page: it tells the main process when the person is
 * in one of its text fields, writes the words it is sent into the one with
 * focus, else the last one still in reach, and says when what was
 * dictated is sent: Return in a single line, a form sent, or a longer
 * text that leaves its field as Return goes down (a chat's composer).
 */
export function installFieldDictation(port: DictationPort): () => void {
  const dictation = new FieldDictation();
  /** The text fields the person was in, the latest first. */
  let recent: HTMLElement[] = [];
  /** Fields dictation wrote into, whose sending ends it. */
  const dictated = new WeakSet<HTMLElement>();
  // The element itself, inside a shadow root too (a site's own search box).
  const elementOf = (event: Event) => {
    const [element] = event.composedPath();
    return element instanceof Element ? element : null;
  };
  const onFocus = (event: FocusEvent) => {
    const element = elementOf(event);
    const target = textFieldOf(element);
    if (!target) {
      // Words for a password or a code editor go nowhere, not to a field
      // before it.
      if (unwritable(element)) {
        dictation.settle();
        port.fieldFocused();
      }
      return;
    }
    if (dictation.showing && dictation.showing !== target) dictation.settle();
    recent = [
      target,
      ...recent.filter((field) => field !== target && field.isConnected),
    ].slice(0, 8);
    port.fieldFocused();
  };
  const sent = (target: HTMLElement) => {
    if (!dictated.has(target)) return;
    dictated.delete(target);
    port.sent();
  };
  // Typing, or moving the caret, takes the words showing over. Typing is
  // what changes the text, never a key alone: voice's own keys reach the
  // page before the window swallows them.
  const onEdit = (event: InputEvent) => {
    if (dictation.showing?.contains(elementOf(event))) dictation.settle();
  };
  const onKey = (event: KeyboardEvent) => {
    const target = textFieldOf(elementOf(event));
    if (!target) return;
    if (dictation.showing === target && CARET_KEYS.has(event.key))
      dictation.settle();
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      event.shiftKey ||
      event.altKey ||
      !dictated.has(target)
    )
      return;
    if (target instanceof HTMLInputElement) {
      if (!event.metaKey && !event.ctrlKey) sent(target);
      return;
    }
    // In a longer text Return may only start a new line.
    setTimeout(() => {
      if (!textOf(target).trim()) sent(target);
    }, SENT_MS);
  };
  const onPointer = (event: PointerEvent) => {
    if (dictation.showing?.contains(elementOf(event))) dictation.settle();
  };
  const onSubmit = (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    for (const field of recent) if (form.contains(field)) sent(field);
  };
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("beforeinput", onEdit, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("submit", onSubmit, true);
  const stopWords = port.onWords((words) => {
    const focused = focusedElement();
    // A page out of sight (a tab behind another) is not where they are,
    // and neither is a password: what showed only settles.
    if (document.visibilityState === "hidden" || unwritable(focused)) {
      if (words.final && dictation.showing)
        dictation.apply(dictation.showing, words);
      return;
    }
    // Focus a background window gave a field went unheard: it counts.
    const target = [textFieldOf(focused), ...recent].find(
      (field): field is HTMLElement => !!field && usable(field),
    );
    if (!target) return;
    dictated.add(target);
    dictation.apply(target, words);
  });
  return () => {
    stopWords();
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("beforeinput", onEdit, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("submit", onSubmit, true);
  };
}
