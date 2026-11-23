import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelReply,
  type ChannelRequest,
  connectChannel,
  isNamedError,
  type OperationTree,
  serveChannel,
} from "./channel.js";

interface Events {
  changed: { projectId: string };
  lost: { message: string };
}
interface Hello {
  url: string;
}

class CodedError extends Error {
  override name = "CodedError";
  code = "E_CODED";
  status = 409;
  /** Something no port can copy: it stays behind. */
  request = { abort: () => {} };
}

interface Api {
  add(a: number, b: number): Promise<number>;
  echo<T>(value: T): Promise<T>;
  roots: {
    get(projectId: string): Promise<string | null>;
    set(projectId: string, rootPath: string): Promise<void>;
    deep: { name(): Promise<string> };
  };
  fail(): Promise<never>;
  throwsAtOnce(): Promise<never>;
  live(): Promise<unknown>;
  never(): Promise<void>;
  slow(ms: number): Promise<string>;
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.restoreAllMocks();
});

/** The channel's two ends in one thread: only the process is missing. */
async function connect(extra: OperationTree = {}) {
  const { port1, port2 } = new MessageChannel();
  closers.push(() => {
    port1.close();
    port2.close();
  });
  const roots = new Map<string, string>();
  let emit: ReturnType<typeof serveChannel<Events, Hello>>["emit"] = () => {};
  const api: OperationTree = {
    add: (a: number, b: number) => a + b,
    echo: (value: unknown) => value,
    roots: {
      get: async (projectId: string) => roots.get(projectId) ?? null,
      set: async (projectId: string, rootPath: string) => {
        roots.set(projectId, rootPath);
        // Said while the operation runs: heard before its answer.
        emit("changed", { projectId });
      },
      deep: { name: () => "deep" },
    },
    fail: async () => {
      throw new CodedError("It was refused");
    },
    throwsAtOnce: () => {
      throw new Error("Thrown, not rejected");
    },
    live: () => ({ close: () => {} }),
    never: () => new Promise<void>(() => {}),
    slow: (ms: number) =>
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), ms)),
    ...extra,
  };
  const served = serveChannel<Events, Hello>({
    port: port2,
    api,
    hello: { url: "http://127.0.0.1:1" },
  });
  emit = served.emit;
  let lose: (error: Error) => void = () => {};
  const lostWith: Error[] = [];
  let stops = 0;
  const channel = connectChannel<Api, Events, Hello>({
    port: port1,
    lost: (listener) => {
      lose = listener;
    },
    stop: () => {
      stops += 1;
      port1.close();
      port2.close();
    },
    onLost: (error) => lostWith.push(error),
  });
  const { api: engine, hello } = await channel.ready;
  return {
    channel,
    engine,
    hello,
    emit,
    lose: (error: Error) => lose(error),
    lostWith,
    stops: () => stops,
  };
}

