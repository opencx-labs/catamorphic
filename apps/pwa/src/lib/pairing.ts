import { postJson } from "./api.js";
import type { Route } from "./nav.js";
import {
  activeProfile,
  addDeviceConnection,
  addRemoteConnection,
  type PwaConnection,
  type PwaState,
} from "./store.js";

const INSTALL_BOOTSTRAP_KEY = "catamorphic-pwa.install-bootstrap.v1";

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
  /** One-time recovery carried by the installed app's manifest start URL. */
  installCode?: string;
  remotes: Array<{
    server: string;
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
  const response = await postJson(origin, "/pair/claim", { code });
  if (!response.ok) {
    throw new Error(
      response.status === 410
        ? "That QR code expired. Generate a fresh one on the desktop."
        : `Pairing failed (${response.status}).`,
    );
  }
  return (await response.json()) as PairingClaim;
}

/** Recover a paired connection in an installed app with isolated storage. */
export async function claimPairingInstall(
  origin: string,
  code: string,
): Promise<PairingClaim> {
  const response = await postJson(origin, "/pair/install", { code });
  if (!response.ok) {
    throw new Error(
      response.status === 410
        ? "That install link expired. Scan a fresh QR on the desktop."
        : `Installed app setup failed (${response.status}).`,
    );
  }
  return (await response.json()) as PairingClaim;
}

/**
 * Point Add to Home Screen at a one-time bootstrap URL. Some mobile browsers
 * launch the installed app in a storage container that does not contain the
 * pairing page's localStorage, so the start URL must be able to restore it.
 */
export function preparePairingInstall(installCode?: string): void {
  let code = installCode;
  try {
    code ??= localStorage.getItem(INSTALL_BOOTSTRAP_KEY) ?? undefined;
    if (installCode) localStorage.setItem(INSTALL_BOOTSTRAP_KEY, installCode);
  } catch {
    // Storage can be unavailable in private mode. The current document can
    // still point its manifest at a newly issued bootstrap.
  }
  if (!code) return;
  const manifest = document.querySelector<HTMLLinkElement>(
    'link[rel="manifest"]',
  );
  if (!manifest) return;
  manifest.href = `/manifest.webmanifest?install=${encodeURIComponent(code)}`;
}

/** Store every connection the claim carries; the route to land on. */
export function applyPairing(state: PwaState, claim: PairingClaim): Route {
  preparePairingInstall(claim.installCode);
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
  const desktop = addDeviceConnection({
    profileId: profile.id,
    serverUrl: claim.server,
    name: claim.name,
    accessToken: claim.token,
    ...(Object.keys(mirrors).length > 0 ? { mirrors } : {}),
  });
  for (const remote of claim.remotes) {
    addRemoteConnection({
      profileId: profile.id,
      link: {
        serverUrl: remote.server.replace(/\/+$/, ""),
        remoteProjectId: remote.project,
        remoteProjectName: remote.name,
      },
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
