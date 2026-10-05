/**
 * An in-process fake of the Hetzner Cloud API endpoints Work uses, with
 * Hetzner's documented shapes: bearer authentication, `{ error: { code,
 * message } }` bodies, paginated lists with `meta.pagination`, label
 * selectors, and actions that finish after being polled. Tests pass its
 * `fetch` to the client; nothing reaches the network.
 */

interface FakeServer {
  id: number;
  name: string;
  status: "initializing" | "running" | "deleting";
  labels: Record<string, string>;
  server_type: string;
  location: string;
  image: string;
  user_data: string;
  ssh_keys: unknown[];
  firewalls: unknown[];
  networks: unknown[];
  created: string;
}

interface FakeImage {
  id: number;
  type: "snapshot";
  status: "creating" | "available";
  description: string;
  labels: Record<string, string>;
  created_from: { id: number; name: string };
}

interface FakeAction {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  error: { code: string; message: string } | null;
  resources: Array<{ id: number; type: "server" | "image" }>;
  /** Polls left before it finishes. */
  remaining: number;
  finish: () => void;
}

/** A failure the fake answers instead of the next matching call. */
export interface FakeFailure {
  method?: "GET" | "POST" | "DELETE";
  /** A path prefix such as `/servers` or `/actions/`. */
  path?: string;
  status: number;
  code: string;
  message?: string;
  headers?: Record<string, string>;
  /** How many calls it answers (default 1). */
  times?: number;
  /** Throw as a network error instead of answering. */
  network?: boolean;
}

export class FakeHetznerCloud {
  readonly servers = new Map<number, FakeServer>();
  readonly images = new Map<number, FakeImage>();
  readonly actions = new Map<number, FakeAction>();
  /** Every call the fake received, in order. */
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  private nextId = 1000;
  private readonly failures: FakeFailure[] = [];
  private failAction: string | undefined;

  constructor(
    private readonly options: {
      token: string;
      /** GETs of an action that still say `running` (default 1). */
      actionPolls?: number;
      /** A failed action for this command, once (`create_image`). */
      failAction?: string;
    },
  ) {
    this.failAction = options.failAction;
  }

  /** Answer the next matching call(s) with this failure. */
  fail(failure: FakeFailure): void {
    this.failures.push({ times: 1, ...failure });
  }

  /** Servers whose name is `name`, any status. */
  serverNamed(name: string): FakeServer | undefined {
    return [...this.servers.values()].find((server) => server.name === name);
  }

