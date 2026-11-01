import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const INSPECT_OPTIONS = { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 };

interface Process {
  pid: number;
  parent: number;
  group: number;
  state: string;
}

function code(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

async function processes(): Promise<Process[]> {
  const { stdout } = await execute(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,stat="],
    INSPECT_OPTIONS,
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, parent, group, state] = line.trim().split(/\s+/);
      if (
        !pid ||
        !parent ||
        !group ||
        !state ||
        !/^\d+$/.test(pid + parent + group)
      )
        throw new Error("Cannot inspect test process identities");
      return {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        state,
      };
    });
}

async function workingDirectories(): Promise<Map<number, string>> {
  if (process.platform === "linux") {
    const entries = await readdir("/proc");
    const paths = new Map<number, string>();
    await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          try {
            paths.set(Number(entry), await readlink(`/proc/${entry}/cwd`));
          } catch (error) {
            if (
              !["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(
                String(code(error)),
              )
            )
              throw error;
          }
        }),
    );
    return paths;
  }
  if (process.platform !== "darwin") return new Map();
  const { stdout } = await execute(
    "lsof",
    ["-n", "-P", "-a", "-u", String(process.getuid?.()), "-d", "cwd", "-F0pn"],
    INSPECT_OPTIONS,
  );
  const paths = new Map<number, string>();
  let pid: number | undefined;
  for (const record of stdout.split("\0")) {
    const field = record.replace(/^\n/, "");
    if (field.startsWith("p")) {
      pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid test process identity from lsof");
    } else if (field.startsWith("n") && pid !== undefined) {
      paths.set(pid, field.slice(1));
    }
  }
  return paths;
}

function beneath(directory: string, root: string): boolean {
  // A process can retain its cwd after a failed fixture removed it.
  const value = directory.replace(/ \(deleted\)$/, "");
  return value === root || value.startsWith(root + path.sep);
}

async function assertPrivateRoot(root: string): Promise<void> {
  const [systemTemp, home, controllerCwd] = await Promise.all([
    realpath(tmpdir()),
    realpath(homedir()),
    realpath(process.cwd()),
  ]);
  if (
    !path.isAbsolute(root) ||
    root === path.parse(root).root ||
    beneath(systemTemp, root) ||
    beneath(home, root) ||
    beneath(controllerCwd, root)
  )
    throw new Error(`Refusing unsafe test temporary root ${root}`);
}

/** Reclaim fixture-owned read-only snapshots, never a symlink's target. */
export async function removeTestDirectory(root: string): Promise<void> {
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Refusing a symlink as the test temporary root");
  const canonical = await realpath(root);
  await assertPrivateRoot(canonical);
  const writable = async (directory: string): Promise<void> => {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) return;
    await chmod(directory, stat.mode | 0o700);
    for (const entry of await readdir(directory))
      await writable(path.join(directory, entry));
  };
  // Process cleanup must finish before reclaiming directories or removing them.
  await writable(canonical);
  await rm(canonical, { recursive: true, force: true, maxRetries: 5 });
}

function signal(group: number, value: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? group : -group, value);
  } catch (error) {
    if (
      code(error) !== "ESRCH" &&
      !(process.platform === "darwin" && code(error) === "EPERM")
    )
      throw error;
  }
}

/** Test phases also own detached groups beneath their private temporary root. */
export async function settleTestProcesses(input: {
  processGroupId?: number;
  temporaryRoot?: string;
  signal: NodeJS.Signals;
  graceMs?: number;
  killWaitMs?: number;
}): Promise<void> {
  if (input.temporaryRoot) await assertPrivateRoot(input.temporaryRoot);
  if (
    input.processGroupId !== undefined &&
    (!Number.isSafeInteger(input.processGroupId) || input.processGroupId <= 1)
  )
    throw new Error("Test process group must be greater than one");
  const groups = new Set(
    input.processGroupId === undefined ? [] : [input.processGroupId],
  );
  const inspect = async () => {
    const [table, directories] = await Promise.all([
      processes(),
      input.temporaryRoot
        ? workingDirectories()
        : Promise.resolve(new Map<number, string>()),
    ]);
    const ownGroup = table.find((entry) => entry.pid === process.pid)?.group;
    if (!ownGroup)
      throw new Error("Cannot identify the test controller's process group");
    const owned = new Set(
      table
        .filter((entry) => groups.has(entry.group))
        .map((entry) => entry.pid),
    );
    for (const entry of table) {
      const cwd = directories.get(entry.pid);
      if (cwd && input.temporaryRoot && beneath(cwd, input.temporaryRoot))
        owned.add(entry.pid);
    }
    let size = -1;
    while (size !== owned.size) {
      size = owned.size;
      for (const entry of table)
        if (owned.has(entry.parent)) owned.add(entry.pid);
    }
    for (const entry of table) {
      if (!owned.has(entry.pid)) continue;
      if (
        entry.pid === process.pid ||
        entry.group <= 1 ||
        entry.group === ownGroup
      )
        throw new Error(`Refusing unsafe test cleanup group ${entry.group}`);
      groups.add(entry.group);
    }
    return table;
  };
  const remaining = (table: Process[]) =>
    new Set(
      table
        .filter(
          (entry) => groups.has(entry.group) && !entry.state.startsWith("Z"),
        )
        .map((entry) => entry.group),
    );
  const termDeadline = performance.now() + (input.graceMs ?? 5_000);
  const killDeadline = termDeadline + (input.killWaitMs ?? 5_000);
  const signalled = new Map<number, NodeJS.Signals>();
  for (;;) {
    const table = await inspect();
    const live = remaining(table);
    if (!live.size) return;
    const now = performance.now();
    if (now >= killDeadline)
      throw new Error(
        `Test process groups ${[...live].join(", ")} survived cleanup`,
      );
    const next = now >= termDeadline ? "SIGKILL" : input.signal;
    // Inspection revalidates membership immediately before signaling. A
    // disappeared group is harmless; never search by command name.
    for (const group of live) {
      if (signalled.get(group) !== next) {
        signal(group, next);
        signalled.set(group, next);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** Run before the disposable database stops and before its directories go. */
export async function withTestProcessCleanup<T>(
  temporaryRoot: string,
  task: () => Promise<T>,
): Promise<T> {
  temporaryRoot = await realpath(temporaryRoot);
  await assertPrivateRoot(temporaryRoot);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await task() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await settleTestProcesses({ temporaryRoot, signal: "SIGTERM" });
  } catch (error) {
    if ("error" in outcome)
      throw new AggregateError(
        [outcome.error, error],
        "Test phase and final process cleanup failed",
      );
    throw error;
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