/** An answering end a test drives by hand. */
function connectByHand() {
  const { port1, port2 } = new MessageChannel();
  closers.push(() => {
    port1.close();
    port2.close();
  });
  const asked: ChannelRequest[] = [];
  port2.on("message", (request: ChannelRequest) => asked.push(request));
  let lose: (error: Error) => void = () => {};
  const lostWith: Error[] = [];
  const channel = connectChannel<Api, Events, Hello>({
    port: port1,
    lost: (listener) => {
      lose = listener;
    },
    stop: () => {},
    onLost: (error) => lostWith.push(error),
  });
  return {
    channel,
    asked,
    say: (reply: ChannelReply<Events, Hello>) => port2.postMessage(reply),
    lose: (error: Error) => lose(error),
    lostWith,
  };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the engine's channel", () => {
  it("answers operations by name, at any depth, with what the other end said first", async () => {
    const { engine, hello } = await connect();
    expect(hello).toEqual({ url: "http://127.0.0.1:1" });
    await expect(engine.add(2, 3)).resolves.toBe(5);
    await expect(engine.roots.get("p")).resolves.toBeNull();
    await engine.roots.set("p", "/work/p");
    await expect(engine.roots.get("p")).resolves.toBe("/work/p");
    await expect(engine.roots.deep.name()).resolves.toBe("deep");
  });

  it("carries what a port can copy as it was", async () => {
    const { engine } = await connect();
    const value = {
      text: "a",
      missing: undefined,
      none: null,
      at: new Date(0),
      bytes: new Uint8Array([1, 2, 3]),
      set: new Set(["x"]),
      map: new Map([["k", 1]]),
      nested: [{ big: 12n }],
    };
    await expect(engine.echo(value)).resolves.toEqual(value);
  });

  it("answers in the order operations finish, each caller its own", async () => {
    const { engine } = await connect();
    const slow = engine.slow(30);
    const fast = engine.add(1, 1);
    await expect(fast).resolves.toBe(2);
    await expect(slow).resolves.toBe("late");
  });

  it("carries a failure's name, message, code and plain fields, and no more", async () => {
    const { engine } = await connect();
    const error = await engine.fail().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(isNamedError(error, "CodedError")).toBe(true);
    expect(error).toMatchObject({
      message: "It was refused",
      code: "E_CODED",
      status: 409,
    });
    expect(error).not.toHaveProperty("request");
    // Where it failed, then who asked.
    expect(String(isNamedError(error, "CodedError") && error.stack)).toContain(
      "channel.test",
    );
  });

  it("answers an operation that throws before it returns", async () => {
    const { engine } = await connect();
    await expect(engine.throwsAtOnce()).rejects.toThrow("Thrown, not rejected");
  });

  it("refuses an operation the other end does not offer", async () => {
    const { channel, asked, say } = connectByHand();
    say({
      type: "ready",
      operations: ["add"],
      hello: { url: "" },
    });
    const { api } = await channel.ready;
    // Offered by name only: the tree is what allows an operation.
    expect(Object.keys(api)).toEqual(["add"]);
    void api.add(1, 2).catch(() => {});
    await turn();
    expect(asked.map((request) => request.operation)).toEqual(["add"]);

    const { port1, port2 } = new MessageChannel();
    closers.push(() => {
      port1.close();
      port2.close();
    });
    serveChannel<Events, Hello>({ port: port2, api: {}, hello: { url: "" } });
    const replies: Array<ChannelReply<Events, Hello>> = [];
    port1.on("message", (reply: ChannelReply<Events, Hello>) =>
      replies.push(reply),
    );
    port1.postMessage({
      type: "call",
      id: 7,
      operation: "constructor.constructor",
      args: ["return process"],
    } satisfies ChannelRequest);
    await turn();
    expect(replies.at(-1)).toMatchObject({
      type: "error",
      id: 7,
      error: {
        message: "The engine has no operation 'constructor.constructor'",
      },
    });
  });

  it("fails a caller whose argument cannot cross, and sends nothing", async () => {
    const { engine } = await connect();
    await expect(engine.echo(() => {})).rejects.toThrow(/could not be cloned/);
    // The channel is still good.
    await expect(engine.add(1, 1)).resolves.toBe(2);
  });

  it("answers with an error when the result cannot cross", async () => {
    const { engine } = await connect();
    await expect(engine.live()).rejects.toThrow(/could not be cloned/);
    await expect(engine.add(1, 1)).resolves.toBe(2);
  });

  it("delivers an event sent during an operation before that operation's answer", async () => {
    const { channel, engine } = await connect();
    const heard: string[] = [];
    channel.on("changed", ({ projectId }) => heard.push(projectId));
    await engine.roots.set("p", "/work/p").then(() => {
      // The caller resumes with the event already heard: a mirror is
      // current by the time its writer's request is answered.
      expect(heard).toEqual(["p"]);
    });
  });

  it("hands over what the other end said first before any event that follows it", async () => {
    const { port1, port2 } = new MessageChannel();
    closers.push(() => {
      port1.close();
      port2.close();
    });
    const served = serveChannel<Events, Hello>({
      port: port2,
      api: {},
      hello: { url: "http://127.0.0.1:2" },
    });
    // Right behind `ready`, before anyone could have awaited it.
    served.emit("changed", { projectId: "first" });
    const order: string[] = [];
    const channel = connectChannel<Api, Events, Hello>({
      port: port1,
      lost: () => {},
      stop: () => {},
      greeted: (hello) => order.push(`greeted ${hello.url}`),
    });
    channel.on("changed", ({ projectId }) => order.push(projectId));
    await channel.ready;
    await turn();
    // A copy seeded from the first words is whole when its changes arrive.
    expect(order).toEqual(["greeted http://127.0.0.1:2", "first"]);
  });

  it("stops delivering to a listener that left, and survives one that throws", async () => {
    const { channel, emit } = await connect();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: string[] = [];
    channel.on("changed", () => {
      throw new Error("A listener failed");
    });
    const leave = channel.on("changed", ({ projectId }) =>
      heard.push(projectId),
    );
    emit("changed", { projectId: "a" });
    await turn();
    leave();
    emit("changed", { projectId: "b" });
    await turn();
    expect(heard).toEqual(["a"]);
  });

  it("drops an event that cannot cross, and keeps answering", async () => {
    const { channel, engine, emit } = await connect();
    const complaint = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: unknown[] = [];
    channel.on("changed", (payload) => heard.push(payload));
    // A payload a test forces past the types, as a bug would.
    Reflect.apply(emit, undefined, ["changed", { projectId: () => {} }]);
    await turn();
    expect(heard).toEqual([]);
    expect(complaint).toHaveBeenCalled();
    await expect(engine.add(1, 1)).resolves.toBe(2);
  });

  it("fails everything waiting when the other end is lost, and says so once", async () => {
    const { channel, engine, lose, lostWith, stops } = await connect();
    const waiting = engine.never();
    const alsoWaiting = engine.slow(1_000);
    lose(new Error("The engine stopped"));
    await expect(waiting).rejects.toThrow("The engine stopped");
    await expect(alsoWaiting).rejects.toThrow("The engine stopped");
    expect(channel.closed).toBe(true);
    expect(lostWith.map((error) => error.message)).toEqual([
      "The engine stopped",
    ]);
    lose(new Error("Again"));
    expect(lostWith).toHaveLength(1);
    expect(stops()).toBe(1);
    // Asked afterwards: refused with why, each caller its own error.
    const first = await engine.add(1, 1).catch((cause: unknown) => cause);
    const second = await engine.add(1, 1).catch((cause: unknown) => cause);
    expect(first).toMatchObject({ message: "The engine stopped" });
    expect(first).not.toBe(second);
  });

  it("fails `ready` when the other end could not start, and tells nobody it was lost", async () => {
    const { channel, say, lostWith } = connectByHand();
    say({
      type: "failed",
      error: { name: "Error", message: "The database is damaged", fields: {} },
    });
    await expect(channel.ready).rejects.toThrow("The database is damaged");
    // It never ran: there is nothing to have lost.
    expect(lostWith).toEqual([]);
    expect(channel.closed).toBe(true);
  });

  it("fails `ready` when the other end is lost before it starts", async () => {
    const { channel, lose, lostWith } = connectByHand();
    lose(new Error("The engine stopped before it started"));
    await expect(channel.ready).rejects.toThrow(
      "The engine stopped before it started",
    );
    expect(lostWith).toEqual([]);
  });

  it("closing fails what is still waiting and refuses what is asked after", async () => {
    const { channel, engine, lostWith, stops } = await connect();
    const answered = engine.add(1, 2);
    await expect(answered).resolves.toBe(3);
    // An operation that never settles would hold its caller for good.
    const held = engine.never();
    await channel.close();
    await expect(held).rejects.toThrow("The engine is closed");
    await expect(engine.add(1, 1)).rejects.toThrow("The engine is closed");
    expect(channel.closed).toBe(true);
    expect(stops()).toBe(1);
    // Asked for, so not a loss.
    expect(lostWith).toEqual([]);
    await channel.close();
    expect(stops()).toBe(1);
  });

  it("ignores an answer that arrives after closing", async () => {
    const { channel, asked, say } = connectByHand();
    say({ type: "ready", operations: ["add"], hello: { url: "" } });
    const { api } = await channel.ready;
    const waiting = api.add(1, 2);
    await turn();
    await channel.close();
    await expect(waiting).rejects.toThrow("The engine is closed");
    const heard: unknown[] = [];
    channel.on("changed", (payload) => heard.push(payload));
    say({ type: "result", id: asked[0]?.id ?? 0, value: 3 });
    say({ type: "event", name: "changed", payload: { projectId: "late" } });
    await turn();
    expect(heard).toEqual([]);
  });

  it("refuses an operation whose name would not survive the crossing", () => {
    const { port2 } = new MessageChannel();
    closers.push(() => port2.close());
    expect(() =>
      serveChannel<Events, Hello>({
        port: port2,
        api: { "a.b": () => 1 },
        hello: { url: "" },
      }),
    ).toThrow("cannot hold a dot");
  });
});
