interface QuitEvent {
  preventDefault(): void;
}

interface ShutdownApp {
  on(event: "will-quit", listener: (event: QuitEvent) => void): unknown;
  exit(code: number): void;
}

/** Keep services alive until all windows have accepted closing. */
export function registerDesktopShutdown({
  app,
  shutdown,
  onError,
}: {
  app: ShutdownApp;
  shutdown: () => Promise<void>;
  onError: (error: unknown) => void;
}): void {
  let started = false;
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (started) return;
    started = true;
    void Promise.resolve()
      .then(shutdown)
      .catch(onError)
      .finally(() => {
        // All windows have already accepted closing and storage is flushed.
        // Do not start another cancellable quit cycle against disposed services.
        app.exit(0);
      });
  });
}
