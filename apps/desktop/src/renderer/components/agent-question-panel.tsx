import {
  type AgentQuestionPanelProps,
  AgentQuestionPanel as QuestionPanel,
} from "./catamorphic/agent-question-panel";
import { ShortcutHint } from "./shortcut-hint";

export type { AgentQuestionPanelProps } from "./catamorphic/agent-question-panel";

export function AgentQuestionPanel(props: AgentQuestionPanelProps) {
  return (
    <QuestionPanel
      {...props}
      renderDismiss={(button, label) => (
        <ShortcutHint label={label} shortcut="Esc">
          {button}
        </ShortcutHint>
      )}
    />
  );
}
