import { useEffect, useSyncExternalStore } from "react";

export interface Microphone {
  id: string;
  label: string;
  /** The system's default microphone now, which "System default" follows. */
  isDefault: boolean;
}

/** How often an open menu reads the microphones again. */
const WATCH_MS = 1_000;

/**
 * The microphones in a device list. "default" and "communications" are
 * Chromium's aliases of real devices: the menu's first entry already
 * follows the system. The default alias names the device it stands for
 * ("Default - MacBook Pro Microphone") and shares its group, which marks
 * that device as the default.
 */
export function microphonesOf(
  devices: readonly Pick<
    MediaDeviceInfo,
    "kind" | "deviceId" | "groupId" | "label"
  >[],
): Microphone[] {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const alias = inputs.find((device) => device.deviceId === "default");
  const real = inputs.filter(
    (device) =>
      device.deviceId !== "default" && device.deviceId !== "communications",
  );
  const named = alias?.label.replace(/^Default - /, "");
  const defaultId = alias
    ? (
        real.find(
          (device) =>
            device.groupId === alias.groupId && device.label === named,
        ) ??
        real.find((device) => device.label === named) ??
        real.find((device) => device.groupId === alias.groupId)
      )?.deviceId
    : undefined;
  return real.map((device, index) => ({
    id: device.deviceId,
    label: device.label || `Microphone ${index + 1}`,
    isDefault: device.deviceId === defaultId,
  }));
}

/**
 * The microphones this machine has, read once for every microphone and
 * kept current as devices come and go, while anything shows them. A menu
 * that lists them also reads them every second while it is open: macOS
 * does not report every change (a Bluetooth headset connecting, the
 * default moving to it) as one.
 */
const microphoneList = (() => {
  let list: Microphone[] = [];
  let key = "";
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let watchers = 0;
  let watch: ReturnType<typeof setInterval> | undefined;
  const read = () =>
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => {
        const next = microphonesOf(all);
        const nextKey = JSON.stringify(next);
        // Unchanged, the list keeps its identity: nothing redraws.
        if (nextKey === key) return;
        key = nextKey;
        list = next;
        for (const listener of listeners) listener();
      })
      .catch(() => {});
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const devices = navigator.mediaDevices;
      if (!stop && devices) {
        read();
        devices.addEventListener("devicechange", read);
        stop = () => devices.removeEventListener("devicechange", read);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    get: () => list,
    watch() {
      watchers += 1;
      if (watchers === 1) {
        read();
        watch = setInterval(read, WATCH_MS);
      }
      return () => {
        watchers -= 1;
        if (watchers === 0) clearInterval(watch);
      };
    },
  };
})();

export function useMicrophones(): Microphone[] {
  return useSyncExternalStore(microphoneList.subscribe, microphoneList.get);
}

/** While `watching` (a menu listing them is open), they are read every second. */
export function useWatchedMicrophones(watching: boolean) {
  useEffect(() => (watching ? microphoneList.watch() : undefined), [watching]);
}
