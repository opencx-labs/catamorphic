import { Check, PencilLine, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { AgentQuestion } from "./catamorphic/chat-timeline.js";

/**
 * The desktop's tabbed `ask_user` form (components/agent-question-panel),
 * trimmed for touch: no keyboard shortcuts, same tabs / slide / "Other"
 * free-text / answer formatting so the agent sees identical replies.
 */
export const QUESTIONS_DISMISSED_MESSAGE =
  "(The user dismissed the questions without answering.)";

export interface AgentQuestionPanelProps {
  questions: AgentQuestion[];
  onSubmit: (answer: string) => void;
  onDismiss: () => void;
}

const OTHER = "__other__";

interface Answer {
  selected: string[];
  otherText: string;
}

const emptyAnswer = (): Answer => ({ selected: [], otherText: "" });

const isAnswered = (answer: Answer): boolean =>
  answer.selected.includes(OTHER)
    ? answer.otherText.trim().length > 0
    : answer.selected.length > 0;

export function AgentQuestionPanel({
  questions,
  onSubmit,
  onDismiss,
}: AgentQuestionPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() =>
    questions.map(emptyAnswer),
  );
  const questionsKey = questions.map((question) => question.question).join(" ");
  const prevKeyRef = useRef(questionsKey);
  if (prevKeyRef.current !== questionsKey) {
    prevKeyRef.current = questionsKey;
    setAnswers(questions.map(emptyAnswer));
    setActiveIndex(0);
  }

  const safeIndex = Math.min(activeIndex, questions.length - 1);
  const allAnswered = answers.every(isAnswered);

  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [panelHeight, setPanelHeight] = useState<number>();
  useLayoutEffect(() => {
    const panel = panelRefs.current[safeIndex];
    if (!panel) return;
    setPanelHeight(panel.offsetHeight);
    const observer = new ResizeObserver(() =>
      setPanelHeight(panel.offsetHeight),
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, [safeIndex]);

  const submit = () => {
    if (!allAnswered) return;
    onSubmit(formatAnswers(questions, answers));
  };

  const setAnswer = (index: number, update: (answer: Answer) => Answer) =>
    setAnswers((current) =>
      current.map((answer, i) => (i === index ? update(answer) : answer)),
    );

  const selectOption = (index: number, label: string) => {
    const question = questions[index];
    if (!question) return;
    setAnswer(index, (answer) => {
      if (question.multiSelect && label !== OTHER) {
        const selected = answer.selected.includes(label)
          ? answer.selected.filter((entry) => entry !== label)
          : [...answer.selected.filter((entry) => entry !== OTHER), label];
        return { ...answer, selected };
      }
      if (label === OTHER) {
        return answer.selected.includes(OTHER)
          ? { ...answer, selected: [] }
          : { ...answer, selected: [OTHER] };
      }
      return { ...answer, selected: [label] };
    });
    if (!question.multiSelect && label !== OTHER && questions.length > 1) {
      setTimeout(() => {
        setActiveIndex((current) =>
          Math.min(current + 1, questions.length - 1),
        );
      }, 220);
    }
  };

  return (
    <section
      className="animate-question-in overflow-hidden rounded-xl border border-accent/35 bg-bg-overlay/60"
      aria-label="The agent has a question"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 pt-2.5 pb-0">
        {questions.length > 1 ? (
          <div
            className="flex min-w-0 items-end gap-1 overflow-x-auto"
            role="tablist"
            aria-label="Questions"
          >
            {questions.map((question, index) => {
              const active = index === safeIndex;
              const entry = answers[index];
              const answered = entry !== undefined && isAnswered(entry);
              return (
                <button
                  key={question.question}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveIndex(index)}
                  className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 pb-2 pt-1 text-[11px] font-semibold transition-colors duration-150 ${
                    active ? "text-fg" : "text-fg-faint"
                  }`}
                >
                  <span
                    className={`grid size-3.5 shrink-0 place-items-center rounded-full border text-[9px] transition-[background-color,border-color,color] duration-200 ${
                      answered
                        ? "border-accent bg-accent text-accent-fg"
                        : active
                          ? "border-fg-muted text-fg-muted"
                          : "border-border-strong text-fg-faint"
                    }`}
                  >
                    {answered ? (
                      <Check className="size-2.5" strokeWidth={3} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {question.header}
                  <span
                    className={`absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-accent transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      active
                        ? "scale-x-100 opacity-100"
                        : "scale-x-50 opacity-0"
                    }`}
                  />
                </button>
              );
            })}
          </div>
        ) : (
          <span className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            {questions[0]?.header}
          </span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="mb-2 ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint"
          aria-label="Dismiss questions"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div
        className="overflow-hidden transition-[height] duration-250 ease-[cubic-bezier(0.2,0,0,1)]"
        style={panelHeight === undefined ? undefined : { height: panelHeight }}
      >
        <div
          className="flex items-start transition-transform duration-250 ease-[cubic-bezier(0.2,0,0,1)]"
          style={{ transform: `translateX(-${safeIndex * 100}%)` }}
        >
          {questions.map((question, index) => {
            const answer = answers[index] ?? emptyAnswer();
            const active = index === safeIndex;
            return (
              <div
                key={question.question}
                ref={(node) => {
                  panelRefs.current[index] = node;
                }}
                role={questions.length > 1 ? "tabpanel" : undefined}
                className={`w-full shrink-0 p-3 transition-opacity duration-200 ${
                  active ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                aria-hidden={!active}
                inert={active ? undefined : true}
              >
                <p className="mb-2.5 text-sm font-medium leading-5">
                  {question.question}
                </p>
                <div className="flex flex-col gap-1.5">
                  {question.options.map((option) => (
                    <OptionRow
                      key={option.label}
                      label={option.label}
                      description={option.description}
                      selected={answer.selected.includes(option.label)}
                      multiSelect={question.multiSelect}
                      onSelect={() => selectOption(index, option.label)}
                    />
                  ))}
                  <OptionRow
                    label="Other"
                    description="Answer in your own words instead."
                    selected={answer.selected.includes(OTHER)}
                    multiSelect={false}
                    icon={<PencilLine className="size-3" />}
                    onSelect={() => selectOption(index, OTHER)}
                  />
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      answer.selected.includes(OTHER)
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    }`}
                  >
                    <div className="overflow-hidden">
                      <textarea
                        rows={1}
                        className="field mt-0.5 w-full resize-none px-2.5 py-1.5 leading-5 outline-none [field-sizing:content] placeholder:text-fg-faint"
                        placeholder="Type your answer…"
                        value={answer.otherText}
                        onChange={(event) =>
                          setAnswer(index, (current) => ({
                            ...current,
                            otherText: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="text-[11px] text-fg-faint">
          {questions.length > 1
            ? `${answers.filter(isAnswered).length} of ${questions.length} answered`
            : "You can also reply below."}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered}
          className="h-8 shrink-0 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-[opacity,transform] duration-150 active:scale-[0.98] disabled:cursor-default disabled:opacity-35"
        >
          {questions.length > 1 ? "Submit answers" : "Submit"}
        </button>
      </footer>
    </section>
  );
}

function OptionRow({
  label,
  description,
  selected,
  multiSelect,
  icon,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  multiSelect: boolean;
  icon?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-[border-color,background-color] duration-150 ${
        selected
          ? "border-accent/60 bg-accent/10"
          : "border-border bg-bg-raised/40 active:bg-bg-overlay"
      }`}
    >
      <span
        className={`mt-0.5 grid size-4 shrink-0 place-items-center border transition-[background-color,border-color] duration-150 ${
          multiSelect ? "rounded" : "rounded-full"
        } ${
          selected
            ? "border-accent bg-accent text-accent-fg"
            : "border-border-strong bg-bg-inset text-transparent"
        }`}
      >
        {icon && !selected ? (
          <span className="text-fg-faint">{icon}</span>
        ) : (
          <Check
            className={`size-3 transition-transform duration-150 ${selected ? "scale-100" : "scale-0"}`}
            strokeWidth={3}
          />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-5">{label}</span>
        {description && (
          <span className="block text-xs leading-[1.45] text-fg-muted">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

/** Compose the user's selections into the text sent back to the agent. */
function formatAnswers(questions: AgentQuestion[], answers: Answer[]): string {
  const lines = questions.map((question, index) => {
    const answer = answers[index] ?? emptyAnswer();
    const value = answer.selected.includes(OTHER)
      ? answer.otherText.trim()
      : answer.selected.join(", ");
    return questions.length > 1 ? `${question.question}\n→ ${value}` : value;
  });
  return lines.join("\n\n");
}
