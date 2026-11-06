// A dedicated protocol fd keeps console.log and child command output out of RPC.
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type {
  SidebarSourceModule,
  SidebarSourceWork,
  SidebarSourceWorkCall,
} from "../shared/sidebar-source.js";

const send = (value: unknown) => {
  writeSync(3, `${JSON.stringify(value)}\n`);
};
const projectRoot = process.cwd();
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Missing sidebar module path");
const source: SidebarSourceModule = (
  await import(pathToFileURL(sourcePath).href)
).default;
if (typeof source?.load !== "function")
  throw new Error("Sidebar source must export default { load }.");
send({
  type: "capabilities",
  move: typeof source.move === "function",
  drop: typeof source.drop === "function",
  reveal: typeof source.reveal === "function",
});
const controllers = new Map<string, AbortController>();
let cleanup: (() => void) | undefined;
let subscribed = false;
let subscriptionQueue = Promise.resolve();
let actions = Promise.resolve();
const invalidate = () => send({ type: "invalidate" });

/**
 * Work, for one request (ADR 0234): each call names the request it serves,
 * so the window that asked answers it, under that section's grants.
 */
const workCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let workCallCount = 0;
const isPage = (
  value: unknown,
): value is Awaited<ReturnType<SidebarSourceWork["read"]>> =>
  typeof value === "object" &&
  value !== null &&
  "items" in value &&
  Array.isArray(value.items);
const workFor = (requestId: string, signal: AbortSignal): SidebarSourceWork => {
  const call = (body: SidebarSourceWorkCall) =>
    new Promise<unknown>((resolve, reject) => {
      signal.throwIfAborted();
      workCallCount += 1;
      const id = `${requestId}#${workCallCount}`;
      workCalls.set(id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          if (workCalls.delete(id)) reject(new Error("Request cancelled."));
        },
        { once: true },
      );
      send({ type: "work", id, requestId, call: body });
    });
  return {
    read: async (request) => {
      // Main validated the page; it crosses as the rows a module returns.
      const page = await call({ op: "read", ...request });
      if (!isPage(page)) throw new Error("Work returned no page.");
      return page;
    },
    execute: async (request) => {
      await call({ op: "execute", ...request });
    },
    call: (request) => call({ op: "call", ...request }),
  };
};

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "work-result") {
    const pending = workCalls.get(message.id);
    if (!pending) return;
    workCalls.delete(message.id);
    if (typeof message.error === "string")
      pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  if (message.method === "cancel") {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message.method === "subscribe" || message.method === "unsubscribe") {
    const active = message.method === "subscribe";
    subscriptionQueue = subscriptionQueue
      .then(async () => {
        if (active === subscribed) return;
        subscribed = active;
        cleanup?.();
        cleanup = undefined;
        if (active)
          cleanup = await source.subscribe?.({ projectRoot, invalidate });
      })
      .catch((cause) =>
        send({ type: "subscription-error", error: String(cause) }),
      );
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  const context = {
    projectRoot,
    signal: controller.signal,
    work: workFor(message.id, controller.signal),
    // A session-scoped section's chat (ADR 0226), for every handler.
    ...(message.session ? { session: message.session } : {}),
  };
  const run = async () => {
    try {
      controller.signal.throwIfAborted();
      const handler =
        message.method === "load"
          ? source.load
          : message.method === "move"
            ? source.move
            : message.method === "drop"
              ? source.drop
              : message.method === "reveal"
                ? source.reveal
                : source.action;
      if (!handler)
        throw new Error(
          `This source does not export a ${message.method} handler.`,
        );
      const result =
        message.method === "load"
          ? await source.load({
              ...context,
              parentId: message.parentId ?? null,
              cursor: message.cursor,
              ...(typeof message.query === "string"
                ? { query: message.query }
                : {}),
            })
          : message.method === "move"
            ? await source.move?.({
                ...context,
                itemId: message.itemId,
                parentId: message.parentId ?? null,
                beforeId: message.beforeId,
              })
            : message.method === "drop"
              ? await source.drop?.({
                  ...context,
                  parentId: message.parentId ?? null,
                  beforeId: message.beforeId,
                  payload: message.payload,
                })
              : message.method === "reveal"
                ? await source.reveal?.({
                    ...context,
                    url: message.url,
                    after: message.after,
                  })
                : await source.action?.({
                    ...context,
                    itemId: message.itemId,
                    action: message.action,
                    ...(message.values ? { values: message.values } : {}),
                  });
      if (
        message.method === "action" ||
        message.method === "move" ||
        message.method === "drop"
      )
        invalidate();
      if (!controller.signal.aborted)
        send({ id: message.id, result: result ?? null });
    } catch (cause) {
      if (!controller.signal.aborted)
        send({
          id: message.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      controllers.delete(message.id);
    }
  };
  // Writes from multiple views of the same source cannot race one another.
  if (
    message.method === "action" ||
    message.method === "move" ||
    message.method === "drop"
  )
    actions = actions.then(run);
  else void run();
});
input.on("close", () => {
  cleanup?.();
  process.exit(0);
});
