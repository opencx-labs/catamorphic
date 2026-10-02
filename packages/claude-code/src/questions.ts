import type { AgentQuestion } from "@catamorphic/agent-protocol";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

/**
 * The CLI's AskUserQuestion input as Work's question shape, so every
 * harness feeds the same question panel.
 */
export function parseAskUserQuestions(input: unknown): AgentQuestion[] {
  const record = asRecord(input);
  const raw = Array.isArray(record?.questions) ? record.questions : [];
  return raw.flatMap((entry): AgentQuestion[] => {
    const question = asRecord(entry);
    if (typeof question?.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): AgentQuestion["options"] => {
          const parsed = asRecord(option);
          return typeof parsed?.label === "string"
            ? [
                {
                  label: parsed.label,
                  description:
                    typeof parsed.description === "string"
                      ? parsed.description
                      : "",
                },
              ]
            : [];
        })
      : [];
    return [
      {
        question: question.question,
        header:
          typeof question.header === "string" && question.header.length > 0
            ? question.header
            : "Question",
        multiSelect: question.multiSelect === true,
        options,
      },
    ];
  });
}

/**
 * The person's answers as the AskUserQuestion call's `updatedInput`. The
 * tool reads `answers` (question text to answer; several choices joined by
 * commas) and `response` (free text) and returns them to the model.
 *
 * Answers come one per question, in order. A single answer to several
 * questions may be the question panel's text form (`<question>\n→ <answer>`
 * blocks separated by blank lines); whatever cannot be matched rides as
 * `response`, so the person's words always reach the model.
 */
export function askUserAnswerInput(input: {
  toolInput: Record<string, unknown>;
  answers: string[];
}): Record<string, unknown> {
  const texts = parseAskUserQuestions(input.toolInput).map(
    (question) => question.question,
  );
  const answers: Record<string, string> = {};
  const single = input.answers.length === 1 ? input.answers[0] : undefined;
  if (single !== undefined && texts.length > 1) {
    for (const text of texts) {
      const marker = `${text}\n→ `;
      const start = single.indexOf(marker);
      if (start === -1) continue;
      const from = start + marker.length;
      const end = single.indexOf("\n\n", from);
      answers[text] = (
        end === -1 ? single.slice(from) : single.slice(from, end)
      ).trim();
    }
  } else {
    for (const [index, text] of texts.entries()) {
      const answer = input.answers[index]?.trim();
      if (answer) answers[text] = answer;
    }
  }
  const unmatched = Object.keys(answers).length < texts.length;
  const response = input.answers.join("\n\n").trim();
  return {
    ...input.toolInput,
    answers,
    ...(unmatched && response ? { response } : {}),
  };
}
