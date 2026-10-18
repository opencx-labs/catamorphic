"use client";

import type {
  AgentAttachment,
  AgentQuestion,
  RuntimeRequestResponse,
} from "@catamorphic/react";
import { Check, PencilLine, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** An Other answer: the words, and the pills its markers stand for. */
export interface OtherAnswer {
  text: string;
  attachments: AgentAttachment[];
}

/** What a host's own input for an Other answer is given. */
export interface OtherAnswerInputProps {
  ariaLabel: string;
  placeholder: string;
  disabled: boolean;
  /** Changes each time the input should take focus (Other was picked). */
  focusRequest: number;
  /**
   * Every change: the words, with a marker (U+FFFC) where each pill sits,
   * as a message has them, and the pills.
   */
  onChange: (answer: OtherAnswer) => void;
  /** Enter without Shift: this question is answered, move on. */
  onEnter: () => void;
}

export interface AgentQuestionPanelProps {
  questions: AgentQuestion[];
  /**
   * The answers, one per question (picked labels, then the person's own
   * words), with each answer's pills: send it as `respond(id, response)`.
   */
  onSubmit: (
    response: Extract<RuntimeRequestResponse, { kind: "question" }>,
  ) => void;
  /**
   * Dismissing blocking questions without answering (X button or Escape):
   * answer with `QUESTIONS_DISMISSED_MESSAGE`. A non-blocking panel only
   * collapses to "Answer when ready" instead.
   */
  onDismiss: () => void;
  disabled?: boolean;
  /** `RuntimeRequest.blocking`: whether the agent waits on the answer. */
  blocking?: boolean;
  renderDismiss?: (button: React.ReactNode, label: string) => React.ReactNode;
  /**
   * The input for an Other answer, one per question. Defaults to a plain
   * text box; a host can give it its composer's input instead.
   */
  renderOtherInput?: (props: OtherAnswerInputProps) => React.ReactNode;
}

interface Answer {
  /** Picked option labels. */
  selected: string[];
  /** Whether Other is picked: the person answers in their own words. */
  other: boolean;
  /** The Other answer, pills and all. */
  otherAnswer: OtherAnswer;
}

const emptyAnswer = (): Answer => ({
  selected: [],
  other: false,
  otherAnswer: { text: "", attachments: [] },
});

/** The person's own words, when Other is picked and they wrote some. */
const ownWords = (answer: Answer): OtherAnswer | null =>
  answer.other &&
  (answer.otherAnswer.text.trim() !== "" ||
    answer.otherAnswer.attachments.length > 0)
    ? answer.otherAnswer
    : null;

/** The answer to one question: picked labels, then the person's own words. */
const answerText = (answer: Answer): string => {
  const words = ownWords(answer)?.text.trim();
  // Only the person's words carry markers: a label is the agent's text.
  const labels = answer.selected.map((label) => label.replaceAll("\uFFFC", ""));
  return [...labels, ...(words ? [words] : [])].join(", ");
};

const isAnswered = (answer: Answer): boolean =>
  answer.selected.length > 0 || ownWords(answer) !== null;

/**
 * Tabbed question form for agent `ask_user` turns, styled after the Claude
 * Code VSCode extension: one tab per question, animated slide between them,
 * and options with effect descriptions. Each question has an Other answer
 * in the person's own words; a reply in the chat composer reaches the
 * agent too, while the questions stay open (ADR 0195).
 */
export function AgentQuestionPanel({
  questions,
  onSubmit,
  onDismiss,
  disabled = false,
  blocking = true,
  renderDismiss = (button) => button,
  renderOtherInput = (props) => <OtherAnswerTextarea {...props} />,
}: AgentQuestionPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>(() =>
    questions.map(emptyAnswer),
  );
  const [focusRequests, setFocusRequests] = useState<number[]>([]);
  // New question set (next ask_user turn) resets the form.
  const questionsKey = questions
    .map((question) => question.question)
    .join("\u0000");
  const prevKeyRef = useRef(questionsKey);
  if (prevKeyRef.current !== questionsKey) {
    prevKeyRef.current = questionsKey;
    setAnswers(questions.map(emptyAnswer));
    setFocusRequests([]);
    setActiveIndex(0);
  }

  const safeIndex = Math.min(activeIndex, questions.length - 1);
  const allAnswered = answers.every(isAnswered);

  // Height follows the active panel so the slide never clips or jumps. A
  // ResizeObserver (not a one-shot measure) because question text reflows
  // when the panel's width changes and an Other answer grows as it is typed.
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
      // Typing an answer, Escape leaves the answer; the next one dismisses.
      const typing = document.activeElement;
      if (
        typing instanceof HTMLElement &&
        typing.closest("[data-other-answer]")
      ) {
        typing.blur();
        return;
      }
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
    setAnswer(index, (answer) => {
      if (question.multiSelect) {
        const selected = answer.selected.includes(label)
          ? answer.selected.filter((entry) => entry !== label)
          : [...answer.selected, label];
        return { ...answer, selected };
      }
      return { ...answer, selected: [label], other: false };
    });
    // Single-select answers glide to the next unanswered question.
    if (!question.multiSelect && questions.length > 1) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = setTimeout(() => {
        const unanswered = answers.findIndex(
          (answer, i) => i !== index && i > index && !isAnswered(answer),
        );
        showQuestion(
          unanswered === -1
            ? Math.min(index + 1, questions.length - 1)
            : unanswered,
        );
      }, 220);
    }
  };

  // Picking Other opens its input and puts the caret in it; in a
  // single-select question it replaces the picked option.
  const toggleOther = (index: number) => {
    const question = questions[index];
    const answer = answers[index];
    if (!question || !answer) return;
    clearTimeout(advanceTimerRef.current);
    const other = !answer.other;
    setAnswer(index, (current) => ({
      ...current,
      other,
      selected: question.multiSelect ? current.selected : [],
    }));
    if (other) requestFocus(index);
  };

  const requestFocus = (index: number) =>
    setFocusRequests((current) => {
      const next = [...current];
      next[index] = (next[index] ?? 0) + 1;
      return next;
    });

  // Moving on keeps focus in the panel: the question left behind turns
  // inert, which drops focus to the page, where the next Escape would
  // dismiss every question. Its answer box takes the caret if it is open,
  // else its first option takes focus.
  const showQuestion = (index: number) => {
    setActiveIndex(index);
    if (answers[index]?.other || questions[index]?.options.length === 0)
      requestFocus(index);
    else
      requestAnimationFrame(() =>
        panelRefs.current[index]?.querySelector<HTMLElement>("button")?.focus(),
      );
  };

  // Enter in an Other answer: on to the next unanswered question, or send
  // them all once none is left.
  const answeredOther = (index: number) => {
    if (!answers[index] || !isAnswered(answers[index])) return;
    const pending = answers
      .map((answer, i) => ({ answer, i }))
      .filter(({ answer, i }) => i !== index && !isAnswered(answer))
      .map(({ i }) => i);
    const next = pending.find((i) => i > index) ?? pending[0];
    if (next === undefined) submit();
    else showQuestion(next);
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
            // A question without options is answered in words alone.
            const otherOpen = answer.other || question.options.length === 0;
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
                  {question.options.length > 0 && (
                    <OptionRow
                      label="Other"
                      description="Answer this one in your own words."
                      selected={answer.other}
                      multiSelect={question.multiSelect}
                      disabled={disabled}
                      icon={<PencilLine className="size-3" />}
                      onSelect={() => toggleOther(index)}
                    />
                  )}
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      otherOpen
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    }`}
                    inert={otherOpen ? undefined : true}
                  >
                    {/* Clip, never scroll: a hidden overflow is a scroll
                        container, and typing into the answer while it
                        opened scrolled it to the caret and left text
                        behind the caret. The padding is room for the
                        field's focus glow. */}
                    <div className="min-h-0 overflow-clip" data-other-answer>
                      <div className="-mx-[3px] px-[3px] pt-1.5 pb-[3px]">
                        {renderOtherInput({
                          ariaLabel: `Your answer: ${question.header || question.question}`,
                          placeholder: "Type your answer…",
                          disabled,
                          focusRequest: focusRequests[index] ?? 0,
                          onChange: (otherAnswer) =>
                            setAnswer(index, (current) => ({
                              ...current,
                              otherAnswer,
                              other:
                                current.other || question.options.length === 0,
                            })),
                          onEnter: () => answeredOther(index),
                        })}
                      </div>
                    </div>
                  </div>
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
            : "Or reply in the chat."}
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
  icon,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  multiSelect: boolean;
  disabled: boolean;
  /** Shown in place of the check while unpicked (Other's pencil). */
  icon?: React.ReactNode;
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

/**
 * The Other answer's text box when the host gives none: grows with what is
 * typed, Enter moves on, Shift+Enter starts a new line.
 */
function OtherAnswerTextarea({
  ariaLabel,
  placeholder,
  disabled,
  focusRequest,
  onChange,
  onEnter,
}: OtherAnswerInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequest > 0) ref.current?.focus();
  }, [focusRequest]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      // A phone's Return moves on or sends, as Enter does here.
      enterKeyHint="next"
      onChange={(event) =>
        onChange({ text: event.target.value, attachments: [] })
      }
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        onEnter();
      }}
      className="field block max-h-40 w-full resize-none px-2.5 py-1.5 text-[13px] leading-5 outline-none [field-sizing:content] placeholder:text-fg-faint"
    />
  );
}

/**
 * One answer per question (the picked labels, then the person's words),
 * and the pills of answers that have them.
 */
function formatAnswers(
  questions: AgentQuestion[],
  answers: Answer[],
): Extract<RuntimeRequestResponse, { kind: "question" }> {
  const each = questions.map(
    (_question, index) => answers[index] ?? emptyAnswer(),
  );
  const attachments = each.map((answer) => ownWords(answer)?.attachments ?? []);
  return {
    kind: "question",
    answers: each.map(answerText),
    ...(attachments.some((list) => list.length > 0) ? { attachments } : {}),
  };
}
