import type { Route } from "./nav.js";
import {
  activeProfile,
  addConnection,
  type PwaConnection,
  type PwaState,
} from "./store.js";

/**
 * Redeem a desktop QR pairing (`/?pair=<code>`, served by the desktop's
 * LAN listener): exchange the single-use code for a device token, store
 * the desktop connection AND the profile's remote-project links — a
 * project hosted on a remote server keeps talking to that server
 * directly — and land where the desktop was: the focused chat when one
 * was open, else the projects list.
 */
export interface PairingClaim {
  version: number;
  name: string;
  /** The desktop's API base, on the address the phone actually used. */
  server: string;
  token: string;
  remotes: Array<{
    server: string;
    token: string;
    project: string;
    name: string;
    /** The desktop project this remote mirrors. */
    localProjectId?: string;
  }>;
  context?: { projectId?: string; sessionId?: string };
}

export async function claimPairing(
  origin: string,
  code: string,
): Promise<PairingClaim> {
  const response = await fetch(`${origin}/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 410
        ? "That QR code expired — generate a fresh one on the desktop."
        : `Pairing failed (${response.status}).`,
    );
  }
  return (await response.json()) as PairingClaim;
}

/** Store every connection the claim carries; the route to land on. */
export function applyPairing(state: PwaState, claim: PairingClaim): Route {
  const profile = activeProfile(state);
  // Desktop projects that also live on a remote server, keyed by the
  // desktop's project id — the failover hint when the desktop is asleep.
  const mirrors: NonNullable<PwaConnection["mirrors"]> = {};
  for (const remote of claim.remotes) {
    if (remote.localProjectId) {
      mirrors[remote.localProjectId] = {
        serverUrl: remote.server.replace(/\/+$/, ""),
        projectId: remote.project,
        name: remote.name,
      };
    }
  }
  const desktop = addConnection(
    profile.id,
    {
      serverUrl: claim.server.replace(/\/+$/, ""),
      token: claim.token,
      // A device token is root on the desktop: it covers every project.
      // The link's own project is just the deep-link target (may be "").
      remoteProjectId: claim.context?.projectId ?? "",
      remoteProjectName: claim.name,
    },
    claim.name,
    Object.keys(mirrors).length > 0 ? { mirrors } : undefined,
  );
  for (const remote of claim.remotes) {
    addConnection(profile.id, {
      serverUrl: remote.server.replace(/\/+$/, ""),
      token: remote.token,
      remoteProjectId: remote.project,
      remoteProjectName: remote.name,
    });
  }
  if (claim.context?.projectId) {
    return {
      kind: "chat",
      connectionId: desktop.id,
      projectId: claim.context.projectId,
      sessionId: claim.context.sessionId ?? null,
    };
  }
  return { kind: "projects" };
}
