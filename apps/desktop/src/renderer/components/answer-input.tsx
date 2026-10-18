import { type ClipboardEvent, type DragEvent, useEffect, useRef } from "react";
import {
  filesFrom,
  readComposerPaste,
  tabPillFromDrag,
} from "../lib/composer-paste";
import type { OtherAnswerInputProps } from "./catamorphic/agent-question-panel";
import { ComposerInput, type ComposerInputHandle } from "./composer-input";

/**
 * A question's Other answer, typed in the composer's own input: it glides
 * taller as it grows; a long paste, an editor selection, a link or a path
 * becomes a pill, and a pasted image or file attaches as it would to a
 * message. The answer carries its pills as a message does (ADR 0244).
 */
export function AnswerInput({
  ariaLabel,
  placeholder,
  disabled,
  focusRequest,
  onChange,
  onEnter,
  onFiles,
}: OtherAnswerInputProps & {
  /** Pasted or dropped files, attached into this input (where dropped). */
  onFiles?: (
    input: ComposerInputHandle,
    files: File[],
    at?: { x: number; y: number },
  ) => void;
}) {
  const inputRef = useRef<ComposerInputHandle>(null);
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focusToType();
  }, [focusRequest]);

  const report = () => {
    const input = inputRef.current;
    if (!input) return;
    const { message, attachments } = input.read({ trim: true });
    onChange({ text: message, attachments });
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const input = inputRef.current;
    if (!input) return;
    const paste = readComposerPaste(event.clipboardData);
    if (paste.kind === "nothing") return;
    event.preventDefault();
    if (paste.kind === "files") onFiles?.(input, paste.files);
    else if (paste.kind === "pill") {
      input.insertPills([{ ...paste.pill, id: crypto.randomUUID() }]);
    } else if (paste.kind === "text") {
      input.insertText(paste.text);
    }
  };

  // A file or tab dropped here is this answer's: claimed, so the chat
  // around it lets the drop go instead of putting it in its composer.
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const input = inputRef.current;
    if (!input) return;
    const tab = tabPillFromDrag(event.dataTransfer);
    const files = tab ? [] : filesFrom(event.dataTransfer);
    if (!tab && files.length === 0) return;
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    if (tab) input.insertPills([{ ...tab, id: crypto.randomUUID() }], { at });
    else onFiles?.(input, files, at);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target around the textbox, which is the control
    <div
      aria-disabled={disabled || undefined}
      onDrop={onDrop}
      className={`field ${disabled ? "pointer-events-none opacity-60" : ""}`}
    >
      <ComposerInput
        ref={inputRef}
        chatComposer={false}
        testId="question-answer-input"
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        className="max-h-40 min-h-8 overflow-y-auto px-2.5 py-1.5 text-[13px] leading-5"
        onChange={report}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          onEnter();
        }}
      />
    </div>
  );
}
