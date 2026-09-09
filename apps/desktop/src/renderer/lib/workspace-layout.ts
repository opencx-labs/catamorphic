/** Two existing tabs tiled side by side; activeTabKey determines focus. */
export interface SplitView {
  leftKey: string;
  rightKey: string;
  /** Left pane's fraction of the width. */
  ratio: number;
}

type ViewSlot = "full" | "left" | "right" | "floating";

/** Resolve actual visibility independently of tab-strip grouping/collapse. */
export function resolveWorkspaceLayout({
  tabKeys,
  activeTabKey,
  floatingKey,
  split: requestedSplit,
}: {
  /** All materialized tab keys, including tabs inside collapsed groups. */
  tabKeys: readonly string[];
  activeTabKey?: string;
  floatingKey?: string;
  split: SplitView | null;
}) {
  const keys = new Set(tabKeys);
  const split =
    requestedSplit &&
    requestedSplit.leftKey !== requestedSplit.rightKey &&
    keys.has(requestedSplit.leftKey) &&
    keys.has(requestedSplit.rightKey) &&
    (activeTabKey === requestedSplit.leftKey ||
      activeTabKey === requestedSplit.rightKey)
      ? requestedSplit
      : null;
  const viewSlots: Record<string, ViewSlot> = split
    ? { [split.leftKey]: "left", [split.rightKey]: "right" }
    : activeTabKey && keys.has(activeTabKey)
      ? { [activeTabKey]: "full" }
      : {};
  if (floatingKey && keys.has(floatingKey) && !viewSlots[floatingKey]) {
    viewSlots[floatingKey] = "floating";
  }
  return { split, viewSlots };
}
