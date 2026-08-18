/**
 * A connect link (ADR 0055): what an invite hands a member.
 *   catamorphic://connect?server=<api base>&token=<bearer>&project=<id>&name=<display>
 */
export interface ConnectLink {
  serverUrl: string;
  token: string;
  remoteProjectId: string;
  remoteProjectName?: string;
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
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token,
    remoteProjectId,
    ...(name ? { remoteProjectName: name } : {}),
  };
}
