import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, readFileSync, watch } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  SidebarSourceCapabilities,
  SidebarSourceRequest,
} from "../shared/sidebar-source.js";
import { registerProcessOwner } from "./process-owners.js";

const responseSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  move: z.boolean().optional(),
  drop: z.boolean().optional(),
  reveal: z.boolean().optional(),
  requestId: z.string().optional(),
  call: z.unknown().optional(),
});
/** How often a subscribed source checks its module for edits the watch missed. */
const MODULE_POLL_MS = 2_000;
/** How long a worker may take to start and load its module. */
const START_TIMEOUT_MS = 30_000;
/** A shared, lazy process per module. Idle sources cost no process or polling. */
/** Calls to Work one request may have outstanding at once. */
const MAX_WORK_CALLS = 8;

export class SidebarSourceRuntime {
  /** Reported by the worker once its module loads; false until then. */
  capabilities: SidebarSourceCapabilities = {
    move: false,
    drop: false,
    reveal: false,
  };
  private child?: ChildProcess;
  private starting?: Promise<ChildProcess>;
  private idle?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private unpoll?: () => void;
  private disposed = false;
  private generation = 0;
  private listeners = new Set<(error?: string) => void>();
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      /** Set once the request reaches a loaded worker. */
      timer?: ReturnType<typeof setTimeout>;
      /** Starts (or restarts) the request's own time budget. */
      arm?: () => void;
      /** Calls to Work outstanding; the budget waits while any are. */
      working: number;
    }
  >();
  constructor(
    private readonly opts: {
      modulePath: string;
      projectRoot: string;
      workerPath: string;
      executable: () => Promise<string>;
      /**
       * What the module's process starts with beyond Electron's own
       * environment: Work's Bun first on PATH, as agent terminals get.
       */
      env?: () => Promise<Record<string, string>>;
      /**
       * Answer a module asking Work for something while it serves
       * `requestId` (ADR 0234); the owner routes it to that window.
       */
      work?: (requestId: string, call: unknown) => Promise<unknown>;
      idleMs?: number;
      timeoutMs?: number;
      /** How long resolving the toolchain and loading the module may take. */
      startTimeoutMs?: number;
    },
  ) {}

  /** Resolves once the worker has loaded the module and can serve requests. */
  private async start(): Promise<ChildProcess> {
    if (this.disposed) throw new Error("Sidebar source was closed.");
    clearTimeout(this.idle);
    if (this.starting) return this.starting;
    if (this.child) return this.child;
    const generation = this.generation;
    // A toolchain that never resolves or a module whose import never
    // finishes cannot hold requests forever: one deadline covers both.
    const starting = new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let expired = false;
      const startup = setTimeout(() => {
        expired = true;
        const error = new Error(
          "Sidebar source took too long to start. Retry to reload it.",
        );
        reject(error);
        if (child && this.child === child) this.stop(error, true);
      }, this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
      const fail = (error: unknown) => {
        clearTimeout(startup);
        reject(error);
      };
      Promise.all([
        this.opts.executable(),
        this.opts.env?.() ?? Promise.resolve({}),
      ]).then(([executable, env]) => {
        if (expired) return;
        if (this.disposed || generation !== this.generation) {
          fail(new Error("Sidebar source changed. Retry loading it."));
          return;
        }
        const spawned = spawn(
          executable,
          [this.opts.workerPath, this.opts.modulePath],
          {
            cwd: this.opts.projectRoot,
            env: { ...process.env, ...env },
            stdio: ["pipe", "ignore", "pipe", "pipe"],
          },
        );
        child = spawned;
        this.child = spawned;
        this.attach(spawned, (error) => {
          if (error) return fail(error);
          clearTimeout(startup);
          resolve(spawned);
        });
        if (this.listeners.size) this.send({ method: "subscribe" });
      }, fail);
    });
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }
  private attach(child: ChildProcess, started: (error?: Error) => void) {
    child.stdin?.on("error", () => {});
    // Resources lists the worker under its module (ADR 0266).
    const unregister = registerProcessOwner(child.pid, {
      kind: "module",
      modulePath: path.relative(this.opts.projectRoot, this.opts.modulePath),
    });
    const output = child.stdio[3];
    if (!output || !("readable" in output)) {
      const error = new Error("Missing sidebar source output.");
      started(error);
      this.stop(error, true);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr = `${stderr}${data}`.slice(-4000);
    });
    const lines = createInterface({ input: output });
    lines.on("line", (line) => {
      // A retired worker can still flush output during graceful shutdown.
      // Its responses and subscription errors cannot affect its replacement.
      if (this.child !== child) return;
      try {
        const message = responseSchema.parse(JSON.parse(line));
        if (message.type === "capabilities") {
          // Sent once the module has loaded: the worker can serve requests.
          this.capabilities = {
            move: message.move === true,
            drop: message.drop === true,
            reveal: message.reveal === true,
          };
          started();
        } else if (message.type === "subscription-error") {
          this.stop(
            new Error(message.error ?? "Source subscription failed."),
            true,
          );
        } else if (message.type === "work" && message.id) {
          const id = message.id;
          // Only for a request this worker is serving now, a few at a time.
          const requestId = message.requestId ?? "";
          const pending = this.pending.get(requestId);
          const answer = !this.opts.work
            ? Promise.reject(new Error("This source cannot reach Work."))
            : !pending
              ? Promise.reject(
                  new Error(
                    "work is available while a source loads or acts, not in subscribe.",
                  ),
                )
              : pending.working >= MAX_WORK_CALLS
                ? Promise.reject(
                    new Error(
                      `At most ${MAX_WORK_CALLS} calls to Work at once; await some first.`,
                    ),
                  )
                : this.opts.work(requestId, message.call);
          if (pending && answer instanceof Promise && this.opts.work) {
            pending.working += 1;
            clearTimeout(pending.timer);
            pending.timer = undefined;
            void answer
              .catch(() => undefined)
              .finally(() => {
                pending.working -= 1;
                if (
                  this.pending.get(requestId) === pending &&
                  pending.working === 0
                )
                  pending.arm?.();
              });
          }
          void answer.then(
            (result) => {
              if (this.child === child)
                this.send({
                  method: "work-result",
                  id,
                  result: result ?? null,
                });
            },
            (error: unknown) => {
              if (this.child === child)
                this.send({
                  method: "work-result",
                  id,
                  error: error instanceof Error ? error.message : String(error),
                });
            },
          );
        } else if (message.type === "invalidate") {
          for (const listener of this.listeners) listener();
        } else if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
          this.scheduleIdle();
        }
      } catch {
        this.stop(new Error("Invalid sidebar source response."), true);
      }
    });
    child.once("error", (error) => {
      started(error);
      if (this.child === child) this.stop(error, true);
    });
    child.once("exit", () => {
      unregister();
      lines.close();
      const error = new Error(
        stderr.trim() || "Sidebar source stopped. Retry to reload it.",
      );
      started(error);
      if (this.child === child) this.stop(error, true);
    });
  }
  private send(value: unknown) {
    this.child?.stdin?.write(`${JSON.stringify(value)}\n`);
  }
  private scheduleIdle() {
    clearTimeout(this.idle);
    if (!this.listeners.size && !this.pending.size)
      this.idle = setTimeout(
        () => this.stop(new Error("Sidebar source is idle.")),
        this.opts.idleMs ?? 30_000,
      );
  }
  private stop(error: Error, report = false) {
    if (report) for (const listener of this.listeners) listener(error.message);
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    child?.kill();
    // An infinite synchronous loop must not keep a retired worker alive.
    if (child) {
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 1000);
      kill.unref();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(input: SidebarSourceRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(input.requestId, { resolve, reject, working: 0 });
      void this.start()
        .then(() => {
          const pending = this.pending.get(input.requestId);
          if (!pending) return this.scheduleIdle();
          // The budget is the source's own work, so it starts when a loaded
          // worker receives the request; process startup has its own guard.
          // Time spent waiting on Work (a workflow call) is Work's, bounded
          // there, so the budget pauses for it and starts again after.
          pending.arm = () => {
            clearTimeout(pending.timer);
            const timer: ReturnType<typeof setTimeout> = setTimeout(
              // Timers run before I/O in each event-loop turn. After a
              // stall, an answer or exit the worker already delivered
              // settles first.
              () =>
                setImmediate(() => {
                  if (this.pending.get(input.requestId)?.timer !== timer)
                    return;
                  this.stop(
                    new Error(
                      "Sidebar source took too long. Retry to reload it.",
                    ),
                    true,
                  );
                }),
              this.opts.timeoutMs ?? 30_000,
            );
            pending.timer = timer;
          };
          pending.arm();
          this.send({ ...input, id: input.requestId });
        })
        .catch((error: unknown) => {
          const pending = this.pending.get(input.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(input.requestId);
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }
  cancel(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error("Sidebar request cancelled."));
    this.send({ method: "cancel", id });
    this.scheduleIdle();
  }
  subscribe(listener: (error?: string) => void): () => void {
    this.listeners.add(listener);
    clearTimeout(this.idle);
    if (this.listeners.size === 1) {
      this.send({ method: "subscribe" });
      const readSource = () => {
        try {
          return readFileSync(this.opts.modulePath, "utf8");
        } catch {
          return "";
        }
      };
      let source = readSource();
      // macOS coalesces directory events, and atomic replacement may report
      // a temporary filename. Compare the entry's contents so those edits
      // reload without restarting on unrelated changes.
      const changed = () => {
        const next = readSource();
        if (next === source) return;
        source = next;
        this.stop(new Error("Sidebar source changed. Reloading."));
        for (const notify of this.listeners) notify();
      };
      try {
        this.watcher = watch(path.dirname(this.opts.modulePath), changed);
        this.watcher.on("error", (error) => {
          this.watcher?.close();
          this.watcher = undefined;
          this.stop(error, true);
        });
        // FSEvents starts delivering a moment after the watch is created
        // and can drop an edit made in between (or under load). A slow poll
        // compares the contents with those read above, so it catches what
        // the watch missed; a stat poll would not, since its baseline stat
        // is taken asynchronously and can already include the edit.
        const poll = setInterval(changed, MODULE_POLL_MS);
        poll.unref();
        this.unpoll = () => clearInterval(poll);
      } catch (cause) {
        this.listeners.delete(listener);
        this.scheduleIdle();
        throw cause;
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.send({ method: "unsubscribe" });
        this.watcher?.close();
        this.watcher = undefined;
        this.unpoll?.();
        this.unpoll = undefined;
        this.scheduleIdle();
      }
    };
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    this.watcher?.close();
    this.unpoll?.();
    this.unpoll = undefined;
    this.listeners.clear();
    this.stop(new Error("Sidebar source was closed."));
  }
}
