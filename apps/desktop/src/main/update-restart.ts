import fs from "node:fs";
import path from "node:path";

/**
 * A relaunch after an update starts in the background (the installer
 * launches it, not the user). The quitting instance leaves this marker so
 * the next launch knows to bring its window to the front.
 */
export function updateRestartMarkerPath(userData: string): string {
  return path.join(userData, "update-restart");
}

export function markUpdateRestart(userData: string): void {
  try {
    fs.writeFileSync(updateRestartMarkerPath(userData), `${Date.now()}\n`);
  } catch {
    /* Losing the marker only costs the focus after relaunch. */
  }
}

/** True once per marker: the launch that consumes it is the relaunch. */
export function consumeUpdateRestart(userData: string): boolean {
  const marker = updateRestartMarkerPath(userData);
  try {
    fs.unlinkSync(marker);
    return true;
  } catch {
    return false;
  }
}
