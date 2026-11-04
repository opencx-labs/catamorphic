import type { contextBridge } from "electron";
import { SHELL_WINDOW_ARGUMENT } from "../shared/desktop-workspace.js";

/**
 * Electron's DOM close path destroys WebContents without the cancelable native
 * window close event. Keep workspace/dock close on their native lifecycle.
 * https://github.com/electron/electron/blob/v45.0.0-beta.7/shell/browser/api/electron_api_web_contents.cc#L1822-L1835
 */
export function installShellWindowClose({
  bridge,
  requestClose,
  isMainFrame,
  argv,
}: {
  bridge: Pick<typeof contextBridge, "executeInMainWorld">;
  requestClose: () => void;
  isMainFrame: boolean;
  argv: readonly string[];
}): void {
  if (!isMainFrame || !argv.includes(SHELL_WINDOW_ARGUMENT)) return;
  // executeInMainWorld serializes the body and proxies the callback through
  // its args. No isolated-world closure or general IPC reaches the page.
  bridge.executeInMainWorld({
    func: (close: () => void) => {
      window.close = close;
    },
    args: [requestClose],
  });
}
