/** Electron's native preparation is separate from consent to actually quit. */
interface NativeUpdater {
  on(event: "update-downloaded", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "update-downloaded", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): void;
}

export function createUpdatePreparation({
  updater,
  timeoutMs = 120_000,
}: {
  updater: NativeUpdater;
  timeoutMs?: number;
}) {
  let ready = false;
  let pending: Promise<void> | null = null;
  let cancel: (() => void) | undefined;
  const markReady = () => {
    ready = true;
  };
  updater.on("update-downloaded", markReady);
  return {
    prepare(): Promise<void> {
      if (ready) return Promise.resolve();
      if (pending) return pending;
      pending = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          updater.removeListener("update-downloaded", done);
          updater.removeListener("error", failed);
          cancel = undefined;
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(
          () =>
            failed(
              new Error(
                "Update preparation timed out. Your work is safe. Try restarting the update again.",
              ),
            ),
          timeoutMs,
        );
        cancel = () => failed(new Error("Update preparation was cancelled"));
        updater.on("update-downloaded", done);
        updater.on("error", failed);
        try {
          updater.checkForUpdates();
        } catch (cause) {
          failed(
            cause instanceof Error
              ? cause
              : new Error("Could not prepare the update"),
          );
        }
      }).finally(() => {
        pending = null;
      });
      return pending;
    },
    dispose() {
      cancel?.();
      updater.removeListener("update-downloaded", markReady);
    },
  };
}
