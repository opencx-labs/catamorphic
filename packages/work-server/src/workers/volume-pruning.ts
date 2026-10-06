import type { SandboxProvider } from "@catamorphic/sandbox";

/** How often a machine looks for volumes nobody used for long. */
export const VOLUME_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Forget volumes no sandbox used for `retentionMs` (ADR 0208,
 * `WORK_VOLUME_RETENTION_DAYS`), once at start and then every hour, on a
 * machine whose provider keeps volumes. Returns a stop function.
 */
export function startVolumePruning(args: {
  provider: Pick<SandboxProvider, "volumes">;
  retentionMs: number;
  intervalMs?: number;
  log?: (line: string) => void;
}): () => void {
  const volumes = args.provider.volumes;
  if (!volumes) return () => {};
  // One pass at a time: a slow daemon never stacks passes.
  let pruning = false;
  const prune = () => {
    if (pruning) return;
    pruning = true;
    void volumes
      .prune({ unusedForMs: args.retentionMs })
      .then((removed) => {
        if (removed.length > 0)
          args.log?.(
            `Removed ${removed.length} unused volume${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`,
          );
      })
      .catch((error: unknown) =>
        args.log?.(
          `Pruning unused volumes failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pruning = false;
      });
  };
  prune();
  const timer = setInterval(prune, args.intervalMs ?? VOLUME_PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
