// A dedicated protocol fd keeps console.log and child command output out of RPC.
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { SidebarSourceModule } from "../shared/sidebar-source.js";

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
});
const controllers = new Map<string, AbortController>();
let cleanup: (() => void) | undefined;
let subscribed = false;
let subscriptionQueue = Promise.resolve();
let actions = Promise.resolve();
const invalidate = () => send({ type: "invalidate" });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
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
  const run = async () => {
    try {
      controller.signal.throwIfAborted();
      const result =
        message.method === "load"
          ? await source.load({
              projectRoot,
              parentId: message.parentId ?? null,
              cursor: message.cursor,
              signal: controller.signal,
            })
          : message.method === "move"
            ? await source.move?.({
                projectRoot,
                itemId: message.itemId,
                parentId: message.parentId ?? null,
                beforeId: message.beforeId,
                signal: controller.signal,
              })
            : message.method === "drop"
              ? await source.drop?.({
                  projectRoot,
                  parentId: message.parentId ?? null,
                  beforeId: message.beforeId,
                  payload: message.payload,
                  signal: controller.signal,
                })
              : await source.action?.({
                  projectRoot,
                  itemId: message.itemId,
                  action: message.action,
                  signal: controller.signal,
                });
      if (message.method !== "load") {
        const handler =
          message.method === "move"
            ? source.move
            : message.method === "drop"
              ? source.drop
              : source.action;
        if (!handler)
          throw new Error(
            `This source does not export a ${message.method} handler.`,
          );
        invalidate();
      }
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
  if (message.method !== "load") actions = actions.then(run);
  else void run();
});
input.on("close", () => {
  cleanup?.();
  process.exit(0);
});
