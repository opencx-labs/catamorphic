import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { session } from "electron";
import type { McpAppViews } from "./mcp-app-view-authorization.js";
import { mcpAppViewCsp, mcpAppViewDocument } from "./mcp-apps.js";
import { DESKTOP_API_TOKEN_HEADER } from "./server/local-api-guard.js";

export const mcpAppViewUrl = (mountId: string) =>
  `work-guest://mcp/${encodeURIComponent(mountId)}`;

interface ProjectDocument {
  ownerId: number;
  projectId: string;
  mountId: string;
  source: string;
}

/** Document-only capabilities. This origin exposes no API or native credentials. */
export class GuestDocuments {
  private readonly documents = new Map<string, ProjectDocument>();
  private readonly pdfs = new Map<
    string,
    { ownerId: number; projectId: string; file: string }
  >();
  constructor(
    private readonly deps: {
      api: () => { url: string; apiToken: string } | undefined;
      views: () => McpAppViews | undefined;
      permits: (ownerId: number, projectId: string) => boolean;
      projectRoot?: (projectId: string) => string | undefined;
    },
  ) {}

  projectUrl(input: { ownerId: number; mountId: string; url: string }): string {
    if (!input.mountId || input.mountId.length > 128)
      throw new Error("Invalid app mount");
    const api = this.deps.api();
    if (!api) throw new Error("Work's local server is unavailable. Try again.");
    const source = new URL(input.url);
    const project =
      source.pathname.match(
        /^\/api\/projects\/([^/]+)\/apps\/[^/]+\/guest$/,
      )?.[1] ??
      source.pathname.match(
        /^\/desktop\/projects\/([^/]+)\/remote-api\/api\/projects\/\1\/apps\/[^/]+\/guest$/,
      )?.[1];
    const projectId = project ? decodeURIComponent(project) : undefined;
    if (
      source.origin !== new URL(api.url).origin ||
      source.username ||
      source.password ||
      !projectId ||
      !this.deps.permits(input.ownerId, projectId)
    )
      throw new Error(
        "This app document is not available in this Work window.",
      );
    for (const [id, grant] of this.documents) {
      if (
        grant.ownerId === input.ownerId &&
        grant.mountId === input.mountId &&
        grant.source === source.href
      )
        return `work-guest://${id}/document`;
    }
    const id = `p-${randomUUID()}`;
    this.documents.set(id, {
      ownerId: input.ownerId,
      projectId,
      mountId: input.mountId,
      source: source.href,
    });
    return `work-guest://${id}/document`;
  }

  async pdfUrl(input: {
    ownerId: number;
    projectId: string;
    filePath: string;
  }): Promise<string> {
    const root = this.deps.projectRoot?.(input.projectId);
    if (!root || !this.deps.permits(input.ownerId, input.projectId))
      throw new Error("This document is not available in this Work window.");
    const realRoot = await fs.realpath(root);
    const file = await fs.realpath(path.resolve(realRoot, input.filePath));
    if (
      !file.startsWith(`${realRoot}${path.sep}`) ||
      path.extname(file).toLowerCase() !== ".pdf"
    )
      throw new Error("Choose a PDF in this project.");
    const id = `pdf-${randomUUID()}`;
    this.pdfs.set(id, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      file,
    });
    return `work-guest://${id}/document`;
  }

  close(input: { ownerId: number; url: string }): void {
    try {
      const id = new URL(input.url).hostname;
      if (this.documents.get(id)?.ownerId === input.ownerId)
        this.documents.delete(id);
      if (this.pdfs.get(id)?.ownerId === input.ownerId) this.pdfs.delete(id);
    } catch {
      /* A stale mount has no grant. */
    }
  }

  closeOwner(ownerId: number): void {
    for (const [id, grant] of this.documents)
      if (grant.ownerId === ownerId) this.documents.delete(id);
    for (const [id, grant] of this.pdfs)
      if (grant.ownerId === ownerId) this.pdfs.delete(id);
  }

  serve(): void {
    session.defaultSession.protocol.handle("work-guest", async (request) => {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      try {
        const url = new URL(request.url);
        const pdf = this.pdfs.get(url.hostname);
        if (pdf) {
          if (
            url.pathname !== "/document" ||
            !this.deps.permits(pdf.ownerId, pdf.projectId)
          )
            return new Response(null, { status: 403 });
          const real = await fs.realpath(pdf.file);
          if (real !== pdf.file) return new Response(null, { status: 403 });
          const bytes = await fs.readFile(real);
          if (
            this.pdfs.get(url.hostname) !== pdf ||
            !this.deps.permits(pdf.ownerId, pdf.projectId)
          )
            return new Response(null, { status: 403 });
          return new Response(new Uint8Array(bytes), {
            headers: {
              "content-type": "application/pdf",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
            },
          });
        }
        if (url.hostname === "mcp") {
          const mountId = decodeURIComponent(url.pathname.slice(1));
          const view = await this.deps.views()?.document(mountId);
          return view
            ? new Response(mcpAppViewDocument(view), {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "content-security-policy": mcpAppViewCsp(view),
                  "cache-control": "no-store",
                },
              })
            : new Response(null, { status: 404 });
        }
        const grant = this.documents.get(url.hostname);
        if (
          !grant ||
          url.pathname !== "/document" ||
          !this.deps.permits(grant.ownerId, grant.projectId)
        )
          return new Response(null, { status: 403 });
        const api = this.deps.api();
        if (!api) return new Response(null, { status: 503 });
        const source = new URL(grant.source);
        if (source.origin !== new URL(api.url).origin)
          return new Response(null, { status: 403 });
        const theme = url.searchParams.get("theme");
        if (theme !== null) {
          if (theme.length > 8192) return new Response(null, { status: 400 });
          source.searchParams.set("theme", theme);
        }
        // No cookies, renderer headers, redirects, or arbitrary target URLs.
        const response = await fetch(source, {
          headers: { [DESKTOP_API_TOKEN_HEADER]: api.apiToken },
          redirect: "manual",
          signal: request.signal,
        });
        if (
          this.documents.get(url.hostname) !== grant ||
          !this.deps.permits(grant.ownerId, grant.projectId) ||
          this.deps.api() !== api
        ) {
          await response.body?.cancel();
          return new Response(null, { status: 403 });
        }
        if (
          !response.ok ||
          !response.headers.get("content-type")?.includes("text/html")
        )
          return new Response(null, {
            status: response.ok ? 502 : response.status,
          });
        return new Response(response.body, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              response.headers.get("content-security-policy") ??
              "default-src 'none'",
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response(null, { status: 403 });
      }
    });
  }
}
