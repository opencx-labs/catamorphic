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

  constructor(
    private readonly startWorker: (
      profileId: string,
      extensionId: string,
    ) => void,
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
    this.contexts.set(key, context);
    if (!contents.isDestroyed())
      contents.once("destroyed", () => this.dropContents(contents.id));
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
    this.contexts.delete(`worker:${versionId}`);
  }

  private dropContents(contentsId: number): void {
    for (const [key, context] of this.contexts)
      if (context.contents?.id === contentsId) this.contexts.delete(key);
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
