interface FrameLike {
  readonly detached: boolean;
  isDestroyed(): boolean;
}

/**
 * The frames of a page that are still there to read or message. Electron
 * types `framesInSubtree` as frames only, but an entry comes back null for a
 * frame being created or torn down as the page loads, and reading it threw
 * an uncaught exception in the main process.
 */
export function liveFrames<Frame extends FrameLike>(
  frames: ReadonlyArray<Frame | null | undefined> | undefined,
): Frame[] {
  return (frames ?? []).filter(
    (frame): frame is Frame =>
      frame != null && !frame.detached && !frame.isDestroyed(),
  );
}
