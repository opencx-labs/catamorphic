import { z } from "zod";

/** Hetzner Cloud's public API. */
export const HETZNER_CLOUD_API = "https://api.hetzner.cloud/v1";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HetznerCloudClientOptions {
  /** A project API token with read and write permission. */
  token: string;
  /** Default {@link HETZNER_CLOUD_API}. */
  baseUrl?: string;
  fetch?: Fetch;
  /** Retries of a call answered 429 or 5xx, or not answered (default 5). */
  maxRetries?: number;
  /** The longest one retry waits (default 30 seconds). */
  maxRetryDelayMs?: number;
  /** How often an action is polled (default 2 seconds). */
  actionPollMs?: number;
  /** Waits between attempts; tests pass one that does not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch; for deadlines and `RateLimit-Reset`. */
  now?: () => number;
}

/**
 * A call Hetzner Cloud answered with an error, or one that never got an
 * answer after every retry. `code` is Hetzner's error code
 * (`uniqueness_error`, `not_found`, `rate_limit_exceeded`, ...).
 */
export class HetznerCloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Hetzner Cloud: ${message} (${code})`);
    this.name = "HetznerCloudError";
  }
}

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const HetznerActionSchema = z.object({
  id: z.number(),
  command: z.string(),
  status: z.enum(["running", "success", "error"]),
  progress: z.number(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type HetznerAction = z.infer<typeof HetznerActionSchema>;

export const HetznerServerSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  labels: z.record(z.string(), z.string()),
});
export type HetznerServer = z.infer<typeof HetznerServerSchema>;

export const HetznerImageSchema = z.object({
  id: z.number(),
  type: z.string(),
  status: z.string(),
  description: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
});
export type HetznerImage = z.infer<typeof HetznerImageSchema>;

const Pagination = z.object({
  meta: z
    .object({
      pagination: z.object({ next_page: z.number().nullable() }),
    })
    .optional(),
});

/** Pages fetched at most when listing; 50 per page. */
const MAX_PAGES = 100;

/**
 * A small Hetzner Cloud API client: bearer authentication, retries with
 * bounded backoff on 429 and 5xx (honoring `RateLimit-Reset`), pagination,
 * and action polling with a deadline.
 */
export class HetznerCloudClient {
  private readonly baseUrl: string;
  private readonly doFetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: HetznerCloudClientOptions) {
    if (!options.token)
      throw new Error("A Hetzner Cloud API token is required");
    this.baseUrl = (options.baseUrl ?? HETZNER_CLOUD_API).replace(/\/+$/, "");
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One API call, retried while Hetzner is busy or unreachable. Resolves
   * with the parsed JSON body (null for an empty one).
   */
  async request(args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Readonly<Record<string, string | number | undefined>>;
    body?: unknown;
  }): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const maxRetries = this.options.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(url.toString(), {
          method: args.method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: "application/json",
            ...(args.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(args.body === undefined
            ? {}
            : { body: JSON.stringify(args.body) }),
        });
      } catch (error) {
        if (attempt >= maxRetries)
          throw new HetznerCloudError(
            0,
            "unreachable",
            `${args.method} ${args.path} got no answer: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }
      const parsed = ErrorBody.safeParse(
        await response.json().catch(() => undefined),
      );
      const code = parsed.success ? parsed.data.error.code : "http_error";
      const message = parsed.success
        ? parsed.data.error.message
        : `${args.method} ${args.path} answered ${response.status}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries)
        throw new HetznerCloudError(response.status, code, message);
      await this.sleep(this.retryDelay({ attempt, response }));
    }
  }

  /** Every item of a paginated list, following `meta.pagination`. */
  async list(args: {
    path: string;
    /** The response's array key: `servers`, `images`. */
    key: string;
    query?: Readonly<Record<string, string | number | undefined>>;
  }): Promise<unknown[]> {
    const items: unknown[] = [];
    let page: number | null = 1;
    for (let count = 0; page !== null && count < MAX_PAGES; count++) {
      const body = await this.request({
        method: "GET",
        path: args.path,
        query: { ...args.query, page, per_page: 50 },
      });
      const entries =
        typeof body === "object" && body !== null
          ? Reflect.get(body, args.key)
          : undefined;
      if (!Array.isArray(entries))
        throw new HetznerCloudError(
          200,
          "invalid_response",
          `GET ${args.path} returned no ${args.key}`,
        );
      items.push(...entries);
      page = Pagination.parse(body).meta?.pagination.next_page ?? null;
    }
    return items;
  }

  async servers(query: {
    name?: string;
    labelSelector?: string;
  }): Promise<HetznerServer[]> {
    return z.array(HetznerServerSchema).parse(
      await this.list({
        path: "/servers",
        key: "servers",
        query: { name: query.name, label_selector: query.labelSelector },
      }),
    );
  }

  /** The server with this id, or undefined once it is gone. */
  async server(args: { id: number }): Promise<HetznerServer | undefined> {
    try {
      const body = await this.request({
        method: "GET",
        path: `/servers/${args.id}`,
      });
      return z.object({ server: HetznerServerSchema }).parse(body).server;
    } catch (error) {
      if (error instanceof HetznerCloudError && error.code === "not_found")
        return undefined;
      throw error;
    }
  }

  async images(query: {
    type?: string;
    labelSelector?: string;
  }): Promise<HetznerImage[]> {
    return z.array(HetznerImageSchema).parse(
      await this.list({
        path: "/images",
        key: "images",
        query: { type: query.type, label_selector: query.labelSelector },
      }),
    );
  }

  /**
   * Wait until an action finishes. Throws the action's own error when it
   * failed, and a `timeout` error once `timeoutMs` passed.
   */
  async waitForAction(args: {
    id: number;
    timeoutMs: number;
  }): Promise<HetznerAction> {
    return this.poll({
      timeoutMs: args.timeoutMs,
      what: `Action ${args.id}`,
      check: async () => {
        const body = await this.request({
          method: "GET",
          path: `/actions/${args.id}`,
        });
        const { action } = z
          .object({ action: HetznerActionSchema })
          .parse(body);
        if (action.status === "error")
          throw new HetznerCloudError(
            200,
            action.error?.code ?? "action_failed",
            action.error?.message ?? `Action ${action.command} failed`,
          );
        return action.status === "success" ? action : undefined;
      },
    });
  }

  /**
   * Call `check` every `actionPollMs` until it returns a value. Throws a
   * `timeout` error naming `what` once `timeoutMs` passed.
   */
  async poll<T>(args: {
    timeoutMs: number;
    what: string;
    check: () => Promise<T | undefined>;
  }): Promise<T> {
    const deadline = this.now() + args.timeoutMs;
    for (;;) {
      const value = await args.check();
      if (value !== undefined) return value;
      if (this.now() >= deadline)
        throw new HetznerCloudError(
          0,
          "timeout",
          `${args.what} was still running after ${Math.round(args.timeoutMs / 1000)} seconds`,
        );
      await this.sleep(this.options.actionPollMs ?? 2_000);
    }
  }

  private backoff(attempt: number): number {
    const ceiling = this.options.maxRetryDelayMs ?? 30_000;
    return Math.min(ceiling, 500 * 2 ** attempt);
  }

  /** `RateLimit-Reset` (epoch seconds) when Hetzner sends one, bounded. */
  private retryDelay(args: { attempt: number; response: Response }): number {
    const ceiling = this.options.maxRetryDelayMs ?? 30_000;
    const reset = Number(args.response.headers.get("ratelimit-reset"));
    if (args.response.status === 429 && Number.isFinite(reset) && reset > 0)
      return Math.min(ceiling, Math.max(0, reset * 1_000 - this.now()));
    return this.backoff(args.attempt);
  }
}
