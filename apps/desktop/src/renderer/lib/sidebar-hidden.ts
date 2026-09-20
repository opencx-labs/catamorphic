/**
 * Drops hidden items together with their descendants. Hiding only the row
 * would hoist its children to the top level: hiding `.catamorphic` in a
 * project files section used to spill the workspace's folders into it.
 */
export function dropHiddenSubtrees<
  T extends { id: string; parentId?: string | null },
>(items: readonly T[], isHidden: (item: T) => boolean): T[] {
  const hidden = new Set(items.filter(isHidden).map((item) => item.id));
  let grew = hidden.size > 0;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (hidden.has(item.id) || !item.parentId || !hidden.has(item.parentId))
        continue;
      hidden.add(item.id);
      grew = true;
    }
  }
  return items.filter((item) => !hidden.has(item.id));
}
