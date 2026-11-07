import type { ChildProcess } from "node:child_process";

/** Processes started with detached:true own their group on Unix. */
export function signalProcessGroup(input: {
  child: ChildProcess;
  signal: NodeJS.Signals;
}) {
  if (!input.child.pid) return;
  try {
    if (process.platform === "win32") input.child.kill(input.signal);
    else process.kill(-input.child.pid, input.signal);
  } catch (error) {
    // macOS may return EPERM for an exited group awaiting reaping.
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ESRCH" || error.code === "EPERM")
      )
    )
      throw error;
  }
}
