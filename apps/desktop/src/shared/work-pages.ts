/**
 * Work's own dialogs that open on a project's file (ADR 0234): addresses a
 * row or an action can name, like a chat's `catamorphic://chat`. What needs
 * no file is a command instead (`command:server-members`).
 */
export type WorkPage =
  | { page: "server-history"; path: string }
  | { page: "server-publish"; path: string }
  | { page: "server-propose"; paths: string[] };

export function workPageUrl(page: WorkPage): string {
  const url = new URL(
    `catamorphic://server/${page.page.slice("server-".length)}`,
  );
  for (const path of page.page === "server-propose" ? page.paths : [page.path])
    url.searchParams.append("path", path);
  return url.href;
}

export function parseWorkPage(value: string): WorkPage | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "catamorphic:" || url.hostname !== "server")
      return null;
    const paths = url.searchParams.getAll("path").filter(Boolean);
    const [path] = paths;
    if (!path) return null;
    switch (url.pathname) {
      case "/history":
        return { page: "server-history", path };
      case "/publish":
        return { page: "server-publish", path };
      case "/propose":
        return { page: "server-propose", paths };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
