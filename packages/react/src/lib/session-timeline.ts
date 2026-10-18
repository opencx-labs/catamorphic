import {
  type AgentAttachment,
  type AgentQuestion,
  type AssistantMessageItem,
  activeTurn,
  type ContextHandoffItem,
  type InboundMessageItem,
  type InputItem,
  type Item,
  isInputItem,
  type NoticeItem,
  orderedTurns,
  queuedTurns,
  type RequestItem,
  type RuntimeRequest,
  type SessionState,
  type TaskNotificationItem,
  type Turn,
  type UserMessageItem,
} from "@catamorphic/agent-protocol";

/**
 * What a session reads as (ADR 0197): turns in order, each its input, the
 * work, and the answer. Every chat client renders this one projection, so
 * a turn means the same thing on the desktop, the phone and an embed.
 */

/**
 * An item that is part of a turn's work: what the steps disclosure lists.
 * A task notification that reached the turn while it worked is one; one
 * that started the turn, or waited for it, is an entry of its own.
 */
export type WorkItem = Exclude<
  Item,
  | UserMessageItem
  | InboundMessageItem
  | AssistantMessageItem
  | NoticeItem
  | ContextHandoffItem
>;

/**
 * Sent as the answer when a person dismisses a blocking question panel.
 * Timelines recognize it and render a quiet "Questions dismissed" line.
 */
export const QUESTIONS_DISMISSED_MESSAGE =
  "The user dismissed these questions without answering them. Continue without their input, using your best judgment.";

export type TimelineEntry =
  /** The person's message: a turn's input, or a steer. */
  | { kind: "input"; item: UserMessageItem }
  /** Words another agent, an assistant or a workflow sent (ADR 0217). */
  | { kind: "inbound"; item: InboundMessageItem }
  /**
   * Work's notifications about tasks the agent started, in a row: the ones
   * that started a turn or waited for one, or arrived between turns.
   */
  | { kind: "notifications"; items: TaskNotificationItem[] }
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
      /** Each answer's pills, in the order of its markers (ADR 0244). */
      attachments: AgentAttachment[][];
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

/** A turn waiting to run, with the input that will start it. */
export interface QueuedMessage {
  turn: Turn;
  item: InputItem | undefined;
  /** Notifications that joined the waiting turn after its input. */
  joined: TaskNotificationItem[];
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
  const starting = startingTurn(state);
  const answeredByMessage = new Set<string>();
  const turnItems = new Map<string, Item[]>();
  // Items outside the loaded turns: deliveries and notices between turns,
  // and older pages whose turns the snapshot no longer carries.
  const others: { key: string; at: string; items: Item[] }[] = [];
  const unknownTurns = new Map<string, Item[]>();
  for (const item of state.items) {
    // A message answers in its request's place only once it shows: one
    // still queued (an answer's media the turn ended before taking) leaves
    // the request's card in the conversation meanwhile.
    const questionRequestId = answerRequestId(item);
    const itemTurn = item.turnId ? state.turns[item.turnId] : undefined;
    if (questionRequestId && !(itemTurn && hiddenTurn(itemTurn, starting)))
      answeredByMessage.add(questionRequestId);
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
    // The input leads its turn wherever it was queued in the transcript;
    // what the turn read from before it (delivered to read, notifications
    // that waited for a turn) comes first.
    const input = items.find((item) => item.id === turn.inputItemId);
    const read = input
      ? items.filter(
          (item) =>
            item !== input &&
            isInputItem(item) &&
            item.dispatch !== "steer" &&
            item.position < input.position,
        )
      : [];
    const ordered = input
      ? [
          ...read,
          input,
          ...items.filter((item) => item !== input && !read.includes(item)),
        ]
      : items;
    out.push({ key: turn.id, turn, entries: entriesOf(ordered, context) });
  }
  flushOthersBefore(null);
  return out;
}

/**
 * `next` with every turn that reads the same as its counterpart in
 * `previous` (same turn, same items in the same entries) replaced by that
 * counterpart, and `previous` itself when nothing changed. Each event of a
 * live turn changes one turn: views that skip an unchanged turn by its
 * identity then render that one turn, not the whole conversation.
 */
export function shareTimeline(
  previous: TimelineTurn[] | undefined,
  next: TimelineTurn[],
): TimelineTurn[] {
  if (!previous) return next;
  const earlier = new Map(previous.map((turn) => [turn.key, turn]));
  let unchanged = previous.length === next.length;
  const shared = next.map((turn, index) => {
    const before = earlier.get(turn.key);
    const kept =
      before &&
      before.turn === turn.turn &&
      sameItems(before.entries, turn.entries, sameEntry)
        ? before
        : turn;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? previous : shared;
}

function sameItems<T>(
  left: readonly T[],
  right: readonly T[],
  same: (a: T, b: T) => boolean = Object.is,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => same(value, right[index] as T))
  );
}

