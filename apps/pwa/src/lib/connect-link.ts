/**
 * A credential-free remote locator. Authentication happens separately in
 * the browser with OAuth authorization code plus PKCE.
 *   catamorphic://connect?server=<api base>&project=<id>&name=<display>
 *
 * Mirrors the desktop parser (apps/desktop/src/main/connect-link.ts), plus
 * one pwa-only form: an http(s) URL carrying the same query params —
 * that's what an invite web link looks like when it opens this PWA.
 */
export interface ConnectLink {
  /** API base, including the mount prefix (usually ending in `/api`). */
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName?: string;
  invitationId?: string;
  /** Deep-link: land in this chat after connecting (a mirrored session). */
  sessionId?: string;
}

/** OAuth credentials may only cross HTTPS, except on this machine. */
export function isSecureRemoteUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
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
  const remoteProjectId = params.get("project")?.trim();
  if (!serverUrl || !remoteProjectId || params.has("token")) return null;
  if (!isSecureRemoteUrl(serverUrl)) return null;
  const name = params.get("name")?.trim();
  const invitationId = params.get("invitation")?.trim();
  const sessionId = params.get("session")?.trim();
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    remoteProjectId,
    ...(name ? { remoteProjectName: name } : {}),
    ...(invitationId ? { invitationId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
