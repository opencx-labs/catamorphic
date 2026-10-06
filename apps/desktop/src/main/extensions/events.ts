import type { ServiceWorkerMain, WebContents, WebFrameMain } from "electron";
import { EXTENSION_CHANNELS } from "../../shared/extensions.js";

/**
 * Delivering Work-hosted extension events (ADR 0203). Each extension page
 * and service worker tells main which events it listens to; an event goes
 * to the contexts listening for it. A service worker that has stopped is
 * started again when an event it listened to fires, as Chrome does for
 * event pages, and the event waits until the worker listens again.
 */

export interface ExtensionContext {
  key: string;
  profileId: string;
  extensionId: string;
  kind: "frame" | "worker";
  listening: Set<string>;
  send: (name: string, args: unknown[]) => void;
  alive: () => boolean;
  contents: WebContents | null;
  frame: WebFrameMain | null;
  worker: ServiceWorkerMain | null;
}

interface Queued {
  name: string;
  args: unknown[];
  at: number;
}

const QUEUE_LIMIT = 200;
const QUEUE_TTL_MS = 30_000;
/** How long events wait for a starting worker before trying anyway. */
const HOLD_MS = 3_000;
/** How long one event keeps an otherwise idle worker running. */
const EVENT_KEEPALIVE_MS = 5_000;

const extensionKey = (profileId: string, extensionId: string) =>
  `${profileId}:${extensionId}`;

/** Hold a service worker awake for a while; never throws. */
export function keepWorkerAlive(
  worker: ServiceWorkerMain | null,
  ms: number,
): () => void {
  if (!worker || worker.isDestroyed()) return () => {};
  try {
    const task = worker.startTask();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      try {
        task.end();
      } catch {
        // The worker already stopped.
      }
    };
    if (ms > 0) setTimeout(end, ms);
    return end;
  } catch {
    return () => {};
  }
}

