import {
  type AgentQuestion,
  type AssistantMessageItem,
  activeTurn,
  type ContextHandoffItem,
  type Item,
  type NoticeItem,
  orderedTurns,
  queuedTurns,
  type RequestItem,
  type RuntimeRequest,
  type SessionState,
  type Turn,
  type UserMessageItem,
} from "@catamorphic/agent-protocol";

/**
 * What a session reads as (ADR 0196): turns in order, each its input, the
 * work, and the answer. Every chat client renders this one projection, so
 * a turn means the same thing on the desktop, the phone and an embed.
 */

/** An item that is part of a turn's work: what the steps disclosure lists. */
export type WorkItem = Exclude<
  Item,
  UserMessageItem | AssistantMessageItem | NoticeItem | ContextHandoffItem
>;

/**
 * Sent as the answer when a person dismisses a blocking question panel.
 * Timelines recognize it and render a quiet "Questions dismissed" line.
 */
export const QUESTIONS_DISMISSED_MESSAGE =
  "The user dismissed these questions without answering them. Continue without their input, using your best judgment.";

export type TimelineEntry =
  /** A message into the session: a turn's input, a steer, a delivery. */
  | { kind: "input"; item: UserMessageItem }
  /**
   * Something the agent wrote, with the work that led to it. A turn's
   * last reply is its answer; earlier ones are notes along the way.
   */
  | { kind: "reply"; item: AssistantMessageItem; steps: WorkItem[] }
  /** Work after the turn's latest reply: still running, or cut short. */
  | { kind: "steps"; steps: WorkItem[] }
  /** Answered questions: each question with what the person picked. */
  | {
      kind: "answer";
      /** The item it reads at: the answer message or the request. */
      id: string;
      questions: AgentQuestion[];
      answers: string[];
      /** The person closed the panel without answering. */
      dismissed: boolean;
    }
  /** A line Work wrote: an agent change, a fork, a continued turn. */
  | { kind: "notice"; item: NoticeItem }
  /** What an agent was told about turns its thread had not seen. */
  | { kind: "handoff"; item: ContextHandoffItem };

export interface TimelineTurn {
  /** Stable key: the turn's id, or the loose item's. */
  key: string;
  /**
   * Null outside the loaded turns: deliveries and notices between turns,
   * and older pages whose turns the snapshot no longer carries.
   */
  turn: Turn | null;
  entries: TimelineEntry[];
}

/** A turn waiting to run, with the message that will start it. */
export interface QueuedMessage {
  turn: Turn;
  item: UserMessageItem | undefined;
}

/**
 * A turn that has not run yet: it waits in the queue, editable. A turn
 * that ran and waits to retry (`retryAt`) stays in the conversation.
 */
export function waitsToRun(turn: Turn): boolean {
  return (
    (turn.status === "queued" || turn.status === "held") &&
    turn.attemptCount === 0
  );
}

/**
 * The turn about to start: nothing runs and it heads the queue. It reads
 * in the conversation, not the queue, so a message sent to an idle agent
 * goes straight from sending to working instead of flashing as queued.
 */
export function startingTurn(state: SessionState): Turn | undefined {
  if (activeTurn(state)) return undefined;
  const next = queuedTurns(state).find(waitsToRun);
  return next?.status === "queued" ? next : undefined;
}

/** Turns the conversation leaves out: waiting ones, and ones withdrawn before they ran. */
function hiddenTurn(turn: Turn, starting: Turn | undefined): boolean {
  if (turn === starting) return false;
  return (
    waitsToRun(turn) || (turn.status === "cancelled" && turn.attemptCount === 0)
  );
}

/**
 * The session as turns of entries, oldest first. Queued and withdrawn
 * turns are left out (see {@link sessionQueue}). Items outside any turn
 * sit between the turns that ran before and after them.
 */
export function sessionTimeline(state: SessionState): TimelineTurn[] {
  const answeredByMessage = new Set<string>();
  const turnItems = new Map<string, Item[]>();
  // Items outside the loaded turns: deliveries and notices between turns,
  // and older pages whose turns the snapshot no longer carries.
  const others: { key: string; at: string; items: Item[] }[] = [];
  const unknownTurns = new Map<string, Item[]>();
  for (const item of state.items) {
    const questionRequestId = answerRequestId(item);
    if (questionRequestId) answeredByMessage.add(questionRequestId);
    if (item.turnId && state.turns[item.turnId]) {
      const list = turnItems.get(item.turnId);
      if (list) list.push(item);
      else turnItems.set(item.turnId, [item]);
    } else if (item.turnId) {
      const list = unknownTurns.get(item.turnId);
      if (list) list.push(item);
      else {
        const items = [item];
        unknownTurns.set(item.turnId, items);
        others.push({ key: item.turnId, at: item.createdAt, items });
      }
    } else others.push({ key: item.id, at: item.createdAt, items: [item] });
  }
  const context = { state, answeredByMessage };
  const starting = startingTurn(state);
  const turns = orderedTurns(state).filter(
    (turn) => !hiddenTurn(turn, starting),
  );
  const out: TimelineTurn[] = [];
  let otherIndex = 0;
  const flushOthersBefore = (at: string | null) => {
    while (otherIndex < others.length) {
      const other = others[otherIndex] as (typeof others)[number];
      if (at !== null && other.at >= at) break;
      otherIndex += 1;
      const entries = entriesOf(other.items, context);
      if (entries.length > 0) out.push({ key: other.key, turn: null, entries });
    }
  };
  for (const turn of turns) {
    flushOthersBefore(turn.startedAt ?? turn.createdAt);
    const items = turnItems.get(turn.id) ?? [];
    // The input leads its turn wherever it was queued in the transcript.
    const input = items.find((item) => item.id === turn.inputItemId);
    const ordered = input
      ? [input, ...items.filter((item) => item !== input)]
      : items;
    out.push({ key: turn.id, turn, entries: entriesOf(ordered, context) });
  }
  flushOthersBefore(null);
  return out;
}

