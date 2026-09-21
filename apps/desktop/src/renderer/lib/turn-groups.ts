/**
 * An agent turn reaches the timeline as a run of assistant messages: one
 * per note the agent wrote between tool calls, each carrying the steps
 * that led to it, and last the answer. Two independent display choices
 * decide how that work reads (see `chatWorkLive` / `chatWorkSettled`):
 *
 * - while the turn runs: every note, or only the latest one;
 * - once it has answered: notes kept in place, or folded into the steps.
 *
 * Whatever is not shown in place is `folded`: the host renders it, in
 * order, under one steps disclosure. Nothing is ever dropped.
 */
export interface TurnGroupMessage {
  id: string;
  role: string;
  metadata?: unknown;
}

export interface WorkDisplay {
  live: "all" | "latest";
  settled: "keep" | "collapse";
}

export const DEFAULT_WORK_DISPLAY: WorkDisplay = {
  live: "all",
  settled: "keep",
};

export type TimelineItem<T> =
  | { kind: "message"; message: T }
  | {
      kind: "turn";
      /** Notes folded under the turn's steps disclosure, in order. */
      folded: T[];
      /** Messages still shown in place, in order; the last is the answer
       * once the turn has settled. */
      shown: T[];
      working: boolean;
    };

function isFailed(message: TurnGroupMessage): boolean {
  const metadata = message.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { status?: unknown }).status === "failed"
  );
}

export function groupTurns<T extends TurnGroupMessage>(
  messages: readonly T[],
  options: { working: boolean; display: WorkDisplay },
): TimelineItem<T>[] {
  const { working, display } = options;
  const items: TimelineItem<T>[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index] as T;
    if (message.role !== "assistant") {
      items.push({ kind: "message", message });
      index += 1;
      continue;
    }
    let end = index;
    while (end < messages.length && messages[end]?.role === "assistant")
      end += 1;
    const run = messages.slice(index, end);
    // Only the run at the very end of the log can still be running.
    const live = working && end === messages.length;
    index = end;
    const fold = live
      ? display.live === "latest"
      : display.settled === "collapse";
    if (!fold || run.length === 1) {
      for (const each of run) items.push({ kind: "message", message: each });
      continue;
    }
    // A failed message is an error card with its own recovery actions:
    // it always stays in place, as does whatever came right before it.
    const last = run.at(-1) as T;
    const keep = isFailed(last) && run.length > 1 ? 2 : 1;
    items.push({
      kind: "turn",
      folded: run.slice(0, -keep),
      shown: run.slice(-keep),
      working: live,
    });
  }
  return items;
}
