/**
 * Hetzner Cloud in memory, for the machines-hetzner recipe's tests: a
 * `fetch` that answers the calls the recipe makes, with a clock a test
 * moves. No request leaves the process.
 */

interface FakeServer {
  id: number;
  name: string;
  status: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
  /** When its current transition ends. */
  settlesAt: number;
}

interface FakeImage {
  id: number;
  type: string;
  status: string;
  description: string | null;
  labels: Record<string, string>;
  settlesAt: number;
}

const TRANSITION_MS = 20_000;

export class FakeHetznerCloud {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  readonly images: FakeImage[] = [];
  private servers: FakeServer[] = [];
  private nextId = 100;
  private clock = Date.parse("2026-01-01T00:00:00.000Z");
  /** Errors the next creates answer with, in order. */
  readonly createErrors: Array<{ status: number; code: string }> = [];

  constructor(private readonly token: string) {}

  now = (): number => this.clock;

  advance(ms: number): void {
    this.clock += ms;
    this.settle();
  }

  advanceTo(moment: string): void {
    this.advance(Math.max(0, Date.parse(moment) - this.clock));
  }

  /** Servers that exist, with what they were created with. */
  alive(): Array<{ id: number; name: string; status: string }> {
    return this.servers.map(({ id, name, status }) => ({ id, name, status }));
  }

  serverNamed(name: string): Record<string, unknown> | undefined {
    return this.servers.find((server) => server.name === name)?.body;
  }

  /** End a server as the cloud would. */
  kill(id: number): void {
    this.servers = this.servers.filter((server) => server.id !== id);
  }

  private settle(): void {
    for (const server of this.servers) {
      if (this.clock < server.settlesAt) continue;
      if (server.status === "initializing" || server.status === "starting")
        server.status = "running";
      else if (server.status === "stopping") server.status = "off";
    }
    this.servers = this.servers.filter(
      (server) =>
        !(server.status === "deleting" && this.clock >= server.settlesAt),
    );
    for (const image of this.images)
      if (image.status === "creating" && this.clock >= image.settlesAt)
        image.status = "available";
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${this.token}`)
      return error(401, "unauthorized");
    this.settle();
    const selector = url.searchParams.get("label_selector");
    const matches = (labels: Record<string, string>) =>
      !selector ||
      selector.split(",").every((part) => {
        const [key, value] = part.split("=");
        return key !== undefined && labels[key] === value;
      });
    if (method === "GET" && path === "/servers") {
      const name = url.searchParams.get("name");
      return json({
        servers: this.servers
          .filter(
            (server) =>
              (!name || server.name === name) && matches(server.labels),
          )
          .map(view),
        meta: { pagination: { next_page: null } },
      });
    }
    if (method === "GET" && path === "/images")
      return json({
        images: this.images
          .filter((image) => matches(image.labels))
          .map(({ settlesAt: _settlesAt, ...image }) => image),
        meta: { pagination: { next_page: null } },
      });
    if (method === "POST" && path === "/servers") {
      const failure = this.createErrors.shift();
      if (failure) return error(failure.status, failure.code);
      const request = fields(body);
      const name = typeof request.name === "string" ? request.name : "";
      if (this.servers.some((server) => server.name === name))
        return error(409, "uniqueness_error");
      this.nextId += 1;
      const server: FakeServer = {
        id: this.nextId,
        name,
        status: "initializing",
        labels: labelsOf(request.labels),
        body: request,
        settlesAt: this.clock + TRANSITION_MS,
      };
      this.servers.push(server);
      return json({ server: view(server) }, 201);
    }
    const match = /^\/servers\/(\d+)(?:\/actions\/(\w+))?$/.exec(path);
    const server = match
      ? this.servers.find((entry) => entry.id === Number(match[1]))
      : undefined;
    if (!match) return error(404, "not_found");
    if (!server) return error(404, "not_found");
    const transition = (status: string) => {
      server.status = status;
      server.settlesAt = this.clock + TRANSITION_MS;
      return json({
        action: {
          id: 1,
          command: status,
          status: "running",
          progress: 0,
          error: null,
        },
      });
    };
    if (method === "GET" && !match[2]) return json({ server: view(server) });
    if (method === "DELETE" && !match[2]) return transition("deleting");
    if (method === "POST" && match[2] === "shutdown")
      return transition("stopping");
    if (method === "POST" && match[2] === "poweron")
      return transition("starting");
    if (method === "POST" && match[2] === "create_image") {
      const request = fields(body);
      this.nextId += 1;
      const image: FakeImage = {
        id: this.nextId,
        type: "snapshot",
        status: "creating",
        description:
          typeof request.description === "string" ? request.description : null,
        labels: labelsOf(request.labels),
        settlesAt: this.clock + TRANSITION_MS,
      };
      this.images.push(image);
      return json({ image: { ...image }, action: { id: 2 } }, 201);
    }
    return error(404, "not_found");
  };
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function labelsOf(value: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(fields(value)))
    if (typeof label === "string") labels[key] = label;
  return labels;
}

function view(server: FakeServer) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    labels: server.labels,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code, message: code.replaceAll("_", " ") } }, status);
}
