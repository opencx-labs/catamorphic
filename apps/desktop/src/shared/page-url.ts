/**
 * Whether two addresses show the same page: the fragment and a trailing
 * slash do not make another one. The bookmark star and switching to a
 * page's open tab both ask.
 */
export function samePage(a: string, b: string): boolean {
  return pageKey(a) === pageKey(b);
}

function pageKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}
