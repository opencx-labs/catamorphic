import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  decodeProcessChunk,
  newProcessId,
  type ProcessOutput,
  processReadBounds,
  type SandboxProcess,
  type SandboxProcessProvider,
} from "@catamorphic/sandbox";
import { z } from "zod";
import { accessText, type CodeAccess } from "../shared/code-access.js";
import type { ModuleLaunch } from "./module-sandbox.js";
import { signalProcessGroup } from "./process-group.js";
import { registerProcessOwner } from "./process-owners.js";

/** Work, not a caller-supplied field, resolves this owner from a source. */
export interface CustomizationProcessOwner {
  profileId: string;
  projectId: string;
  modulePath: string;
  /** Host-issued lease for one source runtime or disposable preview. */
  viewId?: string;
  viewSignal?: AbortSignal;
}

const ownerSchema = z.object({
  profileId: z.string().min(1),
  projectId: z.string().min(1),
  modulePath: z.string().min(1),
  viewId: z.string().min(1).max(200).optional(),
});
const tracer = getTracer("@catamorphic/desktop");
export const customizationProcessStartSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  command: z
    .string()
    .min(1)
    .max(64 * 1024),
  name: z.string().min(1).max(200).optional(),
  lifetime: z.enum(["view", "application"]),
});
export const customizationProcessReadSchema = z.object({
  key: z.string().min(1).max(100),
  cursor: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
  waitMs: z.number().int().nonnegative().optional(),
});
export const customizationProcessStopSchema = z.object({
  key: z.string().min(1).max(100),
});
const desiredSchema = customizationProcessStartSchema.extend({
  owner: ownerSchema,
});
type DesiredProcess = z.infer<typeof desiredSchema>;
const signedDesiredSchema = z.object({
  definition: desiredSchema,
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
type SignedDesiredProcess = z.infer<typeof signedDesiredSchema>;
export type CustomizationProcess = SandboxProcess & {
  key: string;
  lifetime: "view" | "application";
  /** Enabled services restart after transfer or failure, with a new process id. */
  enabled: boolean;
  error?: string;
};

export const CUSTOMIZATION_PROCESSES_STATE_KEY = "_work/background-processes";

interface Entry {
  desired: DesiredProcess;
  subject: string;
  process: CustomizationProcess;
  child: ChildProcess;
  launch: ModuleLaunch;
  log: string;
  access: CodeAccess;
  ended: Promise<void>;
  viewSignal?: AbortSignal;
}

/**
 * The provider process contract, with Work's approved module sandbox as the
 * execution boundary. Desired services use core's ordinary member state; live
 * processes, output cursors and signals use SandboxProcessProvider throughout.
 */
export class CustomizationProcesses {
  private readonly entries = new Map<string, Entry>();
  private readonly desired = new Map<string, DesiredProcess>();
  private writing = Promise.resolve();
  private closed = false;
  private restarting?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  private changing = Promise.resolve();
  private readonly starting = new Map<
    string,
    {
      desired: DesiredProcess;
      viewSignal?: AbortSignal;
      beforeEffect?: () => Promise<void>;
    }
  >();
  private readonly blocked = new Set<string>();
  private readonly closedViews = new WeakSet<AbortSignal>();

  constructor(
    private readonly deps: {
      root: string;
      /** Re-read canonical declaration and signed approval, on every start. */
      authorize: (
        owner: CustomizationProcessOwner,
        lifetime: "view" | "application",
      ) => Promise<{
        subject: string;
        projectRoot: string;
        access: CodeAccess;
      }>;
      launch: (input: {
        owner: CustomizationProcessOwner;
        workerPath: string;
        access: CodeAccess;
        projectRoot: string;
        scope: string;
      }) => Promise<ModuleLaunch>;
      projects: () => Promise<string[]>;
      readState: (
        projectId: string,
      ) => Promise<{ version: number; value: unknown }>;
      writeState: (input: {
        projectId: string;
        ifVersion: number;
        value: SignedDesiredProcess[];
      }) => Promise<unknown>;
      seal: (input: {
        definition: DesiredProcess;
        stateVersion: number;
      }) => Promise<string>;
      verify: (input: {
        definition: DesiredProcess;
        stateVersion: number;
        signature: string;
      }) => Promise<boolean>;
      onError?: (error: unknown) => void;
    },
  ) {}

  /** Existing provider mechanics, kept host-only behind the owner's methods. */
  readonly provider: SandboxProcessProvider = {
    startProcess: async (input) => {
      const pending = this.starting.get(input.sandboxId);
      const desired = pending?.desired;
      if (
        !desired ||
        input.command !== desired.command ||
        input.env ||
        input.cwd ||
        input.stdin
      )
        throw new Error(
          "Start a customization process through its approved owner.",
        );
      return this.spawn(desired, pending?.viewSignal, pending?.beforeEffect);
    },
    listProcesses: async ({ sandboxId }) =>
      [...this.entries.values()]
        .filter((entry) => entry.subject === sandboxId)
        .map((entry) => this.snapshot(entry)),
    readProcessOutput: (input) => this.readOutput(input),
    signalProcess: async (input) => {
      const entry = this.find(input);
      this.signal(entry, input.signal);
      return this.snapshot(entry);
    },
    writeProcessInput: async () => {
      throw new Error("Customization service input is closed after startup.");
    },
  };

  private id(
    owner: CustomizationProcessOwner,
    key: string,
    subject: string,
    lifetime: "view" | "application",
  ) {
    return JSON.stringify([
      owner.profileId,
      subject,
      key,
      lifetime,
      lifetime === "view" ? owner.viewId : null,
    ]);
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.changing.catch(() => {}).then(operation);
    this.changing = current.then(
      () => {},
      () => {},
    );
    return current;
  }
  private requireView(owner: CustomizationProcessOwner, required = false) {
    if ((required || owner.viewId) && (!owner.viewId || !owner.viewSignal))
      throw new Error("A view process needs a host-issued view lease.");
    if (
      owner.viewSignal &&
      (owner.viewSignal.aborted || this.closedViews.has(owner.viewSignal))
    )
      throw new Error("This source view lease has ended.");
  }
  private find(input: { sandboxId: string; processId: string }) {
    const entry = [...this.entries.values()].find(
      (entry) =>
        entry.subject === input.sandboxId &&
        entry.process.processId === input.processId,
    );
    if (!entry) throw new Error("Unknown customization process.");
    return entry;
  }
  private snapshot(entry: Entry): CustomizationProcess {
    const outputBytes = fs.statSync(entry.log).size;
    return { ...entry.process, outputBytes };
  }
  private async readOutput(
    input: Parameters<SandboxProcessProvider["readProcessOutput"]>[0],
  ): Promise<ProcessOutput> {
    const entry = this.find(input);
    const bounds = processReadBounds(input);
    const deadline = Date.now() + bounds.waitMs;
    while (
      entry.process.status === "running" &&
      fs.statSync(entry.log).size <= bounds.cursor &&
      Date.now() < deadline
    )
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    const process = this.snapshot(entry);
    const cursor = Math.min(bounds.cursor, process.outputBytes);
    const bytes = Buffer.alloc(
      Math.min(bounds.maxBytes, process.outputBytes - cursor),
    );
    const fd = fs.openSync(entry.log, "r");
    try {
      fs.readSync(fd, bytes, 0, bytes.length, cursor);
    } finally {
      fs.closeSync(fd);
    }
    const more = cursor + bytes.length < process.outputBytes;
    return {
      processId: process.processId,
      ...decodeProcessChunk({
        bytes,
        cursor,
        maxBytes: bytes.length,
        final: process.status === "exited" && !more,
      }),
      more,
      outputBytes: process.outputBytes,
      status: process.status,
      exitCode: process.exitCode,
      signal: process.signal,
    };
  }
  private signal(
    entry: Entry,
    signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP",
  ) {
    if (entry.process.status !== "running") return;
    entry.process.signal = signal;
    signalProcessGroup({ child: entry.child, signal });
  }
  private async end(entry: Entry) {
    this.signal(entry, "SIGTERM");
    await Promise.race([entry.ended, delay(2_000)]);
    if (entry.process.status === "running") this.signal(entry, "SIGKILL");
    await entry.ended;
  }
  private async persist(projectId: string, beforeEffect?: () => Promise<void>) {
    const previous = this.writing;
    const current = previous
      .catch(() => {})
      .then(async () => {
        // All writes serialize locally; core rejects competing stale writers.
        const state = await this.deps.readState(projectId);
        const value = await Promise.all(
          [...this.desired.values()]
            .filter((item) => item.owner.projectId === projectId)
            .map(async (definition) => ({
              definition,
              signature: await this.deps.seal({
                definition,
                stateVersion: state.version + 1,
              }),
            })),
        );
        await beforeEffect?.();
        await this.deps.writeState({
          projectId,
          ifVersion: state.version,
          value,
        });
      });
    // The caller receives this write's error. Later cleanup does not replay a
    // rejected operation that made no state change.
    this.writing = current.then(
      () => {},
      () => {},
    );
    await current;
  }

  async start(
    owner: CustomizationProcessOwner,
    raw: unknown,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    return withSpan(
      {
        tracer,
        name: "customization.process.start",
        attributes: {
          "catamorphic.project.id": owner.projectId,
          "catamorphic.customization.profile.id": owner.profileId,
        },
      },
      () => this.mutate(() => this.startOwned(owner, raw, beforeEffect)),
    );
  }
  private async startOwned(
    owner: CustomizationProcessOwner,
    raw: unknown,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    if (this.closed)
      throw new Error("Work's background services are stopping.");
    const input = customizationProcessStartSchema.parse(raw);
    this.requireView(owner, input.lifetime === "view");
    const desired = {
      ...input,
      owner: ownerSchema.parse({
        profileId: owner.profileId,
        projectId: owner.projectId,
        modulePath: owner.modulePath,
        ...(input.lifetime === "view" ? { viewId: owner.viewId } : {}),
      }),
    };
    const authority = await this.deps.authorize(owner, input.lifetime);
    this.requireView(owner, input.lifetime === "view");
    await beforeEffect?.();
    const id = this.id(
      desired.owner,
      input.key,
      authority.subject,
      input.lifetime,
    );
    this.blocked.delete(id);
    const previous = this.desired.get(id);
    const running = this.entries.get(id);
    if (
      running?.process.status === "running" &&
      JSON.stringify(running.desired) === JSON.stringify(desired)
    )
      return this.snapshot(running);
    // Persist before starting, so a successful start is recoverable after Quit.
    if (input.lifetime === "application") this.desired.set(id, desired);
    else this.desired.delete(id);
    try {
      await this.persist(owner.projectId, async () => {
        this.requireView(owner, input.lifetime === "view");
        await beforeEffect?.();
        this.requireView(owner, input.lifetime === "view");
      });
    } catch (error) {
      if (previous) this.desired.set(id, previous);
      else this.desired.delete(id);
      throw error;
    }
    if (running) await this.end(running);
    try {
      return await this.startProvider(
        desired,
        authority.subject,
        input.lifetime === "view" ? owner.viewSignal : undefined,
        beforeEffect,
      );
    } catch (error) {
      if (beforeEffect && input.lifetime === "application") {
        if (previous) this.desired.set(id, previous);
        else this.desired.delete(id);
        try {
          await this.persist(owner.projectId);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "The process could not start or disable its pending definition.",
          );
        }
      }
      throw error;
    }
  }

  private async startProvider(
    desired: DesiredProcess,
    subject: string,
    viewSignal?: AbortSignal,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    // Only a host-approved call registers an execution scope. The provider's
    // ordinary command contract cannot manufacture one or inject credentials.
    this.starting.set(subject, { desired, viewSignal, beforeEffect });
    try {
      const started = await this.provider.startProcess({
        sandboxId: subject,
        command: desired.command,
        ...(desired.name ? { name: desired.name } : {}),
      });
      return this.snapshot(this.find(started));
    } finally {
      this.starting.delete(subject);
    }
  }

  private async spawn(
    desired: DesiredProcess,
    viewSignal?: AbortSignal,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    if (this.closed)
      throw new Error("Work's background services are stopping.");
    this.requireView(
      { ...desired.owner, viewSignal },
      desired.lifetime === "view",
    );
    const authority = await this.deps.authorize(
      desired.owner,
      desired.lifetime,
    );
    const workerPath = this.worker();
    const id = this.id(
      desired.owner,
      desired.key,
      authority.subject,
      desired.lifetime,
    );
    const launch = await this.deps.launch({
      ...authority,
      owner: desired.owner,
      workerPath,
      scope: id,
    });
    try {
      await beforeEffect?.();
      this.requireView(
        { ...desired.owner, viewSignal },
        desired.lifetime === "view",
      );
    } catch (error) {
      await launch.close();
      throw error;
    }
    if (this.closed) {
      await launch.close();
      throw new Error("Work's background services are stopping.");
    }
    const processId = newProcessId();
    const log = path.join(this.deps.root, `${processId}.log`);
    const fd = fs.openSync(log, "a", 0o600);
    const child = (() => {
      try {
        return spawn(launch.command, launch.args, {
          cwd: authority.projectRoot,
          env: launch.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", fd, fd, "ignore", ...(launch.inheritedFds ?? [])],
        });
      } finally {
        fs.closeSync(fd);
        launch.spawned?.();
      }
    })();
    const unregister = registerProcessOwner(child.pid, {
      kind: "module",
      modulePath: path.relative(
        authority.projectRoot,
        desired.owner.modulePath,
      ),
    });
    let finish: (() => void) | undefined;
    let fail: ((error: unknown) => void) | undefined;
    const entry: Entry = {
      desired,
      subject: authority.subject,
      child,
      launch,
      log,
      access: authority.access,
      viewSignal,
      ended: new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
      process: {
        processId,
        sandboxId: authority.subject,
        command: desired.command,
        ...(desired.name ? { name: desired.name } : {}),
        cwd: authority.projectRoot,
        key: desired.key,
        lifetime: desired.lifetime,
        enabled: desired.lifetime === "application",
        status: "running",
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        outputBytes: 0,
      },
    };
    const ended = (code: number | null, error?: Error) => {
      if (entry.process.status === "exited") return;
      // The service owns its descendants. A completed command leaves none behind.
      signalProcessGroup({ child, signal: "SIGKILL" });
      entry.process.status = "exited";
      entry.process.exitCode = code;
      entry.process.endedAt = new Date().toISOString();
      if (error) entry.process.error = error.message;
      unregister();
      void launch.close().then(
        () => finish?.(),
        (error: unknown) => {
          this.deps.onError?.(error);
          fail?.(error);
        },
      );
    };
    child.once("exit", (code) => ended(code));
    child.once("error", (error) => ended(127, error));
    child.stdin?.on("error", () => {});
    this.entries.set(id, entry);
    child.stdin?.end(`${JSON.stringify({ command: desired.command })}\n`);
    return this.snapshot(entry);
  }

  async list(
    owner: CustomizationProcessOwner,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess[]> {
    this.requireView(owner);
    const authority = await this.deps.authorize(owner, "view");
    await beforeEffect?.();
    this.requireView(owner);
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.subject === authority.subject &&
          (entry.desired.lifetime === "application" ||
            Boolean(
              owner.viewId &&
                entry.desired.owner.viewId === owner.viewId &&
                entry.viewSignal === owner.viewSignal,
            )),
      )
      .map((entry) => this.snapshot(entry));
  }
  private async owned(owner: CustomizationProcessOwner, key: string) {
    this.requireView(owner);
    const authority = await this.deps.authorize(owner, "view");
    const entries = [...this.entries.values()].filter(
      (entry) =>
        entry.subject === authority.subject &&
        entry.desired.key === key &&
        (entry.desired.lifetime === "application" ||
          Boolean(
            owner.viewId &&
              entry.desired.owner.viewId === owner.viewId &&
              entry.viewSignal === owner.viewSignal,
          )),
    );
    const entry =
      entries.find((entry) => entry.desired.lifetime === "view") ?? entries[0];
    if (!entry) throw new Error(`Unknown customization process ${key}.`);
    return entry;
  }
  async read(
    owner: CustomizationProcessOwner,
    raw: unknown,
    beforeEffect?: () => Promise<void>,
  ) {
    const input = customizationProcessReadSchema.parse(raw);
    const entry = await this.owned(owner, input.key);
    await beforeEffect?.();
    this.requireView(owner);
    return this.provider.readProcessOutput({
      ...input,
      sandboxId: entry.subject,
      processId: entry.process.processId,
    });
  }
  async stop(
    owner: CustomizationProcessOwner,
    raw: unknown,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    return withSpan(
      {
        tracer,
        name: "customization.process.stop",
        attributes: {
          "catamorphic.project.id": owner.projectId,
          "catamorphic.customization.profile.id": owner.profileId,
        },
      },
      () => this.mutate(() => this.stopOwned(owner, raw, beforeEffect)),
    );
  }
  private async stopOwned(
    owner: CustomizationProcessOwner,
    raw: unknown,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    const { key } = customizationProcessStopSchema.parse(raw);
    const entry = await this.owned(owner, key);
    return this.disable(entry, async () => {
      this.requireView(owner);
      await beforeEffect?.();
      this.requireView(owner);
    });
  }
  private async disable(
    entry: Entry,
    beforeEffect?: () => Promise<void>,
  ): Promise<CustomizationProcess> {
    const { owner, key } = entry.desired;
    const id = this.id(
      entry.desired.owner,
      key,
      entry.subject,
      entry.desired.lifetime,
    );
    const desired = this.desired.get(id);
    this.desired.delete(id);
    try {
      await this.persist(owner.projectId, beforeEffect);
    } catch (error) {
      if (desired) this.desired.set(id, desired);
      throw error;
    }
    entry.process.enabled = false;
    await this.end(entry);
    return this.snapshot(entry);
  }
  /** Work's Resources stop action disables supervised restart before signaling. */
  async stopByProcessId(input: { processId: string }) {
    return this.mutate(async () => {
      const entry = [...this.entries.values()].find(
        (entry) => entry.process.processId === input.processId,
      );
      if (!entry) throw new Error("Unknown customization process.");
      return this.disable(entry);
    });
  }
  /** A source disappearing only stops the processes it started for its view. */
  async release(owner: CustomizationProcessOwner) {
    if (!owner.viewId) return;
    if (owner.viewSignal) this.closedViews.add(owner.viewSignal);
    await this.mutate(async () => {
      const entries = [...this.entries].filter(
        ([, entry]) =>
          entry.desired.owner.profileId === owner.profileId &&
          entry.desired.owner.projectId === owner.projectId &&
          entry.desired.owner.viewId === owner.viewId &&
          entry.viewSignal === owner.viewSignal &&
          entry.desired.lifetime === "view",
      );
      await Promise.all(
        entries.map(async ([id, entry]) => {
          await this.end(entry);
          this.entries.delete(id);
        }),
      );
    });
  }
  async restore() {
    await this.mutate(() => this.restoreDefinitions({}));
    await this.reconcile();
    if (this.restarting) return;
    this.restarting = setInterval(
      () => void this.reconcile().catch(this.deps.onError ?? (() => {})),
      5_000,
    );
    this.restarting.unref();
  }

  /** Re-authenticate skipped services only after this profile explicitly recovers. */
  async recoverProfile(input: { profileId: string }): Promise<void> {
    return withSpan(
      {
        tracer,
        name: "customization.process.recover",
        attributes: { "catamorphic.customization.profile.id": input.profileId },
      },
      () =>
        this.mutate(async () => {
          if (this.closed)
            throw new Error("Work's background services are stopping.");
          await this.restoreDefinitions(input);
          await this.reconcileOwned(input);
        }),
    );
  }

  private async restoreDefinitions(input: { profileId?: string }) {
    for (const projectId of await this.deps.projects()) {
      const state = await this.deps.readState(projectId);
      const entries = z.array(z.unknown()).safeParse(state.value ?? []);
      if (!entries.success) {
        this.deps.onError?.(
          new Error("The background service registry is not authentic."),
        );
        continue;
      }
      const authenticated: Array<{ id: string; desired: DesiredProcess }> = [];
      for (const raw of entries.data) {
        const signed = signedDesiredSchema.safeParse(raw);
        if (!signed.success) {
          this.deps.onError?.(
            new Error("An unsigned background service was refused."),
          );
          continue;
        }
        const desired = signed.data.definition;
        if (
          desired.owner.projectId !== projectId ||
          desired.lifetime !== "application" ||
          (input.profileId !== undefined &&
            desired.owner.profileId !== input.profileId)
        )
          continue;
        try {
          if (
            !(await this.deps.verify({
              definition: desired,
              stateVersion: state.version,
              signature: signed.data.signature,
            }))
          )
            throw new Error(
              "This background service definition was changed or replayed outside Work.",
            );
          const authority = await this.deps.authorize(
            desired.owner,
            "application",
          );
          const id = this.id(
            desired.owner,
            desired.key,
            authority.subject,
            desired.lifetime,
          );
          if (!this.desired.has(id)) authenticated.push({ id, desired });
        } catch (error) {
          this.deps.onError?.(error);
        }
      }
      if (!authenticated.length) continue;
      if ((await this.deps.readState(projectId)).version !== state.version) {
        this.deps.onError?.(
          new Error(
            "The background service registry changed during recovery. Retry to read its current definitions.",
          ),
        );
        continue;
      }
      for (const { id, desired } of authenticated)
        if (!this.desired.has(id)) this.desired.set(id, desired);
    }
  }
  private reconcile(): Promise<void> {
    this.reconciling ??= this.mutate(() => this.reconcileOwned({})).finally(
      () => {
        this.reconciling = undefined;
      },
    );
    return this.reconciling;
  }
  private async reconcileOwned(input: { profileId?: string }) {
    for (const [id, desired] of this.desired) {
      if (this.closed) return;
      if (
        input.profileId !== undefined &&
        desired.owner.profileId !== input.profileId
      )
        continue;
      try {
        // Revocation or an expanded manifest stops even a running service.
        const authority = await this.deps.authorize(
          desired.owner,
          "application",
        );
        this.blocked.delete(id);
        const entry = this.entries.get(id);
        if (
          entry?.process.status === "running" &&
          accessText(entry.access) !== accessText(authority.access)
        )
          await this.end(entry);
        if (this.entries.get(id)?.process.status !== "running")
          await this.startProvider(desired, authority.subject);
      } catch (error) {
        this.blocked.add(id);
        const entry = this.entries.get(id);
        if (entry) {
          await this.end(entry);
          entry.process.error =
            error instanceof Error ? error.message : String(error);
        }
        this.deps.onError?.(error);
      }
    }
  }
  hasEnabled(): boolean {
    return [...this.desired.keys()].some((id) => !this.blocked.has(id));
  }
  /** Host inspection remains available when a source or its grant disappears. */
  inspect() {
    return [...this.entries.values()].map((entry) => ({
      owner: { ...entry.desired.owner },
      pid: entry.child.pid,
      ...this.snapshot(entry),
    }));
  }
  /** Explicit host stop, unlike shutdown, disables future service restarts. */
  async stopAll() {
    await this.mutate(async () => {
      const errors: unknown[] = [];
      const projects = new Set(
        [...this.entries.values()].map(
          (entry) => entry.desired.owner.projectId,
        ),
      );
      for (const desired of this.desired.values())
        projects.add(desired.owner.projectId);
      for (const projectId of projects) {
        const previous = [...this.desired].filter(
          ([, desired]) => desired.owner.projectId === projectId,
        );
        for (const [id] of previous) this.desired.delete(id);
        try {
          await this.persist(projectId);
        } catch (error) {
          for (const [id, desired] of previous) this.desired.set(id, desired);
          errors.push(error);
          continue;
        }
        const entries = [...this.entries.values()].filter(
          (entry) => entry.desired.owner.projectId === projectId,
        );
        for (const entry of entries) entry.process.enabled = false;
        const stopped = await Promise.allSettled(
          entries.map((entry) => this.end(entry)),
        );
        for (const result of stopped)
          if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Some background services could not be stopped.",
        );
    });
  }
  /** Shutdown retains desired services; explicit stop removes them. */
  async close() {
    this.closed = true;
    clearInterval(this.restarting);
    const operations = await Promise.allSettled([
      this.reconciling,
      this.changing,
      this.writing,
    ]);
    const stopped = await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.end(entry)),
    );
    const errors = [...operations, ...stopped].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Background services did not close cleanly.",
      );
  }
  private worker() {
    fs.mkdirSync(this.deps.root, { recursive: true, mode: 0o700 });
    const file = path.join(
      this.deps.root,
      `${createHash("sha256").update(PROCESS_WORKER).digest("hex").slice(0, 16)}.mjs`,
    );
    fs.writeFileSync(file, PROCESS_WORKER, { mode: 0o600 });
    return file;
  }
}

/** Replace the worker without changing the host-owned session leader PID. */
const PROCESS_WORKER = `let input='';
for await (const chunk of process.stdin) input+=chunk;
const {command}=JSON.parse(input);
process.execve('/bin/bash',['/bin/bash','--noprofile','--norc','-c',command],process.env);
`;
