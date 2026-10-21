/**
 * An open workspace tab as a composer's @ mention lists it (ADR 0272): the
 * key read_tab takes and what the tab shows, from the overview the agent
 * reads.
 */
export interface WorkspaceTabRef {
  key: string;
  kind: string;
  title: string;
  url?: string;
  filePath?: string;
  /** The tab in front. */
  active: boolean;
}

/** One overview tab, or null when it is not a tab a person can mention. */
export function workspaceTabRef(value: unknown): WorkspaceTabRef | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof tab[key] === "string" && tab[key] ? (tab[key] as string) : undefined;
  const key = text("key");
  const kind = text("kind");
  // Chip-only surfaces own no tab the person sees.
  if (!key || !kind || tab.background === true) return null;
  const filePath = text("filePath");
  const url = text("url");
  const title =
    text("title") ?? text("name") ?? filePath?.split("/").at(-1) ?? url ?? kind;
  return {
    key,
    kind,
    title,
    ...(url ? { url } : {}),
    ...(filePath ? { filePath } : {}),
    active: tab.active === true,
  };
}
