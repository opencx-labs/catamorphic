interface SandboxNamespace {
  getByName(name: string): {
    fetch(
      request: Request,
      init?: Pick<RequestInit, "signal">,
    ): Promise<Response>;
  };
}

/** Authenticate before resolving a sandbox. Health never starts a container. */
export async function bridgeRequest({
  request,
  apiKey,
  sandboxes,
}: {
  request: Request;
  apiKey?: string;
  sandboxes: SandboxNamespace;
}): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return Response.json({ ok: true });
  if (apiKey && request.headers.get("Authorization") !== `Bearer ${apiKey}`)
    return Response.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  // A missing deployment secret must not expose remote command execution.
  if (!apiKey && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return Response.json(
      { error: "SANDBOX_API_KEY is not configured.", code: "not_configured" },
      { status: 503 },
    );
  if (request.method === "POST" && url.pathname === "/v1/sandbox")
    return Response.json({ id: crypto.randomUUID() }, { status: 201 });
  const route = /^\/v1\/sandbox\/([a-zA-Z0-9_-]{1,128})(?:\/|$)/.exec(
    url.pathname,
  );
  const id = route?.[1];
  if (!id)
    return Response.json(
      { error: "Sandbox route not found.", code: "not_found" },
      { status: 404 },
    );
  // enable_request_signal does not imply request_signal_passthrough.
  return sandboxes.getByName(id).fetch(request, { signal: request.signal });
}
