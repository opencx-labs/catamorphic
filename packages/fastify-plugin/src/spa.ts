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
    const contents = await fs.readFile(file);
    if (file.endsWith(".webmanifest")) {
      const launch = new URL(
        request.url,
        "http://catamorphic.local",
      ).searchParams.get("launch");
      if (launch) {
        return reply
          .type(spaContentType(file))
          .send(
            JSON.stringify(
              pwaManifestWithLaunch(
                JSON.parse(contents.toString("utf8")) as Record<
                  string,
                  unknown
                >,
                launch,
              ),
            ),
          );
      }
    }
    return reply.type(spaContentType(file)).send(contents);
  });
}

/**
 * Carry a credential-free connection locator into an installed PWA without
 * allowing a manifest query to turn the app into an open redirect.
 */
export function pwaManifestWithLaunch(
  manifest: Record<string, unknown>,
  rawLaunch: string | undefined,
): Record<string, unknown> {
  if (!rawLaunch) return manifest;
  try {
    const base = new URL("http://catamorphic.local/");
    const launch = new URL(rawLaunch, base);
    if (
      launch.origin !== base.origin ||
      launch.pathname !== "/" ||
      launch.username ||
      launch.password ||
      launch.hash
    ) {
      return manifest;
    }
    return { ...manifest, start_url: `${launch.pathname}${launch.search}` };
  } catch {
    return manifest;
  }
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
