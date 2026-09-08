/**
 * A connect link (ADR 0055): what an invite hands a member.
 *   catamorphic://connect?server=<api base>&project=<id>&name=<display>
 */
export interface ConnectLink {
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName?: string;
  invitationId?: string;
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
  if (url.protocol !== "catamorphic:" || url.hostname !== "connect")
    return null;
  const serverUrl = url.searchParams.get("server")?.trim();
  const remoteProjectId = url.searchParams.get("project")?.trim();
  if (!serverUrl || !remoteProjectId || url.searchParams.has("token"))
    return null;
  if (!isSecureRemoteUrl(serverUrl)) return null;
  const name = url.searchParams.get("name")?.trim();
  const invitationId = url.searchParams.get("invitation")?.trim();
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    remoteProjectId,
    ...(name ? { remoteProjectName: name } : {}),
    ...(invitationId ? { invitationId } : {}),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
