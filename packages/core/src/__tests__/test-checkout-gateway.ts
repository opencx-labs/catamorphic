import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
  checkoutTarget,
  type WorkspaceCheckoutsService,
} from "../services/workspace-checkouts.js";

/**
 * A gateway that serves checkouts over loopback HTTP, as a host's
 * `/gateway/checkout/*` route does (ADR 0353): what a test's sandboxes
 * fetch their base from. `url` is the gateway's, without `/checkout`.
 */
export async function startCheckoutGateway(
  checkouts: () => WorkspaceCheckoutsService,
): Promise<{
  url: string;
  /** Requests answered so far, by operation. */
  served: { advertise: number; "upload-pack": number; refused: number };
  close(): Promise<void>;
}> {
  const served = { advertise: 0, "upload-pack": 0, refused: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://work.test");
      const prefix = "/gateway/checkout/";
      const method = request.method === "POST" ? "POST" : "GET";
      const target = url.pathname.startsWith(prefix)
        ? checkoutTarget({
            method,
            path: url.pathname.slice(prefix.length),
            service: url.searchParams.get("service") ?? undefined,
          })
        : null;
      if (!target) {
        response.writeHead(404).end("Not a Git request\n");
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers))
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const answer = await checkouts().handle({
        id: target.id,
        operation: target.operation,
        authorization: headers.authorization,
        headers,
        ...(method === "POST" ? { body: request } : {}),
      });
      if (answer.status === 200) served[target.operation] += 1;
      else served.refused += 1;
      response.writeHead(answer.status, answer.headers);
      if (answer.body instanceof Uint8Array) response.end(answer.body);
      else Readable.from(answer.body).pipe(response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The test gateway has no address");
  return {
    url: `http://127.0.0.1:${address.port}/gateway`,
    served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
