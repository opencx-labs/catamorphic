/** "github.com" for "https://www.github.com/pulls": what a person calls the site. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The URL without its scheme or www., as people type it. */
export const bareUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, "");

/**
 * The origins a bare typed host ("localhost", "github.com") was visited at,
 * port included and the most visited first: "localhost" →
 * ["http://localhost:3000", "http://localhost:5173"]. A typed scheme, port
 * or path is already specific, so it has none.
 */
export function rememberedOrigins(
  typed: string,
  pages: readonly { url: string; visitCount: number }[],
): string[] {
  const host = typed
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return [];
  const visits = new Map<string, number>();
  for (const page of pages) {
    let url: URL;
    try {
      url = new URL(page.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.hostname.replace(/^www\./, "") !== host) continue;
    visits.set(url.origin, (visits.get(url.origin) ?? 0) + page.visitCount);
  }
  return [...visits].sort((a, b) => b[1] - a[1]).map(([origin]) => origin);
}
