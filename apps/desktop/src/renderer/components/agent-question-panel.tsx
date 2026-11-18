import { OWN_FOCUS_ATTR } from "../lib/use-composer-focus-return.js";
import { AnswerInput } from "./answer-input";
import {
  type AgentQuestionPanelProps,
  AgentQuestionPanel as QuestionPanel,
} from "./catamorphic/agent-question-panel";
import type { ComposerInputHandle } from "./composer-input";
import { ShortcutHint } from "./shortcut-hint";

export type { AgentQuestionPanelProps } from "./catamorphic/agent-question-panel";

export function AgentQuestionPanel({
  onAnswerFiles,
  ...props
}: AgentQuestionPanelProps & {
  /** Files pasted or dropped on an Other answer: the chat's own attaching. */
  onAnswerFiles?: (
    input: ComposerInputHandle,
    files: File[],
    at?: { x: number; y: number },
  ) => void;
}) {
  // Picking an option moves on and focuses the next question; once the
  // answers are sent and the panel closes, the focus it drops returns to
  // the composer.
  return (
    <div className="contents" {...{ [OWN_FOCUS_ATTR]: "" }}>
      <QuestionPanel
        {...props}
        renderDismiss={(button, label) => (
          <ShortcutHint label={label} shortcut="Esc">
            {button}
          </ShortcutHint>
        )}
        renderOtherInput={(input) => (
          <AnswerInput {...input} onFiles={onAnswerFiles} />
        )}
      />
    </div>
  );
}