  /** A `fetch` serving the fake, for `HetznerCloudClient`'s `fetch` option. */
  readonly fetch = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({
      method,
      path: `${path}${url.search}`,
      ...(body === undefined ? {} : { body }),
    });
    const failure = this.failures.find(
      (candidate) =>
        (!candidate.method || candidate.method === method) &&
        (!candidate.path || path.startsWith(candidate.path)),
    );
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.times <= 0)
        this.failures.splice(this.failures.indexOf(failure), 1);
      if (failure.network) throw new TypeError("fetch failed");
      return errorResponse(
        failure.status,
        failure.code,
        failure.message ?? failure.code,
        failure.headers,
      );
    }
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== `Bearer ${this.options.token}`)
      return errorResponse(401, "unauthorized", "unable to authenticate");
    return this.route({ method, path, query: url.searchParams, body });
  };

  private route(request: {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
  }): Response {
    const { method, path, query, body } = request;
    if (method === "GET" && path === "/servers") {
      const name = query.get("name");
      const selector = query.get("label_selector");
      return page(
        "servers",
        [...this.servers.values()]
          .filter((server) => !name || server.name === name)
          .filter((server) => matches(server.labels, selector))
          .map(serverJson),
        query,
      );
    }
    if (method === "POST" && path === "/servers")
      return this.createServer(body);
    const serverMatch = path.match(/^\/servers\/(\d+)$/);
    if (serverMatch) {
      const id = Number(serverMatch[1]);
      const server = this.servers.get(id);
      if (!server)
        return errorResponse(
          404,
          "not_found",
          `server with ID '${id}' not found`,
        );
      if (method === "GET") return json(200, { server: serverJson(server) });
      if (method === "DELETE") {
        server.status = "deleting";
        const action = this.action({
          command: "delete_server",
          resources: [{ id, type: "server" }],
          finish: () => this.servers.delete(id),
        });
        return json(200, { action: actionJson(action) });
      }
    }
    const imageMatch = path.match(/^\/servers\/(\d+)\/actions\/create_image$/);
    if (imageMatch && method === "POST") {
      const id = Number(imageMatch[1]);
      const server = this.servers.get(id);
      if (!server)
        return errorResponse(
          404,
          "not_found",
          `server with ID '${id}' not found`,
        );
      const input = isRecord(body) ? body : {};
      const image: FakeImage = {
        id: this.nextId++,
        type: "snapshot",
        status: "creating",
        description:
          typeof input.description === "string" ? input.description : "",
        labels: stringRecord(input.labels),
        created_from: { id: server.id, name: server.name },
      };
      this.images.set(image.id, image);
      const action = this.action({
        command: "create_image",
        resources: [
          { id, type: "server" },
          { id: image.id, type: "image" },
        ],
        finish: () => {
          image.status = "available";
        },
      });
      return json(201, {
        image: imageJson(image),
        action: actionJson(action),
      });
    }
    if (method === "GET" && path === "/images") {
      const type = query.get("type");
      const selector = query.get("label_selector");
      return page(
        "images",
        [...this.images.values()]
          .filter((image) => !type || image.type === type)
          .filter((image) => matches(image.labels, selector))
          .map(imageJson),
        query,
      );
    }
    const actionMatch = path.match(/^\/actions\/(\d+)$/);
    if (actionMatch && method === "GET") {
      const action = this.actions.get(Number(actionMatch[1]));
      if (!action)
        return errorResponse(
          404,
          "not_found",
          `action with ID '${actionMatch[1]}' not found`,
        );
      if (action.status === "running") {
        if (action.remaining <= 0) {
          if (this.failAction === action.command) {
            action.status = "error";
            action.error = {
              code: "action_failed",
              message: `${action.command} failed`,
            };
            this.failAction = undefined;
          } else {
            action.status = "success";
            action.progress = 100;
            action.finish();
          }
        } else action.remaining -= 1;
      }
      return json(200, { action: actionJson(action) });
    }
    return errorResponse(404, "not_found", `${method} ${path} not found`);
  }

  private createServer(body: unknown): Response {
    if (!isRecord(body))
      return errorResponse(400, "json_error", "invalid JSON");
    const { name, server_type, image, location } = body;
    if (
      typeof name !== "string" ||
      typeof server_type !== "string" ||
      typeof image !== "string"
    )
      return errorResponse(
        400,
        "invalid_input",
        "invalid input in fields 'name', 'server_type', 'image'",
      );
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/.test(name))
      return errorResponse(
        400,
        "invalid_input",
        "invalid input in field 'name'",
      );
    if (this.serverNamed(name))
      return errorResponse(
        409,
        "uniqueness_error",
        "server name is already used",
      );
    const userData = typeof body.user_data === "string" ? body.user_data : "";
    if (Buffer.byteLength(userData) > 32 * 1024)
      return errorResponse(
        400,
        "invalid_input",
        "invalid input in field 'user_data'",
      );
    const server: FakeServer = {
      id: this.nextId++,
      name,
      status: "initializing",
      labels: stringRecord(body.labels),
      server_type,
      location: typeof location === "string" ? location : "fsn1",
      image,
      user_data: userData,
      ssh_keys: Array.isArray(body.ssh_keys) ? body.ssh_keys : [],
      firewalls: Array.isArray(body.firewalls) ? body.firewalls : [],
      networks: Array.isArray(body.networks) ? body.networks : [],
      created: new Date().toISOString(),
    };
    this.servers.set(server.id, server);
    const action = this.action({
      command: "create_server",
      resources: [{ id: server.id, type: "server" }],
      finish: () => {
        server.status = "running";
      },
    });
    return json(201, {
      server: serverJson(server),
      action: actionJson(action),
      next_actions: [],
      root_password: null,
    });
  }

  private action(args: {
    command: string;
    resources: FakeAction["resources"];
    finish: () => void;
  }): FakeAction {
    const action: FakeAction = {
      id: this.nextId++,
      command: args.command,
      status: "running",
      progress: 0,
      error: null,
      resources: args.resources,
      remaining: this.options.actionPolls ?? 1,
      finish: args.finish,
    };
    this.actions.set(action.id, action);
    return action;
  }
}

function serverJson(server: FakeServer) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    labels: server.labels,
    created: server.created,
    server_type: { name: server.server_type },
    datacenter: { location: { name: server.location } },
    image: { name: server.image },
    public_net: {},
    private_net: [],
  };
}

function imageJson(image: FakeImage) {
  return {
    id: image.id,
    type: image.type,
    status: image.status,
    description: image.description,
    labels: image.labels,
    created_from: image.created_from,
  };
}

function actionJson(action: FakeAction) {
  return {
    id: action.id,
    command: action.command,
    status: action.status,
    progress: action.progress,
    started: new Date().toISOString(),
    finished: action.status === "running" ? null : new Date().toISOString(),
    resources: action.resources,
    error: action.error,
  };
}

/** One page of a list, as Hetzner paginates (`per_page` at most 50). */
function page(key: string, items: unknown[], query: URLSearchParams): Response {
  const perPage = Math.min(50, Number(query.get("per_page") ?? 25));
  const current = Math.max(1, Number(query.get("page") ?? 1));
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  return json(200, {
    [key]: items.slice((current - 1) * perPage, current * perPage),
    meta: {
      pagination: {
        page: current,
        per_page: perPage,
        previous_page: current > 1 ? current - 1 : null,
        next_page: current < lastPage ? current + 1 : null,
        last_page: lastPage,
        total_entries: items.length,
      },
    },
  });
}

/** Hetzner label selectors: `k=v`, `k!=v`, `k`, `!k`, comma-separated. */
function matches(
  labels: Record<string, string>,
  selector: string | null,
): boolean {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const expression = term.trim();
    const unequal = expression.match(/^([^!=]+)!=(.*)$/);
    if (unequal?.[1]) return labels[unequal[1]] !== unequal[2];
    const equal = expression.match(/^([^!=]+)==?(.*)$/);
    if (equal?.[1]) return labels[equal[1]] === equal[2];
    if (expression.startsWith("!")) return !(expression.slice(1) in labels);
    return expression in labels;
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message, details: {} } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
