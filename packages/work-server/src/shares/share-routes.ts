import { randomBytes } from "node:crypto";
import { appGuestCsp, buildAppGuestDocument } from "@catamorphic/app";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { micromark } from "micromark";
import { z } from "zod";
import type { WorkAuth, WorkAuthUser } from "../auth/work-auth.js";
import { workMark } from "../brand.js";
import {
  CreateShareSchema,
  type Share,
  ShareAccessError,
  type WorkSharesService,
} from "./shares-service.js";

const CallSchema = z.strictObject({
  workflowName: z.string().min(1).max(200),
  mode: z.enum(["invoke", "start"]),
  input: z.json(),
});

/**
 * Shares (ADR 0165). Members manage them through the bearer API; viewers
 * open `/s/:id` in a browser with a sign-in cookie. Viewer pages read with a
 * confined identity, never the viewer's own membership, and state-changing
 * viewer requests must come from this origin with the share header.
 */
export function registerShareRoutes(
  app: FastifyInstance,
  options: {
    core: CatamorphicCore;
    auth: Pick<WorkAuth, "sessionFromCookies">;
    shares: WorkSharesService;
    publicBase: string;
    /** The member identity a bearer request carries, or null. */
    caller(request: FastifyRequest): Promise<Identity | null>;
  },
): void {
  const { core, shares } = options;
  const origin = new URL(options.publicBase).origin;

  // --- management (members, bearer) -----------------------------------
  const managed = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (identity: Identity, projectId: string) => Promise<unknown>,
  ) => {
    const identity = await options.caller(request);
    if (!identity) return reply.status(401).send({ error: "Unauthorized" });
    const { projectId } = request.params as { projectId: string };
    try {
      return await run(identity, projectId);
    } catch (error) {
      const status = error instanceof ShareAccessError ? 403 : 400;
      return reply.status(status).send({
        error: error instanceof Error ? error.message : "Share failed",
      });
    }
  };
  app.post("/api/projects/:projectId/shares", (request, reply) =>
    managed(request, reply, async (identity, projectId) => {
      const input = CreateShareSchema.parse(request.body);
      const share = await shares.create({ identity, projectId, input });
      return reply.status(201).send(share);
    }),
  );
  app.get("/api/projects/:projectId/shares", (request, reply) =>
    managed(request, reply, async (identity, projectId) => ({
      shares: await shares.list({ identity, projectId }),
    })),
  );
  app.delete("/api/projects/:projectId/shares/:shareId", (request, reply) =>
    managed(request, reply, async (identity, projectId) => {
      const { shareId } = request.params as { shareId: string };
      return (await shares.revoke({ identity, projectId, shareId }))
        ? reply.status(204).send()
        : reply.status(404).send({ error: "Share not found" });
    }),
  );

  // --- viewing (browser session) --------------------------------------
  const viewer = async (
    request: FastifyRequest,
  ): Promise<WorkAuthUser | null> => {
    const cookie = request.headers.cookie;
    return cookie ? options.auth.sessionFromCookies({ cookie }) : null;
  };
  const opened = async (request: FastifyRequest, reply: FastifyReply) => {
    const { shareId } = request.params as { shareId: string };
    const person = await viewer(request);
    if (!person) {
      await reply.redirect(
        `/login?next=${encodeURIComponent(`/s/${shareId}`)}`,
      );
      return undefined;
    }
    const share = await shares.open({ shareId, viewer: person });
    if (!share) {
      await sendPage(reply.status(404), {
        title: "Not available",
        body: `<p>This link is not available to ${escapeHtml(person.email)}. It may have expired or been withdrawn, or it was shared with a different account.</p><p><a href="/login?next=${encodeURIComponent(`/s/${shareId}`)}">Sign in with another account</a></p>`,
      });
      return undefined;
    }
    return { ...share, viewer: person };
  };
  /** Viewer writes: same origin, share header, never a cross-site form. */
  const sameOrigin = (request: FastifyRequest) =>
    request.headers.origin === origin &&
    request.headers["x-work-share"] === "1";

  app.get("/s/:shareId", async (request, reply) => {
    const context = await opened(request, reply);
    if (!context) return reply;
    const { share } = context;
    await shares.record({
      shareId: share.id,
      viewer: context.viewer,
      action: "open",
    });
    if (share.kind === "app") return sendAppPage(reply, share);
    if (share.kind === "document") {
      return sendDocument(reply, {
        core,
        share,
        identity: context.identity,
        path: share.target,
        raw: `/s/${share.id}/raw`,
      });
    }
    const entries = await core.documents.list({
      identity: context.identity,
      projectId: share.projectId,
      prefix: share.target,
    });
    const items = entries
      .filter((entry) => entry.path.startsWith(`${share.target}/`))
      .map((entry) => {
        const relative = entry.path.slice(share.target.length + 1);
        return `<li><a href="/s/${share.id}/f/${relative
          .split("/")
          .map(encodeURIComponent)
          .join("/")}">${escapeHtml(relative)}</a></li>`;
      })
      .join("");
    return sendPage(reply, {
      title: share.title,
      body: items ? `<ul class="files">${items}</ul>` : "<p>No files yet.</p>",
    });
  });

  app.get("/s/:shareId/f/*", async (request, reply) => {
    const context = await opened(request, reply);
    if (context?.share.kind !== "folder") {
      return context ? reply.status(404).send() : reply;
    }
    const relative = (request.params as { "*": string })["*"];
    const path = `${context.share.target}/${decodeURIComponent(relative)}`;
    return sendDocument(reply, {
      core,
      share: context.share,
      identity: context.identity,
      path,
      raw: `/s/${context.share.id}/raw/${relative}`,
      back: `/s/${context.share.id}`,
    });
  });

  const raw = async (
    request: FastifyRequest,
    reply: FastifyReply,
    relative?: string,
  ) => {
    const context = await opened(request, reply);
    if (!context) return reply;
    const { share } = context;
    if (share.kind === "app") return reply.status(404).send();
    const path =
      share.kind === "folder" && relative
        ? `${share.target}/${decodeURIComponent(relative)}`
        : share.target;
    try {
      const document = await core.documents.readBytes({
        identity: context.identity,
        projectId: share.projectId,
        path,
      });
      await shares.record({
        shareId: share.id,
        viewer: context.viewer,
        action: "download",
        detail: path,
      });
      // Shared bytes never execute on this origin.
      return reply
        .header("content-type", document.contentType)
        .header("content-security-policy", "sandbox")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .header(
          "content-disposition",
          `attachment; filename="${path.split("/").at(-1)?.replace(/"/g, "") ?? "file"}"`,
        )
        .send(Buffer.from(document.bytes));
    } catch {
      return reply.status(404).send();
    }
  };
  app.get("/s/:shareId/raw", (request, reply) => raw(request, reply));
  app.get("/s/:shareId/raw/*", (request, reply) =>
    raw(request, reply, (request.params as { "*": string })["*"]),
  );

  // --- a shared app -----------------------------------------------------
  const appContext = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await opened(request, reply);
    if (!context) return undefined;
    if (context.share.kind !== "app" || !core.apps) {
      await reply.status(404).send();
      return undefined;
    }
    const identity = await core.apps.identityForApp({
      identity: context.identity,
      projectId: context.share.projectId,
      appName: context.share.target,
    });
    return { ...context, identity, apps: core.apps };
  };

  app.get("/s/:shareId/app/guest", async (request, reply) => {
    const context = await appContext(request, reply);
    if (!context) return reply;
    const { share, identity } = context;
    const state = await context.apps.viewState({
      identity,
      projectId: share.projectId,
      appName: share.target,
    });
    if (state.state !== "ready") return reply.status(404).send();
    const storage = await core.appStorage.get(
      identity,
      share.projectId,
      share.target,
    );
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header(
        "content-security-policy",
        appGuestCsp(state.allowedNetworkOrigins),
      )
      .header("cache-control", "private, no-store")
      .send(
        buildAppGuestDocument({
          code: state.code,
          css: state.css,
          allowedNetworkOrigins: state.allowedNetworkOrigins,
          storageSeed: storage.data,
        }),
      );
  });

  app.post("/s/:shareId/app/call", async (request, reply) => {
    if (!sameOrigin(request)) return reply.status(403).send();
    const context = await appContext(request, reply);
    if (!context) return reply;
    const body = CallSchema.safeParse(request.body);
    if (!body.success) {
      return reply.send(failure("not_serializable", "Invalid call"));
    }
    const { share, identity } = context;
    await shares.record({
      shareId: share.id,
      viewer: context.viewer,
      action: body.data.mode === "start" ? "start" : "call",
      detail: body.data.workflowName,
    });
    try {
      if (body.data.mode === "start") {
        const run = await core.runs.triggerProduction({
          identity,
          projectId: share.projectId,
          workflowName: body.data.workflowName,
          input: body.data.input,
        });
        return { ok: true, value: { runId: run.id } };
      }
      const outcome = await core.runs.call({
        identity,
        projectId: share.projectId,
        workflowName: body.data.workflowName,
        input: body.data.input,
      });
      if (outcome.status === "completed") {
        return { ok: true, value: outcome.output };
      }
      if (outcome.status === "failed") {
        return failure("workflow_failed", outcome.error);
      }
      // Suspended: follow the run briefly, then hand back a timeout.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const run = await core.runs.get({ identity, runId: outcome.runId });
        if (run.status === "completed") return { ok: true, value: run.result };
        if (run.status === "failed" || run.status === "canceled") {
          return failure("workflow_failed", run.error ?? `Run ${run.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return failure(
        "timeout",
        `The call is still running (run ${outcome.runId})`,
      );
    } catch {
      return failure("denied", "This app cannot call that workflow here");
    }
  });

  app.get("/s/:shareId/app/runs/:runId", async (request, reply) => {
    const context = await appContext(request, reply);
    if (!context) return reply;
    const { runId } = request.params as { runId: string };
    try {
      const run = await core.runs.get({ identity: context.identity, runId });
      return {
        ok: true,
        value: {
          runId: run.id,
          status: run.status,
          output: run.result ?? null,
          error: run.error ?? null,
        },
      };
    } catch {
      return failure("denied", "Run not found");
    }
  });

  app.post(
    "/s/:shareId/app/storage",
    { bodyLimit: 512 * 1024 },
    async (request, reply) => {
      if (!sameOrigin(request)) return reply.status(403).send();
      const context = await appContext(request, reply);
      if (!context) return reply;
      const data = z
        .record(z.string(), z.string())
        .safeParse((request.body as { data?: unknown } | undefined)?.data);
      if (!data.success) return reply.status(400).send();
      await core.appStorage
        .put(
          context.identity,
          context.share.projectId,
          context.share.target,
          data.data,
        )
        .catch(() => undefined);
      return { ok: true };
    },
  );
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

async function sendDocument(
  reply: FastifyReply,
  args: {
    core: CatamorphicCore;
    share: Share;
    identity: Identity;
    path: string;
    raw: string;
    back?: string;
  },
) {
  try {
    const document = await args.core.documents.read({
      identity: args.identity,
      projectId: args.share.projectId,
      path: args.path,
    });
    const name = args.path.split("/").at(-1) ?? args.path;
    const back = args.back ? `<p><a href="${args.back}">All files</a></p>` : "";
    const download = `<p class="actions"><a href="${args.raw}">Download ${escapeHtml(name)}</a></p>`;
    const text = document.text;
    const body =
      text === undefined
        ? "<p>This file cannot be shown here.</p>"
        : /\.(md|markdown)$/i.test(name)
          ? // micromark escapes raw HTML and unsafe link protocols.
            `<article class="markdown">${micromark(text)}</article>`
          : `<pre>${escapeHtml(text)}</pre>`;
    return sendPage(reply, {
      title: args.share.kind === "folder" ? name : args.share.title,
      body: `${back}${body}${download}`,
    });
  } catch {
    return sendPage(reply.status(404), {
      title: "Not found",
      body: "<p>That file is not part of this share.</p>",
    });
  }
}

function sendAppPage(reply: FastifyReply, share: Share) {
  return sendPage(reply, {
    title: share.title,
    wide: true,
    body: `<iframe id="app" class="app" title="${escapeHtml(share.title)}" sandbox="allow-scripts allow-forms allow-popups" src="/s/${share.id}/app/guest"></iframe>`,
    script: brokerScript(share.id),
  });
}

/**
 * The share page's side of the app protocol (see `@catamorphic/app`): the
 * app frame has no credentials and an opaque origin; this page relays its
 * calls to the share routes, which re-authorize each one.
 */
function brokerScript(shareId: string): string {
  return `
const frame = document.getElementById("app");
const base = "/s/${shareId}/app";
const post = (path, body) => fetch(base + path, {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json", "x-work-share": "1" },
  body: JSON.stringify(body),
}).then((r) => r.ok ? r.json() : { ok: false, error: { code: "denied", message: "Not allowed" } });
const reply = (callId, result) => frame.contentWindow.postMessage(
  { catamorphicApp: 1, kind: "result", callId, ...result }, "*");
frame.addEventListener("load", () => {
  frame.contentWindow.postMessage({ catamorphicApp: 1, kind: "context",
    context: { tenantId: "", user: { id: "viewer" } } }, "*");
  frame.contentWindow.postMessage({ catamorphicApp: 1, kind: "display",
    display: { mode: "full", visible: true } }, "*");
});
window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || message.catamorphicApp !== 1) return;
  if (message.kind === "resize" && typeof message.height === "number") {
    frame.style.height = Math.max(240, Math.min(message.height, 4000)) + "px";
  } else if (message.kind === "call") {
    reply(message.callId, await post("/call", {
      workflowName: message.workflowName, mode: message.mode, input: message.input,
    }));
  } else if (message.kind === "poll-run") {
    const r = await fetch(base + "/runs/" + encodeURIComponent(message.runId), { credentials: "same-origin" });
    reply(message.callId, r.ok ? await r.json() : { ok: false, error: { code: "denied", message: "Run not found" } });
  } else if (message.kind === "storage" && message.data) {
    post("/storage", { data: message.data });
  } else if (message.kind === "collection") {
    reply(message.callId, { ok: false, error: { code: "denied", message: "Not available in shared apps" } });
  }
});`;
}

function sendPage(
  reply: FastifyReply,
  page: { title: string; body: string; script?: string; wide?: boolean },
) {
  const nonce = randomBytes(18).toString("base64url");
  return reply
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    )
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "private, no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)} | Work</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --bg: #fafafa; --fg: #16161a; --muted: #5d5d66; --border: #e3e3e8; --accent: #f95225; }
@media (prefers-color-scheme: dark) { :root { --bg: #0a0a0b; --fg: #e6e6e9; --muted: #9a9aa3; --border: #26262b; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, sans-serif; }
header { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
header span { font-weight: 600; font-size: 13px; color: var(--muted); }
main { max-width: ${page.wide ? "1200px" : "760px"}; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 20px; letter-spacing: -0.02em; }
a { color: var(--accent); }
pre { overflow: auto; padding: 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
.markdown img { max-width: 100%; }
.files { padding-left: 18px; }
.actions { margin-top: 28px; font-size: 13px; }
.app { width: 100%; min-height: 70vh; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
</style>
</head>
<body>
<header>${workMark({ size: 22 })}<span>Shared with you</span></header>
<main><h1>${escapeHtml(page.title)}</h1>${page.body}</main>
${page.script ? `<script nonce="${nonce}">${page.script}</script>` : ""}
</body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
