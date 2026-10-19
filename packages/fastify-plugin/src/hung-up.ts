import type { FastifyReply } from "fastify";

/**
 * Aborts when the caller hangs up before the answer is sent, so a long
 * poll or wait nobody is listening to any more ends.
 */
export function hungUp(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
