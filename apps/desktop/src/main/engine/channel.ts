/**
 * The channel between the main process and the engine (ADR 0341): one end
 * asks operations by name and the other answers each of them; the answering
 * end also says what happened, as events nobody waits for. Everything that
 * crosses is data a port can copy. The database's thread speaks the same
 * way (`server/database-thread.ts`).
 */

/** A failure as its fields: its name, its code and what else is plain. */
export interface ChannelFailure {
  name: string;
  message: string;
  stack?: string;
  fields: Record<string, unknown>;
}

/** One operation asked of the other end, answered by its `id`. */
export interface ChannelRequest {
  type: "call";
  id: number;
  operation: string;
  args: unknown[];
}

/** An event as it crosses: its name, and that name's payload. */
type ChannelEvent<Events> = {
  [Name in keyof Events]: {
    type: "event";
    name: Name;
    payload: Events[Name];
  };
}[keyof Events];

export type ChannelReply<Events, Hello> =
  /** The answering end is up: what it answers, and what it says first. */
  | { type: "ready"; operations: string[]; hello: Hello }
  /** The answering end could not start. */
  | { type: "failed"; error: ChannelFailure }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; error: ChannelFailure }
  | ChannelEvent<Events>;

/** The end of the channel that answers. */
export interface ChannelServerPort<Events, Hello> {
  postMessage(reply: ChannelReply<Events, Hello>): void;
  on(event: "message", listener: (request: ChannelRequest) => void): unknown;
}

/** The end of the channel that asks. */
export interface ChannelClientPort<Events, Hello> {
  postMessage(request: ChannelRequest): void;
  on(
    event: "message",
    listener: (reply: ChannelReply<Events, Hello>) => void,
  ): unknown;
}

/**
 * Operations by namespace, to any depth. Being in the tree is what allows
 * an operation: nothing else of the answering end can be reached.
 */
export interface OperationTree {
  readonly [name: string]:
    | OperationTree
    | ((...args: never[]) => unknown)
    | undefined;
}

/**
 * An interface of operations as the answering end implements it: each may
 * answer at once or later, with what its caller is promised.
 */
export type Served<Api> = {
  [Key in keyof Api]: Api[Key] extends (
    ...args: infer Args
  ) => Promise<infer Result>
    ? (...args: Args) => Result | Promise<Result>
    : Served<Api[Key]>;
};

export function channelFailure(error: unknown): ChannelFailure {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error), fields: {} };
  // A code, a status or a constraint is an own property and a plain value.
  // Anything else an error carries (a request, a cause) stays behind: it
  // may be large, or something no port can copy.
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error))
    if (
      key !== "name" &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    )
      fields[key] = value;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    fields,
  };
}

function raised(failure: ChannelFailure): Error {
  const error = Object.assign(new Error(failure.message), failure.fields);
  error.name = failure.name;
  // Where the operation failed, then who asked for it.
  if (failure.stack) error.stack = `${failure.stack}\n${error.stack ?? ""}`;
  return error;
}

/**
 * Whether an error is the one a class names. An error that crossed the
 * channel is rebuilt from its fields, so `instanceof` no longer tells.
 */
export function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function flatten(
  tree: OperationTree,
  prefix: string,
  into: Map<string, (...args: never[]) => unknown>,
): void {
  for (const [name, entry] of Object.entries(tree)) {
    if (name.includes("."))
      throw new Error(`An operation's name cannot hold a dot: ${name}`);
    if (typeof entry === "function") into.set(`${prefix}${name}`, entry);
    else if (entry) flatten(entry, `${prefix}${name}.`, into);
  }
}

/**
 * Answer a channel's requests from `api`, and say `hello` once listening.
 * Every request is answered: one left waiting holds its caller for good.
 */
export function serveChannel<Events, Hello>({
  port,
  api,
  hello,
}: {
  port: ChannelServerPort<Events, Hello>;
  api: OperationTree;
  hello: Hello;
}): {
  /**
   * Say something happened. An event sent while an operation runs arrives
   * before that operation's answer.
   */
  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void;
} {
  const operations = new Map<string, (...args: never[]) => unknown>();
  flatten(api, "", operations);

  const refuse = (id: number, error: unknown) =>
    port.postMessage({ type: "error", id, error: channelFailure(error) });
  port.on("message", (request) => {
    const operation = operations.get(request.operation);
    if (!operation) {
      refuse(
        request.id,
        new Error(`The engine has no operation '${request.operation}'`),
      );
      return;
    }
    new Promise((resolve) => {
      resolve(Reflect.apply(operation, undefined, request.args));
    }).then(
      (value) => {
        try {
          port.postMessage({ type: "result", id: request.id, value });
        } catch (error) {
          // An answer the port cannot copy: something live was returned.
          refuse(request.id, error);
        }
      },
      (error: unknown) => refuse(request.id, error),
    );
  });
  port.postMessage({
    type: "ready",
    operations: [...operations.keys()],
    hello,
  });
  return {
    emit(name, payload) {
      try {
        // One member of the union per name: built here, where the name
        // and its payload are known to belong together.
        const event: {
          type: "event";
          name: typeof name;
          payload: typeof payload;
        } = { type: "event", name, payload };
        port.postMessage(event);
      } catch (error) {
        // Whoever caused the event is not waiting on it.
        console.error(
          `[desktop] The engine could not send '${String(name)}':`,
          error,
        );
      }
    },
  };
}

