/**
 * A connect link (ADR 0055): what an invite hands a member.
 *   catamorphic://connect?server=<api base>&token=<bearer>&project=<id>&name=<display>&renew=<url>
 *
 * Mirrors the desktop parser (apps/desktop/src/main/connect-link.ts), plus
 * one pwa-only form: an http(s) URL carrying the same query params —
 * that's what an invite web link looks like when it opens this PWA.
 */
export interface ConnectLink {
  /** API base, including the mount prefix (usually ending in `/api`). */
  serverUrl: string;
  token: string;
  remoteProjectId: string;
  remoteProjectName?: string;
  /** Where to send the user for a fresh link when the token stops working. */
  renewUrl?: string;
}

export function parseConnectLink(raw: string): ConnectLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const isCatamorphic =
    url.protocol === "catamorphic:" && url.hostname === "connect";
  const isWeb = url.protocol === "https:" || url.protocol === "http:";
  if (!isCatamorphic && !isWeb) return null;
  return connectLinkFromParams(url.searchParams);
}

/** The same fields from bare query params (the PWA's own invite URL). */
export function connectLinkFromParams(
  params: URLSearchParams,
): ConnectLink | null {
  const serverUrl = params.get("server")?.trim();
  const token = params.get("token")?.trim();
  const remoteProjectId = params.get("project")?.trim();
  if (!serverUrl || !token || !remoteProjectId) return null;
  try {
    const server = new URL(serverUrl);
    if (server.protocol !== "https:" && server.protocol !== "http:")
      return null;
  } catch {
    return null;
  }
  const name = params.get("name")?.trim();
  const renew = params.get("renew")?.trim();
  let renewUrl: string | undefined;
  if (renew) {
    try {
      const parsed = new URL(renew);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        renewUrl = renew;
      }
    } catch {
      renewUrl = undefined;
    }
  }
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token,
    remoteProjectId,
    ...(name ? { remoteProjectName: name } : {}),
    ...(renewUrl ? { renewUrl } : {}),
  };
}
