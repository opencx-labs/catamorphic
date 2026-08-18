/**
 * A connect link (ADR 0055): what an invite hands a member.
 *   catamorphic://connect?server=<api base>&token=<bearer>&project=<id>&name=<display>
 */
export interface ConnectLink {
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
  if (url.protocol !== "catamorphic:" || url.hostname !== "connect")
    return null;
  const serverUrl = url.searchParams.get("server")?.trim();
  const token = url.searchParams.get("token")?.trim();
  const remoteProjectId = url.searchParams.get("project")?.trim();
  if (!serverUrl || !token || !remoteProjectId) return null;
  try {
    const server = new URL(serverUrl);
    if (server.protocol !== "https:" && server.protocol !== "http:")
      return null;
  } catch {
    return null;
  }
  const name = url.searchParams.get("name")?.trim();
  const renew = url.searchParams.get("renew")?.trim();
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
