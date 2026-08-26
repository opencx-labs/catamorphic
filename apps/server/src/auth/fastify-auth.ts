import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StockAuth } from "./stock-auth.js";

export interface PublicAuthMethods {
  local: boolean;
  providers: Array<{ id: string; label: string }>;
}

export function registerStockAuthRoutes(
  app: FastifyInstance,
  options: {
    auth: StockAuth;
    baseURL: string;
    methods: PublicAuthMethods;
  },
): void {
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
  }

  const forward = (
    request: FastifyRequest,
    reply: FastifyReply,
    pathname?: string,
  ) => forwardToBetterAuth(options, request, reply, pathname);

  app.route({
    method: ["GET", "POST", "OPTIONS"],
    url: "/api/auth/*",
    handler: (request, reply) => forward(request, reply),
  });
  app.get("/.well-known/oauth-authorization-server", (request, reply) =>
    forward(request, reply, "/api/auth/.well-known/oauth-authorization-server"),
  );
  app.get("/.well-known/oauth-protected-resource", (request, reply) =>
    forward(request, reply, "/api/auth/.well-known/oauth-protected-resource"),
  );
  app.get("/login", (_request, reply) =>
    reply
      .type("text/html")
      .send(
        loginPage(
          options.methods,
          continuationQuery(_request),
          Boolean((_request.query as Record<string, string | undefined>).error),
        ),
      ),
  );
  app.post("/login/local", async (request, reply) => {
    const form = formBody(request.body);
    const response = await callBetterAuth(options, request, {
      pathname: "/api/auth/sign-in/username",
      body: JSON.stringify({
        username: form.get("username") ?? "",
        password: form.get("password") ?? "",
      }),
      contentType: "application/json",
    });
    copyCookies(response, reply);
    const query = continuationQuery(request);
    const resumed = response.headers.get("location");
    if (resumed && response.status >= 300 && response.status < 400) {
      return reply.redirect(resumed);
    }
    return response.ok
      ? reply.redirect(`/api/auth/mcp/authorize?${query}`)
      : reply.redirect(`/login?${query}&error=1`);
  });
  app.post<{ Params: { providerId: string } }>(
    "/login/provider/:providerId",
    async (request, reply) => {
      if (
        !options.methods.providers.some(
          (provider) => provider.id === request.params.providerId,
        )
      ) {
        return reply.status(404).send("Provider not found");
      }
      const query = continuationQuery(request);
      const callbackURL = new URL(
        `/api/auth/mcp/authorize?${query}`,
        options.baseURL,
      ).toString();
      const response = await callBetterAuth(options, request, {
        pathname: "/api/auth/sign-in/oauth2",
        body: JSON.stringify({
          providerId: request.params.providerId,
          callbackURL,
        }),
        contentType: "application/json",
      });
      copyCookies(response, reply);
      const result = (await response.json().catch(() => ({}))) as {
        url?: unknown;
      };
      return response.ok && typeof result.url === "string"
        ? reply.redirect(result.url)
        : reply.redirect(`/login?${query}&error=1`);
    },
  );
  app.get("/oauth/consent", (request, reply) =>
    reply
      .type("text/html")
      .send(consentPage(request.query as Record<string, string | undefined>)),
  );
  app.post("/oauth/consent", async (request, reply) => {
    const form = formBody(request.body);
    const response = await callBetterAuth(options, request, {
      pathname: "/api/auth/oauth2/consent",
      body: JSON.stringify({
        accept: form.get("accept") === "true",
        consent_code: form.get("consent_code") ?? "",
      }),
      contentType: "application/json",
    });
    copyCookies(response, reply);
    const result = (await response.json().catch(() => ({}))) as {
      redirectURI?: unknown;
    };
    return response.ok && typeof result.redirectURI === "string"
      ? reply.redirect(result.redirectURI)
      : reply
          .status(400)
          .type("text/html")
          .send("Authorization could not be completed.");
  });
}

async function forwardToBetterAuth(
  options: { auth: StockAuth; baseURL: string },
  request: FastifyRequest,
  reply: FastifyReply,
  pathname?: string,
): Promise<FastifyReply> {
  const response = await callBetterAuth(options, request, { pathname });
  reply.status(response.status);
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") reply.header(name, value);
  }
  copyCookies(response, reply);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return reply.send(bytes.byteLength > 0 ? Buffer.from(bytes) : null);
}

async function callBetterAuth(
  options: { auth: StockAuth; baseURL: string },
  request: FastifyRequest,
  overrides: {
    pathname?: string;
    body?: string;
    contentType?: string;
  },
): Promise<Response> {
  const incoming = new URL(request.raw.url ?? "/", options.baseURL);
  if (overrides.pathname) {
    incoming.pathname = overrides.pathname;
    incoming.search = "";
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) headers.append(name, String(entry));
    }
  }
  if (overrides.contentType) {
    headers.set("content-type", overrides.contentType);
  }
  if (overrides.body !== undefined) {
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  const method =
    overrides.body === undefined ? request.method.toUpperCase() : "POST";
  return options.auth.handler(
    new Request(incoming, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: overrides.body ?? requestBody(request) }),
    }),
  );
}

function copyCookies(response: Response, reply: FastifyReply): void {
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
}

function requestBody(
  request: FastifyRequest,
): string | Uint8Array | URLSearchParams | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === "string" || request.body instanceof Uint8Array) {
    return request.body;
  }
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(
      Object.entries(request.body as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)],
      ),
    );
  }
  return JSON.stringify(request.body);
}

function loginPage(
  methods: PublicAuthMethods,
  continuation: string,
  failed: boolean,
): string {
  const escapedContinuation = escapeHtml(continuation);
  const providers = methods.providers
    .map(
      (provider) =>
        `<form action="/login/provider/${encodeURIComponent(provider.id)}?${escapedContinuation}" method="post"><button>Continue with ${escapeHtml(provider.label)}</button></form>`,
    )
    .join("");
  const local = methods.local
    ? `<form id="local" action="/login/local?${escapedContinuation}" method="post"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`
    : "";
  const error = failed
    ? '<p id="error" role="alert">Sign in failed. Check your credentials and try again.</p>'
    : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Catamorphic</title><main><h1>Sign in to Catamorphic</h1>${providers}${local}${error}</main>`;
}

function consentPage(query: Record<string, string | undefined>): string {
  const code = escapeHtml(query.consent_code ?? "");
  const client = escapeHtml(query.client_id ?? "this client");
  const scopes = escapeHtml(query.scope ?? "basic identity");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Catamorphic</title><main><h1>Authorize ${client}</h1><p>Requested access: ${scopes}</p><form action="/oauth/consent" method="post"><input type="hidden" name="consent_code" value="${code}"><button name="accept" value="true">Allow</button><button name="accept" value="false">Deny</button></form></main>`;
}

function continuationQuery(request: FastifyRequest): string {
  const url = new URL(request.raw.url ?? "/", "http://localhost");
  url.searchParams.delete("error");
  return url.searchParams.toString();
}

function formBody(body: unknown): URLSearchParams {
  if (typeof body === "string") return new URLSearchParams(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new URLSearchParams();
  }
  return new URLSearchParams(
    Object.entries(body).map(([key, value]) => [key, String(value)]),
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
