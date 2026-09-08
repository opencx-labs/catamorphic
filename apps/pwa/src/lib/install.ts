import { type ConnectLink, connectLinkFromParams } from "./connect-link.js";

export const INSTALL_DISMISSED_KEY =
  "catamorphic-pwa.install-prompt-dismissed.v1";
const REMOTE_INSTALL_LOCATOR_KEY = "catamorphic-pwa.remote-install-locator.v1";

interface InstallEnvironment {
  secureContext: boolean;
  standalone: boolean;
  dismissed: boolean;
  hasNativePrompt: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export type InstallPromotionKind = "native" | "ios";

interface RemoteInstallConnection {
  id: string;
  kind: "remote" | "device";
  serverUrl: string;
  projectId: string;
  credentials?: unknown;
}

type RemoteInstallRoute =
  | {
      kind: "sessions";
      connectionId: string;
      projectId: string;
    }
  | {
      kind: "chat";
      connectionId: string;
      projectId: string;
      sessionId: string;
    };

/** Decide whether this browser can honestly offer an install path. */
export function installPromotionKind({
  secureContext,
  standalone,
  dismissed,
  hasNativePrompt,
  userAgent,
  platform,
  maxTouchPoints,
}: InstallEnvironment): InstallPromotionKind | null {
  if (!secureContext || standalone || dismissed) return null;
  if (hasNativePrompt) return "native";
  const ios =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  return ios ? "ios" : null;
}

export function installPromptWasDismissed(storage: Storage): boolean {
  try {
    return storage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberInstallPromptDismissal(storage: Storage): void {
  try {
    storage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // Private mode can reject storage writes. Hiding for this page still works.
  }
}

/** Point installation at a safe, same-origin start URL. */
export function prepareInstallStartUrl(startUrl: string): void {
  const manifest = document.querySelector<HTMLLinkElement>(
    'link[rel="manifest"]',
  );
  if (!manifest) return;
  manifest.href = `/manifest.webmanifest?launch=${encodeURIComponent(startUrl)}`;
}

/**
 * Preserve the credential-free remote locator across storage-isolated app
 * installation. The installed app can sign in again and return to the exact
 * chat without asking the person to find and paste an invitation.
 */
export function prepareRemoteInstall(link?: ConnectLink): void {
  const startUrl = link ? remoteInstallStartUrl(link) : storedRemoteStartUrl();
  if (!startUrl) return;
  if (link) {
    try {
      localStorage.setItem(REMOTE_INSTALL_LOCATOR_KEY, startUrl);
    } catch {
      // The current document still gets the right manifest in private mode.
    }
  }
  prepareInstallStartUrl(startUrl);
}

/** Reuse an authenticated install instead of starting OAuth on every launch. */
export function connectedRemoteInstallRoute(
  link: ConnectLink,
  connections: readonly RemoteInstallConnection[],
): RemoteInstallRoute | null {
  const existing = connections.find(
    (connection) =>
      connection.kind === "remote" &&
      connection.credentials !== undefined &&
      connection.serverUrl === link.serverUrl &&
      connection.projectId === link.remoteProjectId,
  );
  if (!existing) return null;
  return link.sessionId
    ? {
        kind: "chat",
        connectionId: existing.id,
        projectId: existing.projectId,
        sessionId: link.sessionId,
      }
    : {
        kind: "sessions",
        connectionId: existing.id,
        projectId: existing.projectId,
      };
}

function remoteInstallStartUrl(link: ConnectLink): string {
  const params = new URLSearchParams({
    server: link.serverUrl,
    project: link.remoteProjectId,
    autoconnect: "1",
  });
  if (link.remoteProjectName) params.set("name", link.remoteProjectName);
  if (link.invitationId) params.set("invitation", link.invitationId);
  if (link.sessionId) params.set("session", link.sessionId);
  return `/?${params.toString()}`;
}

function storedRemoteStartUrl(): string | null {
  try {
    const stored = localStorage.getItem(REMOTE_INSTALL_LOCATOR_KEY);
    if (!stored) return null;
    const launch = new URL(stored, window.location.origin);
    if (launch.origin !== window.location.origin || launch.pathname !== "/") {
      return null;
    }
    const link = connectLinkFromParams(launch.searchParams);
    return link ? remoteInstallStartUrl(link) : null;
  } catch {
    return null;
  }
}
