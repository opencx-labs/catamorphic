import fs from "node:fs/promises";
import path from "node:path";
import { contentTypeFor } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";

/**
 * Serve a built single-page app (the mobile PWA) from a dist directory:
 * static assets by path, `index.html` for everything else (hash-routed
 * SPA). Shared by the stock server's root and the desktop's LAN pairing
 * listener, so path handling and headers stay identical on both origins.
 *
 * Registered as a catch-all `GET /*`; register AFTER every specific
 * route. `fallback` renders when the dist has no index.html (e.g. the
 * stock server's landing page).
 */
export function serveSpaDist(
  app: FastifyInstance,
  resolveDist: () => string,
  fallback?: (reply: SpaReply) => unknown,
): void {
  app.get("/*", async (request, reply) => {
    const dist = resolveDist();
    const index = path.join(dist, "index.html");
    if (!(await exists(index))) {
      if (fallback) return fallback(reply);
      return reply
        .status(503)
        .type("text/plain")
        .send(
          "The app bundle is missing. Build it first: bun run --filter catamorphic-pwa build",
        );
    }
    const requested = decodeURIComponent(
      (request.url.split("?")[0] ?? "/").replace(/^\/+/, ""),
    );
    const resolved = path.resolve(dist, requested || "index.html");
    // Boundary check via relative path: a plain startsWith(dist) would
    // also match sibling directories like `dist-evil`.
    const relative = path.relative(dist, resolved);
    const inside =
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative);
    const file = inside && (await isFile(resolved)) ? resolved : index;
    // Vite emits content-hashed filenames under assets/: immutable. The
    // HTML shell (and anything unhashed) must revalidate so deploys land.
    reply.header(
      "cache-control",
      file !== index && relative.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return reply.type(spaContentType(file)).send(await fs.readFile(file));
  });
}

type SpaReply = {
  status: (code: number) => SpaReply;
  type: (contentType: string) => SpaReply;
  send: (payload: unknown) => unknown;
};

/** Core's map plus the web-app types it doesn't carry. */
function spaContentType(file: string): string {
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".ico")) return "image/x-icon";
  return contentTypeFor(file);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
