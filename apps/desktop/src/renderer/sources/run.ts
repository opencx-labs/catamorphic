import { type OpenMode, openModeForAction } from "../../shared/open-mode.js";
import type { SidebarSourceEffect } from "../../shared/sidebar.js";
import type {
  SidebarSourceItem,
  SidebarSourceSession,
} from "../../shared/sidebar-source.js";
import type { SectionSource } from "./contract.js";

const VERB_FOR_MODE: Record<OpenMode, string> = {
  replace: "open-here",
  tab: "open-tab",
  side: "open-side",
  floating: "open-floating",
};

/** The verbs that open a row, by the mode each one opens in. */
export const isOpenAction = (action: string) =>
  action === "open" || Boolean(openModeForAction(action));

/**
 * The one way a row acts, wherever it is (a section, a palette row, an app
 * widget, a module calling `work.execute`; ADR 0234). Open verbs open the
 * row's address, or go to its source when it has none; copy-url copies the
 * address; anything else is the source's action, whose effect Work then
 * carries out.
 */
export async function runRowAction({
  source,
  row,
  itemId,
  action,
  values,
  mode,
  session,
  signal,
  open,
}: {
  source: SectionSource;
  /** The row, when it is loaded; header actions have none. */
  row?: SidebarSourceItem;
  itemId: string;
  action: string;
  values?: Record<string, string>;
  /** How "open" opens (a click's modifiers); other verbs name their own. */
  mode?: OpenMode;
  session?: SidebarSourceSession;
  signal: AbortSignal;
  /** Open a workspace target as this place opens links. */
  open: (url: string, mode: OpenMode) => unknown;
}): Promise<SidebarSourceEffect | undefined> {
  if (isOpenAction(action) && row?.url) {
    await open(
      row.url,
      openModeForAction(action) ?? mode ?? row.open ?? "replace",
    );
    return undefined;
  }
  if (action === "copy-url") {
    if (!row?.url) throw new Error("This row has no address to copy.");
    await navigator.clipboard.writeText(row.url);
    return undefined;
  }
  if (!source.action)
    throw new Error("This list does not support that action.");
  const effect = await source.action({
    itemId,
    // A plain open passes the mode it was asked in as its verb.
    action: action === "open" && mode ? VERB_FOR_MODE[mode] : action,
    ...(values ? { values } : {}),
    ...(session ? { session } : {}),
    signal,
  });
  if (effect?.open) await open(effect.open, effect.mode ?? "replace");
  return effect;
}
