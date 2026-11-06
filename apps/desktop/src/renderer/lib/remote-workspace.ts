/*
 * Working in a remote chat's workspace from the desktop (ADR 0209): its
 * terminals and previews. The last preview port is remembered per chat in
 * this browser's storage, a convenience that may be missing.
 */

const PREVIEW_PORTS_KEY = "work.previewPorts";
/** Chats whose last port is kept; older ones are forgotten. */
const PREVIEW_PORTS_KEPT = 100;

/** The port last previewed for this chat, when this computer remembers. */
export function lastPreviewPort(sessionId: string): number | undefined {
  const port = readPorts()[sessionId];
  return typeof port === "number" && validPreviewPort(port) ? port : undefined;
}

export function rememberPreviewPort(sessionId: string, port: number): void {
  const ports = readPorts();
  delete ports[sessionId];
  ports[sessionId] = port;
  const kept = Object.entries(ports).slice(-PREVIEW_PORTS_KEPT);
  try {
    localStorage.setItem(
      PREVIEW_PORTS_KEY,
      JSON.stringify(Object.fromEntries(kept)),
    );
  } catch {
    // Storage may be unavailable; the next preview asks again.
  }
}

export function validPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function readPorts(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(PREVIEW_PORTS_KEY) ?? "{}",
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  } catch {
    return {};
  }
}

/**
 * Why a desktop request failed, in its source's words. Electron prefixes an
 * error that crossed IPC with the channel; that part is dropped.
 */
export function ipcErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") ||
    "Something went wrong."
  );
}
