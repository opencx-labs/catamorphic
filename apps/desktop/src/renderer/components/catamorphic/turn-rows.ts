import type {
  AssistantMessageItem,
  TaskNotificationItem,
  TimelineEntry,
  TimelineTurn,
  WorkItem,
} from "@catamorphic/react";

/**
 * A turn reads as its input, then its work, then its answer (ADR 0197).
 * The agent may write notes along the way: each reply in a turn carries
 * the steps that led to it, and the last one is the answer. Two display
 * choices, the host's to offer (`ChatTimeline`'s `workDisplay`), decide how
 * that work reads:
 *
 * - while the turn runs: every note with its steps open, only the latest
 *   note (earlier ones folded into its steps), or every note with its
 *   steps folded (`notes`, which keeps steps folded once answered too);
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
 * read open, and once it has answered a lone step is its own row.
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

/** Read task updates are work; unread or actionable deliveries stay visible. */
function foldsNotification(item: TaskNotificationItem): boolean {
  return (
    item.status === "completed" &&
    item.attention !== "required" &&
    item.task.status !== "needs_input" &&
    !(item.task.type === "subsession" && item.task.status === "failed")
  );
}

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
  let run: Array<
    Extract<TimelineEntry, { kind: "reply" | "steps" | "notifications" }>
  > = [];
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
        if (fold) buffer.push(...work(entry.steps));
        else rows.push({ kind: "steps", steps: work(entry.steps) });
        continue;
      }
      if (entry.kind === "notifications") {
        buffer.push(...work(entry.items));
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
    if (buffer.length > 0) rows.push({ kind: "steps", steps: buffer });
    run = [];
  };
  for (const entry of group.entries) {
    if (
      entry.kind === "reply" ||
      entry.kind === "steps" ||
      (!live &&
        fold &&
        entry.kind === "notifications" &&
        entry.items.every(foldsNotification))
    ) {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ kind: "entry", entry });
  }
  flush();
  return rows;
}

/**
 * Automatic task wakeups can produce several execution turns for one person's
 * request. Fold their completed work toward the last answer without changing
 * those turns, their item identities, outcomes, or action targets. Human input,
 * attention, and unfinished/failed turns remain reading boundaries.
 */
export function createCompletedRowsProjector<
  T extends { group: TimelineTurn; rows: TurnRow[]; live: boolean },
>(): (views: T[]) => T[] {
  // Keep only the latest projection's targets. A former answer can remain
  // in the timeline for hours; retaining each old merged prefix is quadratic.
  let runs = new Map<TurnRow, { sources: TurnRow[]; row: TurnRow }>();
  const projections = new WeakMap<T, { rows: TurnRow[]; view: T }>();
  return (views) => {
    const nextRuns = new Map<TurnRow, { sources: TurnRow[]; row: TurnRow }>();
    const changes = new Map<number, Map<TurnRow, TurnRow | null>>();
    let run: Array<{
      index: number;
      row: Exclude<TurnRow, { kind: "entry" }>;
    }> = [];
    const change = (index: number, row: TurnRow, next: TurnRow | null) => {
      let rows = changes.get(index);
      if (!rows) {
        rows = new Map();
        changes.set(index, rows);
      }
      rows.set(row, next);
    };
    const flush = () => {
      const target =
        [...run].reverse().find(({ row }) => row.kind === "reply") ??
        run.at(-1);
      if (!target || run.length < 2) {
        run = [];
        return;
      }
      const before = run.slice(0, run.indexOf(target));
      if (before.length === 0) {
        run = [];
        return;
      }
      const sources = run
        .slice(0, run.indexOf(target) + 1)
        .map(({ row }) => row);
      const cached = runs.get(target.row);
      if (
        cached &&
        cached.sources.length === sources.length &&
        cached.sources.every((row, index) => row === sources[index])
      ) {
        nextRuns.set(target.row, cached);
        for (const { index, row } of before) change(index, row, null);
        change(target.index, target.row, cached.row);
        run = [];
        return;
      }
      const steps: StepSource[] = [];
      const folded: AssistantMessageItem[] = [];
      for (const { index, row } of before) {
        steps.push(...row.steps);
        if (row.kind === "reply") {
          steps.push({ kind: "note", item: row.item });
          folded.push(...row.folded, row.item);
        }
        change(index, row, null);
      }
      const row = target.row;
      const merged: TurnRow =
        row.kind === "reply"
          ? {
              ...row,
              steps: [...steps, ...row.steps],
              folded: [...folded, ...row.folded],
            }
          : { ...row, steps: [...steps, ...row.steps] };
      nextRuns.set(row, { sources, row: merged });
      change(target.index, row, merged);
      run = [];
    };
    views.forEach((view, index) => {
      const completed =
        !view.live &&
        (!view.group.turn || view.group.turn.status === "completed");
      if (!completed) {
        flush();
        return;
      }
      for (const row of view.rows) {
        if (row.kind === "entry") flush();
        else run.push({ index, row });
      }
    });
    flush();
    runs = nextRuns;
    return views.map((view, index) => {
      const changed = changes.get(index);
      if (!changed) return view;
      const rows = view.rows.flatMap((row) =>
        changed.has(row) ? (changed.get(row) ?? []) : row,
      );
      const cached = projections.get(view);
      if (
        cached &&
        cached.rows.length === rows.length &&
        cached.rows.every((row, index) => row === rows[index])
      )
        return cached.view;
      const projected = { ...view, rows };
      projections.set(view, { rows, view: projected });
      return projected;
    });
  };
}
