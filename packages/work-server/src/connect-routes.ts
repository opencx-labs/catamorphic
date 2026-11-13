import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { CONNECT_BINDING_COOKIE } from "@catamorphic/fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkAuth } from "./auth/work-auth-types.js";
import { escapeHtml, sendPage } from "./shares/share-routes.js";

/** How long the browser binding outlives the redirect upstream. */
const BINDING_MAX_AGE_SECONDS = 15 * 60;

/**
 * Where a member's own agent sends its person to connect an account
 * (ADR 0316). The page needs a browser signed in to Work as the member the
 * link was made for; it redeems the link, binds the attempt to this browser
 * with an HTTP-only cookie, and continues to the provider. A link forwarded
 * to someone else opens nothing, and an upstream consent page forwarded
 * from here completes nowhere but this browser.
 */
export function registerConnectRoutes(
  app: FastifyInstance,
  options: {
    core: CatamorphicCore;
    auth: Pick<WorkAuth, "sessionFromCookies">;
    publicBase: string;
    /** The live member identity of a signed-in account, or null. */
    memberForUser(userId: string): Promise<Identity | null>;
  },
): void {
  const origin = new URL(options.publicBase).origin;
  const secure = origin.startsWith("https:");
  const callback = `${options.publicBase}/api/connection-authorizations/callback`;

  const member = async (request: FastifyRequest) => {
    const cookie = request.headers.cookie;
    const person = cookie
      ? await options.auth.sessionFromCookies({ cookie })
      : null;
    return person ? options.memberForUser(person.id) : null;
  };
  const unavailable = (reply: FastifyReply, message: string) =>
    sendPage(reply.status(410), {
      title: "Link not available",
      body: `<p>${escapeHtml(message)}</p><p>Ask your agent for a new link.</p>`,
    });

  app.get("/connect/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const identity = await member(request);
    if (!identity) {
      return reply.redirect(
        `/login?next=${encodeURIComponent(`/connect/${token}`)}`,
      );
    }
    const connections = options.core.connections;
    if (!connections)
      return unavailable(reply, "Connections are not configured.");
    let started: Awaited<ReturnType<typeof connections.redeemConnectionOffer>>;
    try {
      started = await connections.redeemConnectionOffer({
        identity,
        token,
        redirectUri: callback,
      });
    } catch {
      return unavailable(
        reply,
        "This link has expired, was already used, or was made for another account.",
      );
    }
    reply.header(
      "set-cookie",
      `${CONNECT_BINDING_COOKIE}=${started.browserBinding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${BINDING_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
    );
    const { challenge } = started;
    if (challenge.kind === "url") return reply.redirect(challenge.url, 303);
    const state = escapeHtml(started.authorizationId);
    if (challenge.kind === "device") {
      return sendPage(reply, {
        title: `Connect ${started.alias}`,
        body: `<p>Open <a href="${escapeHtml(challenge.verificationUrl)}" rel="noreferrer" target="_blank">${escapeHtml(challenge.verificationUrl)}</a> and enter <strong>${escapeHtml(challenge.userCode)}</strong>.</p><form method="post" action="/connect/complete"><input type="hidden" name="state" value="${state}"><button type="submit">I have entered the code</button></form>`,
      });
    }
    const fields = challenge.fields
      .map(
        (field) =>
          `<p><label>${escapeHtml(field.label)}<br><input name="field.${escapeHtml(field.name)}" type="${field.secret ? "password" : "text"}" autocomplete="off"${field.required ? " required" : ""}></label></p>`,
      )
      .join("");
    return sendPage(reply, {
      title: `Connect ${started.alias}`,
      body: `<form method="post" action="/connect/complete"><input type="hidden" name="state" value="${state}">${fields}<button type="submit">Connect</button></form>`,
    });
  });

  app.post("/connect/complete", async (request, reply) => {
    if (request.headers.origin !== origin) {
      return reply.status(403).send({ error: "Cross-origin request refused" });
    }
    const identity = await member(request);
    const connections = options.core.connections;
    if (!identity || !connections) {
      return unavailable(reply, "Sign in to Work to connect this account.");
    }
    const form = new URLSearchParams(
      typeof request.body === "string" ? request.body : "",
    );
    const state = form.get("state") ?? "";
    const binding = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === CONNECT_BINDING_COOKIE)?.[1];
    const fields = Object.fromEntries(
      [...form.entries()]
        .filter(([name]) => name.startsWith("field."))
        .map(([name, value]) => [name.slice("field.".length), value]),
    );
    try {
      await connections.completeAuthorization({
        identity,
        state,
        callback: fields,
        ...(binding ? { browserBinding: binding } : {}),
      });
    } catch {
      return unavailable(reply, "That did not connect the account.");
    }
    return sendPage(reply, {
      title: "Connected",
      body: "<p>Your account is connected. You can close this page and return to your agent.</p>",
    });
  });
}
