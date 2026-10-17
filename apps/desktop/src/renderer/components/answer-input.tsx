import { renderUserMessage } from "@catamorphic/react";
import { type ClipboardEvent, useEffect, useRef } from "react";
import { readComposerPaste } from "../lib/composer-paste";
import type { OtherAnswerInputProps } from "./catamorphic/agent-question-panel";
import { ComposerInput, type ComposerInputHandle } from "./composer-input";

/**
 * A question's Other answer, typed in the composer's own input: it glides
 * taller as it grows, and a long paste, an editor selection, a link or a
 * path becomes a pill. The agent reads the answer as it reads a chat
 * message: the words, then each pill's text.
 */
export function AnswerInput({
  ariaLabel,
  placeholder,
  disabled,
  focusRequest,
  onChange,
  onEnter,
}: OtherAnswerInputProps) {
  const inputRef = useRef<ComposerInputHandle>(null);
  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focusToType();
  }, [focusRequest]);

  const report = () => {
    const input = inputRef.current;
    if (!input) return;
    const { text, attachments } = input.read({ trim: true });
    onChange(renderUserMessage(text, attachments).trim());
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const input = inputRef.current;
    if (!input) return;
    const paste = readComposerPaste(event.clipboardData);
    if (paste.kind === "nothing") return;
    event.preventDefault();
    if (paste.kind === "pill") {
      input.insertPills([{ ...paste.pill, id: crypto.randomUUID() }]);
    } else if (paste.kind === "text") {
      input.insertText(paste.text);
    }
  };

  return (
    <div
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
