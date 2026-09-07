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
  signals.on("SIGTERM", () => app.quit());
  signals.on("SIGINT", () => app.quit());
  let started = false;
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (started) return;
    started = true;
    void Promise.resolve()
      .then(shutdown)
      .then(
        () => app.exit(0),
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
      await step.dispose();
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
