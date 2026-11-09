import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  SidebarSourceCapabilities,
  SidebarSourceRequest,
} from "../shared/sidebar-source.js";
import type { ModuleLaunch } from "./module-sandbox.js";
import { signalProcessGroup } from "./process-group.js";
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
  files: z.array(z.string().max(8192)).max(512).optional(),
});
/** How often a subscribed source checks its module for edits the watch missed. */
const MODULE_POLL_MS = 2_000;
/** How long a worker may take to start and load its module. */
const START_TIMEOUT_MS = 30_000;
/** A shared, lazy process per module. Idle sources cost no process or polling. */
/** Calls to Work one request may have outstanding at once. */
const MAX_WORK_CALLS = 8;
const MAX_DEPENDENCIES = 512;

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** Never open worker-supplied files: even O_RDONLY can block forever on a FIFO. */
async function fileRevision(root: string, file: string) {
  const absolute = path.resolve(file);
  if (!within(root, absolute)) return { kind: "unsafe", revision: "outside" };
  try {
    const canonical = await realpath(absolute);
    if (!within(root, canonical))
      return { kind: "unsafe", revision: "outside" };
    // lstat never follows a final symlink swapped after realpath. Only metadata
    // is inspected, so intermediate-directory races cannot expose file data.
    const stat = await lstat(canonical, { bigint: true });
    if (!stat.isFile()) return { kind: "unsafe", revision: "not-file" };
    return {
      kind: "file",
      revision: `${canonical}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    };
  } catch {
    return { kind: "missing", revision: "missing" };
  }
}

export class SidebarSourceRuntime {
  private trace(event: string, detail: Record<string, unknown> = {}) {
    if (
      process.env.CATAMORPHIC_E2E_SIDEBAR_TRACE === "1" &&
      process.env.CATAMORPHIC_E2E_DATA_DIR
    )
      console.info(
        "[sidebar-source-trace]",
        JSON.stringify({
          at: Date.now(),
          layer: "runtime",
          event,
          modulePath: this.opts.modulePath,
          generation: this.generation,
          workerPid: this.child?.pid,
          listeners: this.listeners.size,
          ...detail,
        }),
      );
  }
  /** Reported by the worker once its module loads; false until then. */
  capabilities: SidebarSourceCapabilities = {
    move: false,
    drop: false,
    reveal: false,
  };
  private child?: ChildProcess;
  /** What the running process was started with; released when it ends. */
  private launched?: ModuleLaunch;
  private starting?: Promise<ChildProcess>;
  private idle?: ReturnType<typeof setTimeout>;
  private watcher?: FSWatcher;
  private unpoll?: () => void;
  private disposed = false;
  private generation = 0;
  private dependencies = new Set<string>();
  private loadedRevision = "";
  private fingerprinting?: { key: string; promise: Promise<string> };
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
      /**
       * How the module's process starts (ADR 0277): confined to its
       * declared access, with an environment of its own, never Electron's.
       */
      launch: () => Promise<ModuleLaunch>;
      /**
       * Files whose change restarts the module besides itself: the
       * package.json declaring its access.
       */
      watchFiles?: readonly string[];
      /**
       * Answer a module asking Work for something while it serves
       * `requestId` (ADR 0234); the owner routes it to that window.
       */
      work?: (requestId: string, call: unknown) => Promise<unknown>;
      idleMs?: number;
      timeoutMs?: number;
      /** How long resolving the toolchain and loading the module may take. */
      startTimeoutMs?: number;
      /** Release view-owned work; application services have their own lifetime. */
      onStopped?: () => void;
    },
  ) {}

  /** Host diagnostics, never data or authority supplied by a source. */
  inspect() {
    return {
      generation: this.generation,
      revision: this.loadedRevision,
      files: this.sourceFiles(),
      running: Boolean(this.child),
    };
  }
  private sourceFiles(): string[] {
    return [
      ...new Set([
        this.opts.modulePath,
        ...(this.opts.watchFiles ?? []),
        ...this.dependencies,
      ]),
    ].sort();
  }
  private fingerprint(): Promise<string> {
    const files = this.sourceFiles();
    const key = files.join("\0");
    if (this.fingerprinting?.key === key) return this.fingerprinting.promise;
    const promise = (async () => {
      const root = await realpath(this.opts.projectRoot);
      const revisions = await Promise.all(
        files.map(async (file) => {
          const absolute = path.resolve(this.opts.projectRoot, file);
          // projectRoot itself may have been opened through a system symlink.
          const candidate = within(
            path.resolve(this.opts.projectRoot),
            absolute,
          )
            ? path.resolve(root, path.relative(this.opts.projectRoot, absolute))
            : absolute;
          return [file, (await fileRevision(root, candidate)).revision];
        }),
      );
      const hash = createHash("sha256");
      for (const [file, revision] of revisions)
        hash.update(`${file}\0${revision}\0`);
      return hash.digest("hex");
    })();
    this.fingerprinting = { key, promise };
    void promise
      .finally(() => {
        if (this.fingerprinting?.promise === promise)
          this.fingerprinting = undefined;
      })
      .catch(() => undefined);
    return promise;
  }

  private async sourceDependencies(
    files: readonly string[],
  ): Promise<Set<string>> {
    const root = await realpath(this.opts.projectRoot);
    const candidates = [
      ...new Set(
        files
          .slice(0, MAX_DEPENDENCIES)
          .map((file) => path.resolve(this.opts.projectRoot, file)),
      ),
    ];
    const safe = await Promise.all(
      candidates.map(async (file) => {
        const candidate = within(path.resolve(this.opts.projectRoot), file)
          ? path.resolve(root, path.relative(this.opts.projectRoot, file))
          : file;
        const revision = await fileRevision(root, candidate);
        return revision.kind === "unsafe"
          ? []
          : [
              path.resolve(
                this.opts.projectRoot,
                path.relative(root, candidate),
              ),
            ];
      }),
    );
    return new Set(safe.flat());
  }

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
      this.opts.launch().then((launch) => {
        if (expired || this.disposed || generation !== this.generation) {
          void launch.close();
          if (!expired)
            fail(new Error("Sidebar source changed. Retry loading it."));
          return;
        }
        const spawned = spawn(launch.command, launch.args, {
          cwd: this.opts.projectRoot,
          env:
            process.env.CATAMORPHIC_E2E_SIDEBAR_TRACE === "1" &&
            process.env.CATAMORPHIC_E2E_DATA_DIR
              ? { ...launch.env, CATAMORPHIC_E2E_SIDEBAR_TRACE: "1" }
              : launch.env,
          detached: process.platform !== "win32",
          stdio: [
            "pipe",
            "ignore",
            "pipe",
            "pipe",
            ...(launch.inheritedFds ?? []),
          ],
        });
        launch.spawned?.();
        child = spawned;
        this.child = spawned;
        this.trace("spawned");
        this.launched = launch;
        spawned.once("exit", () => {
          // Natural exit and crashes retire the same group as explicit stop.
          signalProcessGroup({ child: spawned, signal: "SIGKILL" });
          void launch.close();
        });
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
    let diagnosticStderr = "";
    child.stderr?.on("data", (data) => {
      stderr = `${stderr}${data}`.slice(-4000);
      if (
        process.env.CATAMORPHIC_E2E_SIDEBAR_TRACE === "1" &&
        process.env.CATAMORPHIC_E2E_DATA_DIR
      ) {
        diagnosticStderr = `${diagnosticStderr}${data}`.slice(-16_000);
        for (;;) {
          const newline = diagnosticStderr.indexOf("\n");
          if (newline < 0) break;
          const line = diagnosticStderr.slice(0, newline);
          diagnosticStderr = diagnosticStderr.slice(newline + 1);
          if (line.startsWith("[sidebar-source-trace]"))
            process.stderr.write(`${line}\n`);
        }
      }
    });
    const lines = createInterface({ input: output });
    let dependencies: Promise<void> | undefined;
    lines.on("line", (line) => {
      // A retired worker can still flush output during graceful shutdown.
      // Its responses and subscription errors cannot affect its replacement.
      if (this.child !== child) return;
      try {
        const message = responseSchema.parse(JSON.parse(line));
        if (message.type === "capabilities") {
          // Resolve the graph before the first request, including its metadata
          // baseline. None of that filesystem work blocks Electron's loop.
          void (dependencies ?? Promise.resolve())
            .then(async () => {
              if (this.child !== child) return;
              const revision = await this.fingerprint();
              if (this.child !== child) return;
              this.loadedRevision = revision;
              this.capabilities = {
                move: message.move === true,
                drop: message.drop === true,
                reveal: message.reveal === true,
              };
              started();
            })
            .catch((error: unknown) => {
              started(
                error instanceof Error ? error : new Error(String(error)),
              );
              if (this.child === child)
                this.stop(
                  new Error("Could not inspect source dependencies."),
                  true,
                );
            });
        } else if (message.type === "subscription-error") {
          this.stop(
            new Error(message.error ?? "Source subscription failed."),
            true,
          );
        } else if (message.type === "dependencies") {
          // Only the startup graph is accepted. A module can forge protocol
          // output, but cannot make main read arbitrary data or queue rescans.
          if (dependencies) return;
          dependencies = this.sourceDependencies(message.files ?? []).then(
            async (files) => {
              if (this.child !== child) return;
              this.dependencies = files;
              const revision = await this.fingerprint();
              if (this.child === child) this.loadedRevision = revision;
            },
          );
          void dependencies.catch(() => undefined);
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
    if (
      typeof value === "object" &&
      value !== null &&
      "method" in value &&
      (value.method === "subscribe" || value.method === "unsubscribe")
    )
      this.trace("send", {
        method: value.method,
        hasStdin: Boolean(this.child?.stdin),
        stdinDestroyed: this.child?.stdin?.destroyed,
        queuedBytes: this.child?.stdin?.writableLength,
      });
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
    this.opts.onStopped?.();
    if (report) for (const listener of this.listeners) listener(error.message);
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    void this.launched?.close();
    this.launched = undefined;
    if (child) signalProcessGroup({ child, signal: "SIGTERM" });
    // An infinite synchronous loop must not keep a retired worker alive.
    if (child) {
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          signalProcessGroup({ child, signal: "SIGKILL" });
      }, 1000);
      child.once("exit", () => clearTimeout(kill));
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
      const request = { resolve, reject, working: 0 };
      this.pending.set(input.requestId, request);
      const prepare = async () => {
        const child = this.child;
        const loadedRevision = this.loadedRevision;
        if (child && loadedRevision) {
          const revision = await this.fingerprint();
          if (this.pending.get(input.requestId) !== request) return;
          if (this.child === child && revision !== loadedRevision) {
            // Keep this new request while retiring requests already using
            // the old code. cancel() remains effective during the scan.
            this.pending.delete(input.requestId);
            this.stop(new Error("Sidebar source changed. Reloading."));
            this.pending.set(input.requestId, request);
          }
        }
        if (this.pending.get(input.requestId) !== request) return;
        await this.start();
      };
      void prepare()
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
    this.trace("listener-add-before");
    this.listeners.add(listener);
    this.trace("listener-added");
    clearTimeout(this.idle);
    if (this.listeners.size === 1) {
      this.send({ method: "subscribe" });
      // The module and what declares its access: either changing reloads.
      let source = this.loadedRevision;
      let checking = false;
      let again = false;
      let active = true;
      // macOS coalesces directory events, and atomic replacement may report
      // a temporary filename. Compare the loaded files' metadata so edits
      // reload without restarting on unrelated changes.
      const changed = () => {
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        void this.fingerprint()
          .then((next) => {
            if (!active || this.disposed || next === source) return;
            const previous = source;
            source = next;
            // Discovering the graph on startup is not an edit.
            if (!previous || next === this.loadedRevision) return;
            this.stop(new Error("Sidebar source changed. Reloading."));
            for (const notify of this.listeners) notify();
          })
          .catch((error: unknown) => {
            if (active && !this.disposed)
              this.stop(
                error instanceof Error ? error : new Error(String(error)),
                true,
              );
          })
          .finally(() => {
            checking = false;
            if (again && active) {
              again = false;
              changed();
            }
          });
      };
      try {
        this.watcher = watch(path.dirname(this.opts.modulePath), changed);
        this.watcher.on("error", (error) => {
          this.watcher?.close();
          this.watcher = undefined;
          this.stop(error, true);
        });
        changed();
        // FSEvents starts delivering a moment after the watch is created
        // and can drop an edit made in between (or under load). A slow poll
        // compares each file's identity, mtime and ctime with the loaded
        // revision, catching atomic replacement and same-size edits too.
        const poll = setInterval(changed, MODULE_POLL_MS);
        poll.unref();
        this.unpoll = () => {
          active = false;
          clearInterval(poll);
        };
      } catch (cause) {
        this.listeners.delete(listener);
        this.scheduleIdle();
        throw cause;
      }
    }
    return () => {
      this.trace("listener-remove-before");
      this.listeners.delete(listener);
      this.trace("listener-removed");
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
  /**
   * Start again with what is declared and allowed now (ADR 0277), and have
   * every view of the module read again.
   */
  reload() {
    this.stop(new Error("Sidebar source restarted."));
    for (const listener of this.listeners) listener();
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