/** Queued turns in the order they will run, with their messages. */
export function sessionQueue(state: SessionState): QueuedMessage[] {
  const starting = startingTurn(state);
  return queuedTurns(state)
    .filter((turn) => waitsToRun(turn) && turn !== starting)
    .map((turn) => {
      const found = turn.inputItemId
        ? state.items.find((item) => item.id === turn.inputItemId)
        : undefined;
      return {
        turn,
        item: found?.kind === "user_message" ? found : undefined,
      };
    });
}

/** The request id an answer message answers, when it is one. */
function answerRequestId(item: Item): string | undefined {
  if (item.kind !== "user_message") return undefined;
  const id = item.metadata.questionRequestId;
  return typeof id === "string" ? id : undefined;
}

function entriesOf(
  items: readonly Item[],
  context: {
    state: SessionState;
    answeredByMessage: ReadonlySet<string>;
  },
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let steps: WorkItem[] = [];
  const flushSteps = () => {
    if (steps.length === 0) return;
    entries.push({ kind: "steps", steps });
    steps = [];
  };
  for (const item of items) {
    switch (item.kind) {
      case "user_message": {
        const answered = answerFromMessage(item);
        flushSteps();
        entries.push(answered ?? { kind: "input", item });
        break;
      }
      case "assistant_message":
        entries.push({ kind: "reply", item, steps });
        steps = [];
        break;
      case "notice":
        flushSteps();
        entries.push({ kind: "notice", item });
        break;
      case "context_handoff":
        flushSteps();
        entries.push({ kind: "handoff", item });
        break;
      case "request": {
        const request = context.state.requests[item.requestId];
        const answered =
          request && !context.answeredByMessage.has(request.id)
            ? answerFromRequest(item, request)
            : undefined;
        if (answered) {
          flushSteps();
          entries.push(answered);
        } else steps.push(item);
        break;
      }
      default:
        steps.push(item);
    }
  }
  flushSteps();
  return entries;
}

function answerFromRequest(
  item: RequestItem,
  request: RuntimeRequest,
): TimelineEntry | undefined {
  if (
    request.kind !== "question" ||
    request.status !== "resolved" ||
    request.response?.kind !== "question"
  )
    return undefined;
  return answerEntry({
    id: item.id,
    questions: request.questions ?? [],
    answers: request.response.answers,
  });
}

function answerFromMessage(item: UserMessageItem): TimelineEntry | undefined {
  const question = item.metadata.question;
  if (!question || typeof question !== "object" || Array.isArray(question))
    return undefined;
  const { questions, answers } = question;
  if (!Array.isArray(questions) || !Array.isArray(answers)) return undefined;
  return answerEntry({
    id: item.id,
    questions: questions.flatMap((raw) => {
      const parsed = questionFrom(raw);
      return parsed ? [parsed] : [];
    }),
    answers: answers.filter(
      (answer): answer is string => typeof answer === "string",
    ),
  });
}

function questionFrom(raw: unknown): AgentQuestion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const question = "question" in raw ? raw.question : undefined;
  if (typeof question !== "string") return undefined;
  const header = "header" in raw ? raw.header : undefined;
  const multiSelect = "multiSelect" in raw ? raw.multiSelect : undefined;
  return {
    question,
    header: typeof header === "string" ? header : "",
    multiSelect: multiSelect === true,
    options: [],
  };
}

function answerEntry(input: {
  id: string;
  questions: AgentQuestion[];
  answers: string[];
}): TimelineEntry {
  return {
    kind: "answer",
    id: input.id,
    questions: input.questions,
    answers: input.answers,
    dismissed: input.answers[0] === QUESTIONS_DISMISSED_MESSAGE,
  };
}

/**
 * Question rows of an answer: each question with what was picked. A
 * single answer to several questions (an older client) reads whole.
 */
export function answerRows(
  entry: Extract<TimelineEntry, { kind: "answer" }>,
): { question: string; answer: string }[] {
  if (entry.questions.length === 0)
    return [{ question: "", answer: entry.answers.join("\n") }];
  if (entry.answers.length === entry.questions.length)
    return entry.questions.map((question, index) => ({
      question: question.question,
      answer: entry.answers[index] ?? "",
    }));
  return [
    {
      question: entry.questions.map((question) => question.question).join("\n"),
      answer: entry.answers.join("\n"),
    },
  ];
}

/** The text an item was written with, for copy and previews. */
export function itemText(item: Item): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "notice":
    case "context_handoff":
      return item.text;
    default:
      return "";
  }
}
