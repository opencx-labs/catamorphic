"use client";

import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentQuestion } from "./chat-timeline";

export interface AgentQuestionPanelProps {
  questions: AgentQuestion[];
  /** Sending the composed answer text back to the agent. */
  onSubmit: (answer: string) => void;
  /** Dismissing the questions without answering (X button or Escape). */
  onDismiss: () => void;
  disabled?: boolean;
  blocking?: boolean;
  renderDismiss?: (button: React.ReactNode, label: string) => React.ReactNode;
}

interface Answer {
  /** Selected option labels. */
  selected: string[];
}

const emptyAnswer = (): Answer => ({ selected: [] });

const isAnswered = (answer: Answer): boolean => answer.selected.length > 0;

/**
 * Tabbed question form for agent `ask_user` turns, styled after the Claude
 * Code VSCode extension: one tab per question, animated slide between them,
 * and options with effect descriptions. Answers in the person's own words
 * go through the chat composer, which the agent reads while the question
 * stays open (ADR 0195).
 */
export function AgentQuestionPanel({
  questions,
  onSubmit,
  onDismiss,
  disabled = false,
  blocking = true,
  renderDismiss = (button) => button,
}: AgentQuestionPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>(() =>
    questions.map(emptyAnswer),
  );
  // New question set (next ask_user turn) resets the form.
  const questionsKey = questions
    .map((question) => question.question)
    .join("\u0000");
  const prevKeyRef = useRef(questionsKey);
  if (prevKeyRef.current !== questionsKey) {
    prevKeyRef.current = questionsKey;
    setAnswers(questions.map(emptyAnswer));
    setActiveIndex(0);
  }

  const safeIndex = Math.min(activeIndex, questions.length - 1);
  const allAnswered = answers.every(isAnswered);

  // Height follows the active panel so the slide never clips or jumps. A
  // ResizeObserver (not a one-shot measure) because question text reflows
  // when the panel's width changes.
  const panelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [panelHeight, setPanelHeight] = useState<number>();
  useLayoutEffect(() => {
    if (collapsed) return;
    const panel = panelRefs.current[safeIndex];
    if (!panel) return;
    setPanelHeight(panel.offsetHeight);
    const observer = new ResizeObserver(() =>
      setPanelHeight(panel.offsetHeight),
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, [safeIndex, collapsed]);

  const submit = () => {
    if (!allAnswered || disabled) return;
    onSubmit(formatAnswers(questions, answers));
  };

  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(advanceTimerRef.current), []);

  // Escape dismisses the questions. Capture phase so this wins over the
  // dock's own Escape-to-minimize handler, which yields via defaultPrevented.
  const dismiss = () => (blocking ? onDismiss() : setCollapsed(true));
  const onDismissRef = useRef(dismiss);
  onDismissRef.current = dismiss;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (event.defaultPrevented || disabledRef.current || collapsed) return;
      event.preventDefault();
      onDismissRef.current();
    };
    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onWindowKeyDown, {
        capture: true,
      });
  }, [collapsed]);

  const setAnswer = (index: number, update: (answer: Answer) => Answer) =>
    setAnswers((current) =>
      current.map((answer, i) => (i === index ? update(answer) : answer)),
    );

  const selectOption = (index: number, label: string) => {
    const question = questions[index];
    if (!question) return;
    let next: Answer | undefined;
    setAnswer(index, (answer) => {
      if (question.multiSelect) {
        const selected = answer.selected.includes(label)
          ? answer.selected.filter((entry) => entry !== label)
          : [...answer.selected, label];
        next = { ...answer, selected };
      } else {
        next = { ...answer, selected: [label] };
      }
      return next;
    });
    // Single-select answers glide to the next unanswered question.
    if (!question.multiSelect && questions.length > 1) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = setTimeout(() => {
        setActiveIndex((current) => {
          const unanswered = answers.findIndex(
            (answer, i) => i !== index && i > current && !isAnswered(answer),
          );
          return unanswered === -1
            ? Math.min(current + 1, questions.length - 1)
            : unanswered;
        });
      }, 220);
    }
  };

  if (collapsed)
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        disabled={disabled}
        className="mx-3 mb-1 rounded-md border border-border px-3 py-2 text-left text-xs text-fg-muted"
      >
        Answer when ready · {questions.length}{" "}
        {questions.length === 1 ? "question" : "questions"}
      </button>
    );

  return (
    <section
      className="animate-question-in mx-3 mb-1 overflow-hidden rounded-xl border border-accent/35 bg-bg-overlay/60"
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
              const answered = answers[index] && isAnswered(answers[index]);
              return (
                <button
                  key={question.question}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveIndex(index)}
                  className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 pb-2 pt-1 text-[11px] font-semibold transition-colors duration-150 ${
                    active ? "text-fg" : "text-fg-faint hover:text-fg-muted"
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
          <span className="mb-2 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            {questions[0]?.header}
          </span>
        )}
        <span
          role="status"
          className="mb-2 ml-auto min-w-0 truncate text-[11px] text-fg-muted"
        >
          {blocking ? "Waiting for your answer" : "Answer when ready"}
        </span>
        <span className="mb-2 shrink-0">
          {renderDismiss(
            <button
              type="button"
              onClick={dismiss}
              disabled={disabled}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              aria-label={blocking ? "Dismiss questions" : "Answer later"}
            >
              <X className="size-3.5" />
            </button>,
            blocking ? "Dismiss questions" : "Answer later",
          )}
        </span>
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
                <p className="mb-2.5 whitespace-pre-wrap break-words text-sm font-medium leading-5">
                  {question.question}
                </p>
                <div className="flex flex-col gap-1.5">
                  {question.options.map((option) => {
                    const selected = answer.selected.includes(option.label);
                    return (
                      <OptionRow
                        key={option.label}
                        label={option.label}
                        description={option.description}
                        selected={selected}
                        multiSelect={question.multiSelect}
                        disabled={disabled}
                        onSelect={() => selectOption(index, option.label)}
                      />
                    );
                  })}
                  {question.options.length === 0 && (
                    <p className="text-xs text-fg-muted">
                      Reply in the chat to answer.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-fg-faint">
          {questions.length > 1
            ? `${answers.filter(isAnswered).length} of ${questions.length} answered · or reply in the chat`
            : "Or reply in the chat in your own words."}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!allAnswered || disabled}
          className="h-7 shrink-0 cursor-pointer rounded-md bg-accent px-3 text-[12px] font-medium text-accent-fg transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-default disabled:opacity-35"
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
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  multiSelect: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`group flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-[border-color,background-color] duration-150 ${
        selected
          ? "border-accent/60 bg-accent/10"
          : "border-border bg-bg-raised/40 hover:border-border-strong hover:bg-bg-overlay"
      }`}
    >
      <span
        className={`mt-0.5 grid size-4 shrink-0 place-items-center border transition-[background-color,border-color] duration-150 ${
          multiSelect ? "rounded" : "rounded-full"
        } ${
          selected
            ? "border-accent bg-accent text-accent-fg"
            : "border-border-strong bg-bg-inset text-transparent group-hover:border-fg-faint"
        }`}
      >
        <Check
          className={`size-3 transition-transform duration-150 ${selected ? "scale-100" : "scale-0"}`}
          strokeWidth={3}
        />
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
    const value = (answers[index] ?? emptyAnswer()).selected.join(", ");
    return questions.length > 1 ? `${question.question}\n→ ${value}` : value;
  });
  return lines.join("\n\n");
}
