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
  /** Files pasted into an Other answer: the chat's own attaching, into it. */
  onAnswerFiles?: (input: ComposerInputHandle, files: File[]) => void;
}) {
  return (
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
  );
}
