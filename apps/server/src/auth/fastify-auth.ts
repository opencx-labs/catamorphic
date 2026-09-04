import { randomBytes } from "node:crypto";
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
    sendAuthPage(reply, (nonce) =>
      loginPage(
        options.methods,
        continuationQuery(_request),
        Boolean((_request.query as Record<string, string | undefined>).error),
        nonce,
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
    sendAuthPage(reply, (nonce) =>
      consentPage(request.query as Record<string, string | undefined>, nonce),
    ),
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
      : sendAuthPage(reply.status(400), (nonce) =>
          messagePage(
            "Authorization could not be completed",
            "Return to Catamorphic and try connecting again.",
            nonce,
          ),
        );
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
  nonce: string,
): string {
  const escapedContinuation = escapeHtml(continuation);
  const providers = methods.providers
    .map(
      (provider) =>
        `<form action="/login/provider/${encodeURIComponent(provider.id)}?${escapedContinuation}" method="post"><button class="button button-secondary" type="submit">Continue with ${escapeHtml(provider.label)}</button></form>`,
    )
    .join("");
  const local = methods.local
    ? `<form id="local" class="local-form" action="/login/local?${escapedContinuation}" method="post"${failed ? ' aria-describedby="sign-in-error"' : ""}>
        <div class="field-group">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" enterkeyhint="next" required autofocus>
        </div>
        <div class="field-group">
          <label for="current-password">Password</label>
          <div class="password-field">
            <input id="current-password" name="password" type="password" autocomplete="current-password" enterkeyhint="done" required>
            <button id="toggle-password" class="password-toggle" type="button" aria-controls="current-password" aria-pressed="false">Show</button>
          </div>
        </div>
        <button class="button button-primary" type="submit">Sign in</button>
      </form>`
    : "";
  const error = failed
    ? '<p id="sign-in-error" class="error" role="alert">Those credentials did not work. Check them and try again.</p>'
    : "";
  const divider =
    providers && local ? '<div class="divider"><span>or</span></div>' : "";
  const script = local
    ? `<script nonce="${nonce}">
      const toggle = document.getElementById("toggle-password");
      const password = document.getElementById("current-password");
      toggle?.addEventListener("click", () => {
        const reveal = password?.getAttribute("type") === "password";
        password?.setAttribute("type", reveal ? "text" : "password");
        toggle.textContent = reveal ? "Hide" : "Show";
        toggle.setAttribute("aria-pressed", String(reveal));
        password?.focus();
      });
    </script>`
    : "";
  return authPage({
    title: "Sign in to Catamorphic",
    nonce,
    content: `<section class="auth-panel" aria-labelledby="page-title">
      ${brandMark()}
      <header class="page-heading">
        <h1 id="page-title">Sign in to Catamorphic</h1>
        <p>Continue securely to your workspace.</p>
      </header>
      ${error}
      <div class="auth-methods">${providers}${divider}${local}</div>
      <p class="privacy-note">Your password stays with this server.</p>
    </section>${script}`,
  });
}

function consentPage(
  query: Record<string, string | undefined>,
  nonce: string,
): string {
  const code = escapeHtml(query.consent_code ?? "");
  const client = escapeHtml(query.client_id ?? "this client");
  const scopes = (query.scope ?? "basic identity")
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => `<li>${escapeHtml(scope.replaceAll("_", " "))}</li>`)
    .join("");
  return authPage({
    title: "Review access | Catamorphic",
    nonce,
    content: `<section class="auth-panel" aria-labelledby="page-title">
      ${brandMark()}
      <header class="page-heading">
        <h1 id="page-title">Allow this connection?</h1>
        <p>Review what the connecting app is asking to use.</p>
      </header>
      <div class="access-summary">
        <p class="summary-label">Connecting client</p>
        <code>${client}</code>
        <p class="summary-label">Requested access</p>
        <ul class="scope-list">${scopes}</ul>
      </div>
      <form class="consent-actions" action="/oauth/consent" method="post">
        <input type="hidden" name="consent_code" value="${code}">
        <button class="button button-secondary" name="accept" value="false">Deny</button>
        <button class="button button-primary" name="accept" value="true">Allow access</button>
      </form>
      <p class="privacy-note">You can remove access later from your server.</p>
    </section>`,
  });
}

function messagePage(title: string, message: string, nonce: string): string {
  return authPage({
    title: `${title} | Catamorphic`,
    nonce,
    content: `<section class="auth-panel" aria-labelledby="page-title">
      ${brandMark()}
      <header class="page-heading">
        <h1 id="page-title">${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
      </header>
    </section>`,
  });
}

function sendAuthPage(
  reply: FastifyReply,
  render: (nonce: string) => string,
): FastifyReply {
  const nonce = randomBytes(18).toString("base64url");
  return reply
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self' http: https:; base-uri 'none'; frame-ancestors 'none'`,
    )
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .type("text/html; charset=utf-8")
    .send(render(nonce));
}

