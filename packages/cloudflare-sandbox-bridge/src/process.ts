/** Ask GNU timeout to apply its configured signal to its whole process group. */
const SIGALRM = 14;

/**
 * Native signals address one process and must never fire after it exits.
 * GNU timeout owns a process group, so its alarm kills ordinary descendants
 * too. It enforces the deadline even if this Durable Object leaves memory;
 * no Worker deadline timer remains that could signal a completed process.
 */
export async function startManagedProcess({
  container,
  argv,
  options,
  request,
  timeoutMs,
}: {
  container: Pick<Container, "exec">;
  argv: string[];
  options?: Omit<ContainerExecOptions, "signal">;
  request: Request;
  timeoutMs: number;
}): Promise<{
  process: ExecProcess;
  stop: () => void;
  interrupted: () => boolean;
}> {
  request.signal.throwIfAborted();
  let process: ExecProcess | undefined;
  let active = true;
  let interrupted = false;
  let signalled = false;
  const signalProcess = () => {
    if (!active || !process || signalled) return;
    signalled = true;
    process.kill(SIGALRM);
  };
  const stop = () => {
    if (!active || interrupted) return;
    interrupted = true;
    signalProcess();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  const cleanup = () => {
    active = false;
    request.signal.removeEventListener("abort", stop);
  };
  try {
    process = await container.exec(
      ["timeout", "--signal=KILL", "--", `${timeoutMs / 1_000}s`, ...argv],
      options,
    );
    // Observe both success and failure, even when stdout is still being read.
    void process.exitCode.then(cleanup, cleanup);
    // An already-finished process must not receive a cancellation queued while
    // exec() was starting it. Let its registered exit callback run first.
    await Promise.resolve();
    if (active && interrupted) signalProcess();
    return { process, stop, interrupted: () => interrupted };
  } catch (error) {
    cleanup();
    throw error;
  }
}
