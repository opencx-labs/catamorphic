export const INSTALL_DISMISSED_KEY =
  "catamorphic-pwa.install-prompt-dismissed.v1";

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
