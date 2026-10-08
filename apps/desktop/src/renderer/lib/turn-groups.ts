import type {
  AssistantMessageItem,
  TimelineEntry,
  TimelineTurn,
  WorkItem,
} from "@catamorphic/react";

/**
 * A turn reads as its input, then its work, then its answer (ADR 0197).
 * The agent may write notes along the way: each reply in a turn carries
 * the steps that led to it, and the last one is the answer. Two
 * independent display choices decide how that work reads (see
 * `chatWorkLive` / `chatWorkSettled`):
 *
 * - while the turn runs: every note with its steps open, only the latest
 *   note (earlier ones folded into its steps), or every note with its
 *   steps folded (`notes`);
 * - once it has answered: notes kept in place, or folded into the steps.
 *
 * Whatever is not shown in place is folded: it reads, in order, under the
 * next shown reply's steps disclosure. Nothing is ever dropped. Work after
 * the latest note (the turn is still on it, or was cut short) is a block
 * of its own that never folds.
 */
export interface WorkDisplay {
  live: "all" | "latest" | "notes";
  settled: "keep" | "collapse";
}

export const DEFAULT_WORK_DISPLAY: WorkDisplay = {
  live: "all",
  settled: "collapse",
};

/**
 * Whether steps stay behind their line until opened, even while the turn
 * runs and even when there is only one. Otherwise a running turn's steps
 * read open, and a lone step is its own row.
 */
export function foldsSteps(display: WorkDisplay): boolean {
  return display.live === "notes";
}

/** One row of a turn's steps disclosure: a piece of work, or a folded note. */
export type StepSource =
  | { kind: "work"; item: WorkItem }
  | { kind: "note"; item: AssistantMessageItem };

export type TurnRow =
  /** Inputs, answers, notices and handoffs: shown as they are. */
  | {
      kind: "entry";
      entry: Exclude<TimelineEntry, { kind: "reply" } | { kind: "steps" }>;
    }
  | {
      kind: "reply";
      item: AssistantMessageItem;
      /** Folded notes and their work first, then this reply's own work. */
      steps: StepSource[];
      /** Notes folded into these steps, in order. */
      folded: AssistantMessageItem[];
      /** The settled turn's answer: the last thing it wrote. */
      answer: boolean;
    }
  /** Work after the latest reply. */
  | { kind: "steps"; steps: StepSource[] };

const work = (items: readonly WorkItem[]): StepSource[] =>
  items.map((item) => ({ kind: "work", item }));

/**
 * The rows a turn renders as. `live` is whether the turn is still
 * running. Folding stays within a run of the agent's own writing: a
 * message steered in between, or an answered question, splits the run.
 */
export function turnRows(
  group: TimelineTurn,
  options: { live: boolean; display: WorkDisplay },
): TurnRow[] {
  const { live, display } = options;
  const fold = live
    ? display.live === "latest"
    : display.settled === "collapse";
  const rows: TurnRow[] = [];
  let run: Array<Extract<TimelineEntry, { kind: "reply" | "steps" }>> = [];
  const lastReplyId = [...group.entries]
    .reverse()
    .find(
      (entry): entry is Extract<TimelineEntry, { kind: "reply" }> =>
        entry.kind === "reply",
    )?.item.id;
  const flush = () => {
    const replies = run.filter((entry) => entry.kind === "reply");
    const last = replies.at(-1);
    let buffer: StepSource[] = [];
    let folded: AssistantMessageItem[] = [];
    for (const entry of run) {
      if (entry.kind === "steps") {
        if (fold && last && entry !== run.at(-1))
          buffer.push(...work(entry.steps));
        else rows.push({ kind: "steps", steps: work(entry.steps) });
        continue;
      }
      if (fold && replies.length > 1 && entry !== last) {
        buffer.push(...work(entry.steps), { kind: "note", item: entry.item });
        folded.push(entry.item);
        continue;
      }
      rows.push({
        kind: "reply",
        item: entry.item,
        steps: [...buffer, ...work(entry.steps)],
        folded,
        answer: !live && entry.item.id === lastReplyId,
      });
      buffer = [];
      folded = [];
    }
    run = [];
  };
  for (const entry of group.entries) {
    if (entry.kind === "reply" || entry.kind === "steps") {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ kind: "entry", entry });
  }
  flush();
  return rows;
}
