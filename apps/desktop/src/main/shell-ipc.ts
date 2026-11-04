import { ipcMain, type WebContents } from "electron";
import { isSameShellDocument, isShellDocument } from "./shell-document.js";

type ShellRegistration = {
  contents: WebContents;
  documentUrl: string;
} & (
  | { surface: "workspace"; channels?: never }
  | { surface: "passkey-sheet" | "voice"; channels: readonly string[] }
);

const shells = new WeakMap<
  WebContents,
  {
    documentUrl: string;
    channels: ReadonlySet<string> | null;
    surface: ShellRegistration["surface"];
  }
>();

function documentIdentity(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

function documentOrigin(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}`;
}

/** Register only native-created Work documents, before loading their URL. */
export function registerShellContents(input: ShellRegistration): () => void {
  if (!isShellDocument(input.documentUrl))
    throw new Error("Invalid Work shell document");
  const registration = {
    documentUrl: documentIdentity(input.documentUrl),
    surface: input.surface,
    channels: input.surface === "workspace" ? null : new Set(input.channels),
  };
  shells.set(input.contents, registration);
  const release = () => {
    if (shells.get(input.contents) === registration)
      shells.delete(input.contents);
  };
  input.contents.once("destroyed", release);
  return release;
}

export function isRegisteredShellContents(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  const registered = shells.get(contents);
  if (!registered) return false;
  try {
    return isSameShellDocument(registered.documentUrl, contents.getURL());
  } catch {
    return false;
  }
}

/** Surface identity is assigned by native code, never read from renderer metadata. */
export function shellSurfaceFor(
  contents: WebContents,
): ShellRegistration["surface"] | undefined {
  return isRegisteredShellContents(contents)
    ? shells.get(contents)?.surface
    : undefined;
}

/** Check the current main frame as well as its registered document and grant. */
export function assertShellSender({
  event,
  channel,
}: {
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;
  channel: string;
}): void {
  const registered = shells.get(event.sender);
  const frame = event.senderFrame;
  if (
    !registered ||
    !isRegisteredShellContents(event.sender) ||
    !frame ||
    frame.detached ||
    frame !== event.sender.mainFrame ||
    frame.parent !== null ||
    frame.origin !== documentOrigin(registered.documentUrl) ||
    !isSameShellDocument(registered.documentUrl, frame.url) ||
    (registered.channels !== null && !registered.channels.has(channel))
  )
    throw new Error("This action requires a trusted Work window.");
}

const listenerDisposers = new WeakMap<object, Map<string, () => void>>();

/** Per-handler authorization. Electron's process-wide ipcMain is never patched. */
export const shellIpcMain = {
  handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result,
  ): void {
    ipcMain.handle(channel, (event, ...args: Args) => {
      assertShellSender({ event, channel });
      return listener(event, ...args);
    });
  },
  on<Args extends unknown[]>(
    channel: string,
    listener: (event: Electron.IpcMainEvent, ...args: Args) => void,
  ): void {
    const guarded = (event: Electron.IpcMainEvent, ...args: Args) => {
      try {
        assertShellSender({ event, channel });
      } catch {
        // Event IPC has no rejection reply. Drop untrusted messages without
        // letting a hostile renderer throw through the main event emitter.
        return;
      }
      listener(event, ...args);
    };
    ipcMain.on(channel, guarded);
    const disposers = listenerDisposers.get(listener) ?? new Map();
    disposers.set(channel, () => ipcMain.removeListener(channel, guarded));
    listenerDisposers.set(listener, disposers);
  },
  removeHandler(channel: string): void {
    ipcMain.removeHandler(channel);
  },
  removeListener(channel: string, listener: object): void {
    listenerDisposers.get(listener)?.get(channel)?.();
    listenerDisposers.get(listener)?.delete(channel);
  },
  off(channel: string, listener: object): void {
    shellIpcMain.removeListener(channel, listener);
  },
};