function sameEntry(left: TimelineEntry, right: TimelineEntry): boolean {
  switch (left.kind) {
    case "input":
    case "inbound":
    case "notice":
    case "handoff":
      return right.kind === left.kind && right.item === left.item;
    case "notifications":
      return (
        right.kind === "notifications" && sameItems(left.items, right.items)
      );
    case "reply":
      return (
        right.kind === "reply" &&
        right.item === left.item &&
        sameItems(left.steps, right.steps)
      );
    case "steps":
      return right.kind === "steps" && sameItems(left.steps, right.steps);
    case "answer":
      return (
        right.kind === "answer" &&
        right.id === left.id &&
        right.dismissed === left.dismissed &&
        sameItems(left.questions, right.questions) &&
        sameItems(left.answers, right.answers)
      );
  }
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
        item: found && isInputItem(found) ? found : undefined,
        joined: state.items.filter(
          (item): item is TaskNotificationItem =>
            item.kind === "task_notification" &&
            item.turnId === turn.id &&
            item.id !== turn.inputItemId,
        ),
      };
    });
}

/** The request id an answer message answers, when it is one. */
function answerRequestId(item: Item): string | undefined {
  return item.kind === "user_message" ? item.answer?.requestId : undefined;
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
        const answered = answerFromMessage(item, context.state);
        flushSteps();
        entries.push(answered ?? { kind: "input", item });
        break;
      }
      case "inbound_message":
        flushSteps();
        entries.push({ kind: "inbound", item });
        break;
      case "task_notification": {
        // Reached the working turn: part of its work, like a tool's result.
        if (item.dispatch === "steer") {
          steps.push(item);
          break;
        }
        flushSteps();
        const last = entries.at(-1);
        if (last?.kind === "notifications") last.items.push(item);
        else entries.push({ kind: "notifications", items: [item] });
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
        // Each attempt records the handoff it began with; retries of a
        // turn say the same again, so the turn shows its first.
        if (entries.some((entry) => entry.kind === "handoff")) break;
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
    attachments: request.response.attachments,
  });
}

function answerFromMessage(
  item: UserMessageItem,
  state: SessionState,
): TimelineEntry | undefined {
  // An old answer whose questions are gone reads as the words it was.
  if (!item.answer?.questions.length) return undefined;
  // The pills its markers stand for are the request's (ADR 0244).
  const response = state.requests[item.answer.requestId]?.response;
  return answerEntry({
    id: item.id,
    questions: item.answer.questions,
    answers: item.answer.answers,
    attachments:
      response?.kind === "question" ? response.attachments : undefined,
  });
}

function answerEntry(input: {
  id: string;
  questions: AgentQuestion[];
  answers: string[];
  attachments?: AgentAttachment[][];
}): TimelineEntry {
  return {
    kind: "answer",
    id: input.id,
    questions: input.questions,
    answers: input.answers,
    attachments: input.answers.map(
      (_answer, index) => input.attachments?.[index] ?? [],
    ),
    dismissed: input.answers[0] === QUESTIONS_DISMISSED_MESSAGE,
  };
}

/**
 * Question rows of an answer: each question with what was picked. A
 * single answer to several questions (an older client) reads whole.
 */
export function answerRows(entry: Extract<TimelineEntry, { kind: "answer" }>): {
  question: string;
  answer: string;
  /** The answer's pills, in the order of its markers. */
  attachments: AgentAttachment[];
}[] {
  const whole = {
    answer: entry.answers.join("\n"),
    attachments: entry.attachments.flat(),
  };
  if (entry.questions.length === 0) return [{ question: "", ...whole }];
  if (entry.answers.length === entry.questions.length)
    return entry.questions.map((question, index) => ({
      question: question.question,
      answer: entry.answers[index] ?? "",
      attachments: entry.attachments[index] ?? [],
    }));
  return [
    {
      question: entry.questions.map((question) => question.question).join("\n"),
      ...whole,
    },
  ];
}

/** The text an item was written with, for copy and previews. */
export function itemText(item: Item): string {
  switch (item.kind) {
    case "task_notification":
      return item.summary;
    case "user_message":
    case "inbound_message":
    case "assistant_message":
    case "reasoning":
    case "notice":
    case "context_handoff":
      return item.text;
    default:
      return "";
  }
}