function brandMark(): string {
  return `<div class="brand" aria-label="Catamorphic">
    <svg class="brand-mark" viewBox="0 0 64 64" role="img" aria-hidden="true">
      <path d="M46 15.5C42 12.6 37.2 11 32 11 20.4 11 11 20.4 11 32s9.4 21 21 21c5.2 0 10-1.6 14-4.5" />
      <path d="M24 14.5v35" />
    </svg>
    <span>Catamorphic</span>
  </div>`;
}

function authPage(options: {
  title: string;
  nonce: string;
  content: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0a0a0b">
  <title>${escapeHtml(options.title)}</title>
  <style nonce="${options.nonce}">
    :root {
      color-scheme: dark;
      --bg: #0a0a0b;
      --raised: #101012;
      --overlay: #16161a;
      --inset: #060607;
      --border: #232329;
      --border-strong: #33333b;
      --fg: #e6e6e9;
      --muted: #9a9aa3;
      --faint: #5c5c66;
      --accent: #f95225;
      --accent-fg: #1a0a05;
      --danger: #c46d6d;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--bg); }
    body {
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(circle at 50% -10%, rgb(249 82 37 / 8%), transparent 34rem),
        var(--bg);
      font-size: 13px;
      line-height: 1.5;
    }
    body::before {
      position: fixed;
      inset: 0;
      pointer-events: none;
      content: "";
      background-image: linear-gradient(rgb(255 255 255 / 1.5%) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 1.5%) 1px, transparent 1px);
      background-size: 32px 32px;
      mask-image: linear-gradient(to bottom, black, transparent 70%);
    }
    main {
      position: relative;
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
    }
    .auth-panel {
      width: min(100%, 388px);
      padding: 24px;
      border: 1px solid var(--border);
      border-top-color: color-mix(in srgb, var(--accent) 52%, var(--border));
      border-radius: 10px;
      background: color-mix(in srgb, var(--raised) 96%, transparent);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .brand-mark {
      width: 22px;
      height: 22px;
      padding: 3px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      fill: none;
      stroke: var(--accent);
      stroke-linecap: round;
      stroke-width: 5;
    }
    .page-heading { margin: 28px 0 24px; }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: -0.025em;
      line-height: 1.25;
    }
    .page-heading p {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .auth-methods, .local-form { display: grid; gap: 14px; }
    .auth-methods > form:not(.local-form) { display: grid; }
    .field-group { display: grid; gap: 6px; }
    label, .summary-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    input:not([type="hidden"]) {
      width: 100%;
      height: 38px;
      padding: 0 11px;
      border: 1px solid var(--border);
      border-radius: 6px;
      outline: none;
      background: var(--inset);
      color: var(--fg);
      font: inherit;
      transition: border-color 150ms cubic-bezier(.2,0,0,1), box-shadow 150ms cubic-bezier(.2,0,0,1);
    }
    input:hover { border-color: var(--border-strong); }
    input:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgb(249 82 37 / 15%);
    }
    .password-field { position: relative; }
    .password-field input { padding-right: 57px; }
    .password-toggle {
      position: absolute;
      top: 50%;
      right: 5px;
      height: 28px;
      translate: 0 -50%;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
    }
    .button {
      display: inline-grid;
      min-height: 38px;
      place-items: center;
      padding: 0 14px;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      transition: background-color 150ms cubic-bezier(.2,0,0,1), border-color 150ms cubic-bezier(.2,0,0,1), opacity 150ms cubic-bezier(.2,0,0,1);
    }
    .button-primary { background: var(--accent); color: var(--accent-fg); }
    .button-primary:hover { opacity: .9; }
    .button-secondary {
      border-color: var(--border);
      background: var(--overlay);
      color: var(--fg);
    }
    .button-secondary:hover { border-color: var(--border-strong); background: color-mix(in srgb, var(--overlay) 86%, var(--fg)); }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .error {
      margin: -8px 0 18px;
      padding: 9px 11px;
      border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
      border-radius: 6px;
      background: color-mix(in srgb, var(--danger) 8%, transparent);
      color: var(--danger);
      font-size: 12px;
    }
    .divider {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 10px;
      color: var(--faint);
      font-size: 11px;
    }
    .divider::before, .divider::after { height: 1px; background: var(--border); content: ""; }
    .privacy-note {
      margin: 20px 0 0;
      color: var(--faint);
      font-size: 11px;
      text-align: center;
    }
    .access-summary {
      display: grid;
      gap: 7px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--inset);
    }
    .access-summary code {
      overflow-wrap: anywhere;
      color: var(--fg);
      font: 12px/1.5 "SFMono-Regular", Consolas, monospace;
    }
    .summary-label { margin: 5px 0 0; }
    .summary-label:first-child { margin-top: 0; }
    .scope-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .scope-list li {
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--raised);
      color: var(--muted);
      font-size: 11px;
    }
    .consent-actions {
      display: grid;
      grid-template-columns: 1fr 1.4fr;
      gap: 8px;
      margin-top: 16px;
    }
    @media (max-width: 440px) {
      main { align-items: start; padding-inline: 12px; }
      .auth-panel { margin-top: 8vh; padding: 20px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <main>${options.content}</main>
</body>
</html>`;
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