/** The asking end of a channel, once the answering end is ready. */
export interface Channel<Api, Events, Hello> {
  /**
   * The other end's operations, as functions that ask them, and what it
   * said first. Rejects when it could not start, or was lost before it did.
   */
  readonly ready: Promise<{ api: Api; hello: Hello }>;
  /** Hear an event; returns how to stop hearing it. */
  on<Name extends keyof Events>(
    name: Name,
    listener: (payload: Events[Name]) => void,
  ): () => void;
  readonly closed: boolean;
  /**
   * End the channel. What was asked and not yet answered fails its caller,
   * as does anything asked from now on: nobody is left waiting.
   */
  close(): Promise<void>;
}

/**
 * Operations as the answering end types them. Both ends are one build, and
 * an answer is the port's copy of what the operation returned: nothing in
 * between can check it a second time.
 */
function speaks<Api>(stubs: object): stubs is Api & object {
  return stubs !== null;
}

type Stubs = { [name: string]: Stubs | ((...args: unknown[]) => unknown) };

function isStubs(value: Stubs[string] | undefined): value is Stubs {
  return typeof value === "object";
}

/**
 * Ask the other end of a channel (`serveChannel` answers there). `lost`
 * reports that end going away unasked: everything waiting fails, and
 * `onLost` hears of it if it had been ready. `stop` ends the transport.
 */
export function connectChannel<Api, Events, Hello>({
  port,
  lost,
  stop,
  onLost,
  greeted,
}: {
  port: ChannelClientPort<Events, Hello>;
  lost: (listener: (error: Error) => void) => void;
  stop: () => Promise<unknown> | unknown;
  onLost?: (error: Error) => void;
  /**
   * Hears what the other end said first, before any event that follows it
   * is delivered: a copy seeded here is whole when its changes arrive.
   */
  greeted?: (hello: Hello) => void;
}): Channel<Api, Events, Hello> {
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners: {
    [Name in keyof Events]?: Set<(payload: Events[Name]) => void>;
  } = {};
  let nextRequest = 1;
  let closed = false;
  let wasReady = false;
  let gone: Error | undefined;
  let becameReady: (value: { api: Api; hello: Hello }) => void = () => {};
  let failedToStart: (error: Error) => void = () => {};
  const ready = new Promise<{ api: Api; hello: Hello }>((resolve, reject) => {
    becameReady = resolve;
    failedToStart = reject;
  });
  // Nobody may be waiting yet when the other end fails to start.
  ready.catch(() => {});

  const end = (error: Error) => {
    closed = true;
    failedToStart(error);
    for (const request of waiting.values()) request.reject(error);
    waiting.clear();
  };
  const lose = (error: Error) => {
    if (closed) return;
    gone = error;
    end(error);
    void Promise.resolve()
      .then(stop)
      .catch(() => {});
    if (wasReady) onLost?.(error);
  };
  lost(lose);

  const ask = (operation: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        // A new error each time: its stack is its caller's.
        reject(
          gone
            ? new Error(gone.message, { cause: gone })
            : new Error("The engine is closed"),
        );
        return;
      }
      const id = nextRequest++;
      waiting.set(id, { resolve, reject });
      try {
        port.postMessage({ type: "call", id, operation, args });
      } catch (error) {
        // An argument the port cannot copy: nothing was sent.
        waiting.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const stubsFor = (operations: readonly string[]): Stubs => {
    const root: Stubs = Object.create(null);
    for (const operation of operations) {
      const path = operation.split(".");
      const name = path.pop();
      if (!name) continue;
      let at = root;
      for (const namespace of path) {
        const next = at[namespace];
        if (isStubs(next)) {
          at = next;
          continue;
        }
        const created: Stubs = Object.create(null);
        at[namespace] = created;
        at = created;
      }
      at[name] = (...args: unknown[]) => ask(operation, args);
    }
    return root;
  };

  const deliver = <Name extends keyof Events>(
    name: Name,
    payload: Events[Name],
  ) => {
    for (const listener of [...(listeners[name] ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(
          `[desktop] A listener of the engine's '${String(name)}' failed:`,
          error,
        );
      }
    }
  };

  port.on("message", (reply) => {
    if (closed) return;
    if (reply.type === "ready") {
      const api = stubsFor(reply.operations);
      if (!speaks<Api>(api)) return;
      wasReady = true;
      greeted?.(reply.hello);
      becameReady({ api, hello: reply.hello });
      return;
    }
    if (reply.type === "failed") {
      lose(raised(reply.error));
      return;
    }
    if (reply.type === "event") {
      deliver(reply.name, reply.payload);
      return;
    }
    const request = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.type === "result") request?.resolve(reply.value);
    else request?.reject(raised(reply.error));
  });

  return {
    ready,
    on(name, listener) {
      const set = listeners[name] ?? new Set();
      listeners[name] = set;
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    get closed() {
      return closed;
    },
    async close() {
      if (closed) return;
      end(new Error("The engine is closed"));
      await stop();
    },
  };
}
