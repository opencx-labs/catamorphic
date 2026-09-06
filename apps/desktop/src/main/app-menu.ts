import type { MenuItemConstructorOptions } from "electron";

export function macApplicationMenu({
  appName,
  checkForUpdates,
}: {
  appName: string;
  checkForUpdates: () => void;
}) {
  return {
    label: appName,
    submenu: [
      { role: "about" },
      { label: "Check for Updates…", click: checkForUpdates },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  } satisfies MenuItemConstructorOptions;
}
