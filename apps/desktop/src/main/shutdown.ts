interface QuitEvent {
  preventDefault(): void;
}

interface ShutdownApp {
  on(event: "will-quit", listener: (event: QuitEvent) => void): unknown;
  exit(code: number): void;
  quit(): void;
}

/** Keep services alive until all windows have accepted closing. */
export function registerDesktopShutdown({
  app,
  shutdown,
  onError,
  signals = process,
}: {
  app: ShutdownApp;
  shutdown: () => Promise<void>;
  onError: (error: unknown) => void;
  signals?: { on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown };
}): void {
  // Development runners and test harnesses must use the same cleanup as Quit.
  const requestQuit = (signal: string) => {
    console.info(`[desktop] Quit requested by ${signal}`);
    app.quit();
  };
  signals.on("SIGTERM", () => requestQuit("SIGTERM"));
  signals.on("SIGINT", () => requestQuit("SIGINT"));
  let started = false;
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (started) return;
    started = true;
    console.info("[desktop] Windows closed; shutting down services");
    void Promise.resolve()
      .then(shutdown)
      .then(
        () => {
          console.info("[desktop] Shutdown complete");
          app.exit(0);
        },
        (error: unknown) => {
          // Windows have accepted closing. Do not begin another cancellable
          // quit cycle against disposed services, or claim that storage flushed.
          try {
            onError(error);
          } finally {
            app.exit(1);
          }
        },
      );
  });
}

/** Stop producers in order, then storage, attempting every cleanup on failure. */
export async function shutdownDesktopServices({
  steps,
}: {
  steps: Array<{ name: string; dispose: () => void | Promise<void> }>;
}) {
  const errors: Error[] = [];
  for (const step of steps) {
    try {
      console.info(`[desktop] Closing ${step.name}`);
      await step.dispose();
      console.info(`[desktop] Closed ${step.name}`);
    } catch (cause) {
      errors.push(new Error(`Could not close ${step.name}`, { cause }));
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Desktop shutdown did not complete cleanly",
    );
}
