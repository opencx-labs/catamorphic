import { app } from "electron";
import { type DockClicks, dockClicksFor } from "../shared/dock-clicks.js";

let decided: DockClicks | undefined;

/** Electron runs natively on Wayland when its ozone platform says so. */
function onWayland(): boolean {
  if (process.platform !== "linux") return false;
  const platform =
    app.commandLine.getSwitchValue("ozone-platform") ||
    app.commandLine.getSwitchValue("ozone-platform-hint");
  if (platform === "wayland") return true;
  if (platform === "x11") return false;
  // The default hint ("auto") picks Wayland inside a Wayland session.
  return (
    Boolean(process.env.WAYLAND_DISPLAY) ||
    process.env.XDG_SESSION_TYPE === "wayland"
  );
}

/** How the detached dock lets clicks through, decided once per process. */
export function dockClicks(): DockClicks {
  decided ??= dockClicksFor({
    platform: process.platform,
    wayland: onWayland(),
  });
  return decided;
}