export class ExtensionEvents {
  private readonly contexts = new Map<string, ExtensionContext>();
  /** Events each extension's worker listened to: why it is woken. */
  private readonly workerEvents = new Map<string, Set<string>>();
  private readonly queued = new Map<string, Queued[]>();
  private readonly watchedContents = new WeakSet<WebContents>();
  private readonly runningWorkers = new Set<number>();
  private readonly held = new Map<
    number,
    {
      events: { name: string; args: unknown[] }[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly startWorker: (
      profileId: string,
      extensionId: string,
    ) => void,
    /** A page or worker went away: what it held (native ports) goes too. */
    private readonly gone: (context: ExtensionContext) => void,
  ) {}

  /** A document of an extension booted; it starts with no listeners. */
  registerFrame(
    profileId: string,
    extensionId: string,
    contents: WebContents,
    frame: WebFrameMain,
  ): ExtensionContext {
    const key = `frame:${contents.id}:${frame.processId}:${frame.routingId}`;
    const context: ExtensionContext = {
      key,
      profileId,
      extensionId,
      kind: "frame",
      listening: new Set(),
      contents,
      frame,
      worker: null,
      alive: () => !contents.isDestroyed() && !frame.detached,
      send: (name, args) => {
        try {
          frame.send(EXTENSION_CHANNELS.event, name, args);
        } catch {
          // A frame torn down between the check and the send.
        }
      },
    };
    // A new document in the same frame replaces the old one's context.
    const previous = this.contexts.get(key);
    if (previous) this.gone(previous);
    this.contexts.set(key, context);
    if (!contents.isDestroyed() && !this.watchedContents.has(contents)) {
      this.watchedContents.add(contents);
      contents.once("destroyed", () => this.dropContents(contents.id));
    }
    return context;
  }

  registerWorker(
    profileId: string,
    extensionId: string,
    worker: ServiceWorkerMain,
  ): ExtensionContext {
    const key = `worker:${worker.versionId}`;
    const existing = this.contexts.get(key);
    if (existing && existing.worker === worker) return existing;
    const context: ExtensionContext = {
      key,
      profileId,
      extensionId,
      kind: "worker",
      listening: new Set(),
      contents: null,
      frame: null,
      worker,
      alive: () => !worker.isDestroyed(),
      send: (name, args) => {
        if (worker.isDestroyed()) return;
        // A worker runs its script while still starting, and listens then,
        // but Electron delivers nothing to it until it is running: hold
        // what arrives meanwhile (runtime.onInstalled, woken events).
        if (!this.runningWorkers.has(worker.versionId)) {
          this.holdForWorker(worker, name, args);
          return;
        }
        keepWorkerAlive(worker, EVENT_KEEPALIVE_MS);
        try {
          worker.send(EXTENSION_CHANNELS.event, name, args);
        } catch {
          // Stopped between the check and the send.
        }
      },
    };
    this.contexts.set(key, context);
    return context;
  }

  /** A worker is running: what was held for it goes now. */
  workerRunning(versionId: number): void {
    this.runningWorkers.add(versionId);
    const held = this.held.get(versionId);
    this.held.delete(versionId);
    const context = this.contexts.get(`worker:${versionId}`);
    if (!held || !context) return;
    clearTimeout(held.timer);
    for (const { name, args } of held.events) context.send(name, args);
  }

  private holdForWorker(
    worker: ServiceWorkerMain,
    name: string,
    args: unknown[],
  ): void {
    let held = this.held.get(worker.versionId);
    if (!held) {
      const versionId = worker.versionId;
      held = {
        events: [],
        // A running state this host never heard of still gets them.
        timer: setTimeout(() => this.workerRunning(versionId), HOLD_MS),
      };
      this.held.set(versionId, held);
    }
    if (held.events.length < QUEUE_LIMIT) held.events.push({ name, args });
  }

  context(key: string): ExtensionContext | null {
    const context = this.contexts.get(key);
    if (!context) return null;
    if (!context.alive()) {
      this.contexts.delete(key);
      return null;
    }
    return context;
  }

  workerStopped(versionId: number): void {
    this.runningWorkers.delete(versionId);
    const held = this.held.get(versionId);
    if (held) clearTimeout(held.timer);
    this.held.delete(versionId);
    const key = `worker:${versionId}`;
    const context = this.contexts.get(key);
    this.contexts.delete(key);
    if (context) this.gone(context);
  }

  private dropContents(contentsId: number): void {
    for (const [key, context] of [...this.contexts])
      if (context.contents?.id === contentsId) {
        this.contexts.delete(key);
        this.gone(context);
      }
  }

  listen(context: ExtensionContext, name: string, on: boolean): void {
    if (on) context.listening.add(name);
    else context.listening.delete(name);
    if (context.kind !== "worker") return;
    const key = extensionKey(context.profileId, context.extensionId);
    let events = this.workerEvents.get(key);
    if (!events) {
      events = new Set();
      this.workerEvents.set(key, events);
    }
    if (on) events.add(name);
    else events.delete(name);
    if (on) this.flush(context, name);
  }

  private flush(context: ExtensionContext, name: string): void {
    const key = extensionKey(context.profileId, context.extensionId);
    const queue = this.queued.get(key);
    if (!queue) return;
    const now = Date.now();
    const rest: Queued[] = [];
    for (const item of queue) {
      if (now - item.at > QUEUE_TTL_MS) continue;
      if (item.name === name) context.send(item.name, item.args);
      else rest.push(item);
    }
    if (rest.length > 0) this.queued.set(key, rest);
    else this.queued.delete(key);
  }

  /** Is anything of this extension listening (or waiting to) for `name`? */
  listening(profileId: string, extensionId: string, name: string): boolean {
    if (this.workerEvents.get(extensionKey(profileId, extensionId))?.has(name))
      return true;
    for (const context of this.contexts.values())
      if (
        context.profileId === profileId &&
        context.extensionId === extensionId &&
        context.listening.has(name) &&
        context.alive()
      )
        return true;
    return false;
  }

  /** Every live context of an extension (pages and its worker). */
  contextsOf(profileId: string, extensionId: string): ExtensionContext[] {
    return [...this.contexts.values()].filter(
      (context) =>
        context.profileId === profileId &&
        context.extensionId === extensionId &&
        context.alive(),
    );
  }

  dispatch(
    profileId: string,
    extensionId: string,
    name: string,
    args: unknown[],
  ): void {
    let workerGot = false;
    for (const context of this.contextsOf(profileId, extensionId)) {
      if (!context.listening.has(name)) continue;
      if (context.kind === "worker") workerGot = true;
      context.send(name, args);
    }
    if (workerGot) return;
    const key = extensionKey(profileId, extensionId);
    if (!this.workerEvents.get(key)?.has(name)) return;
    const queue = this.queued.get(key) ?? [];
    queue.push({ name, args, at: Date.now() });
    if (queue.length > QUEUE_LIMIT) queue.shift();
    this.queued.set(key, queue);
    this.startWorker(profileId, extensionId);
  }

  /** Send to every context of an extension, listening or not (internal). */
  broadcast(
    profileId: string,
    extensionId: string,
    name: string,
    args: unknown[],
  ): void {
    for (const context of this.contextsOf(profileId, extensionId))
      context.send(name, args);
  }

  forget(profileId: string, extensionId: string): void {
    const key = extensionKey(profileId, extensionId);
    this.workerEvents.delete(key);
    this.queued.delete(key);
    for (const [contextKey, context] of this.contexts)
      if (
        context.profileId === profileId &&
        context.extensionId === extensionId
      )
        this.contexts.delete(contextKey);
  }
}
