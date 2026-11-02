import fs from "node:fs/promises";
import path from "node:path";
import { app, protocol, session } from "electron";

export const SHELL_ORIGIN = "work-internal://shell";

/** The application origin is registered before Chromium starts. */
export function registerShellScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "work-internal",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: "work-guest",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function developmentUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
}

/** Only native-created application documents can receive shell authority. */
export function isShellDocument(raw: string): boolean {
  try {
    const url = new URL(raw);
    const development = developmentUrl();
    const expected = new URL(development ?? `${SHELL_ORIGIN}/index.html`);
    return (
      url.protocol === expected.protocol &&
      url.host === expected.host &&
      !url.username &&
      !url.password &&
      (development
        ? [expected.pathname, "/index.html", "/voice.html"].includes(
            url.pathname,
          )
        : ["/index.html", "/voice.html"].includes(url.pathname))
    );
  } catch {
    return false;
  }
}

/** Reloads and fragment changes retain the native document's exact scope. */
export function isSameShellDocument(
  expected: string,
  candidate: string,
): boolean {
  if (!isShellDocument(expected) || !isShellDocument(candidate)) return false;
  const original = new URL(expected);
  const target = new URL(candidate);
  original.hash = "";
  target.hash = "";
  return original.href === target.href;
}

export function shellDocumentUrl({
  page = "index.html",
  query = {},
}: {
  page?: "index.html" | "voice.html";
  query?: Record<string, string>;
} = {}): string {
  const development = developmentUrl();
  const url = development
    ? new URL(
        page === "index.html"
          ? development
          : `${new URL(development).origin}/${page}`,
      )
    : new URL(`${SHELL_ORIGIN}/${page}`);
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return url.href;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Resolve within the built renderer, including a realpath fence for symlinks. */
export async function shellAssetPath({
  url: raw,
  root,
}: {
  url: string;
  root: string;
}): Promise<string | null> {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "work-internal:" ||
      url.host !== "shell" ||
      url.username ||
      url.password
    )
      return null;
    const decoded = decodeURIComponent(url.pathname);
    if (
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => part === ".." || part === ".")
    )
      return null;
    const file = await fs.realpath(path.resolve(root, `.${decoded}`));
    const realRoot = await fs.realpath(root);
    if (
      !file.startsWith(`${realRoot}${path.sep}`) ||
      !MIME_TYPES[path.extname(file)]
    )
      return null;
    return file;
  } catch {
    return null;
  }
}

export function serveShellDocuments({ root }: { root: string }): void {
  session.defaultSession.protocol.handle("work-internal", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 });
    const file = await shellAssetPath({ url: request.url, root });
    if (!file) return new Response(null, { status: 404 });
    return new Response(
      request.method === "HEAD"
        ? null
        : new Uint8Array(await fs.readFile(file)),
      {
        headers: {
          "content-type":
            MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      },
    );
  });
}
