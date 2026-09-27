import crypto from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { hasProjectPermission, type Identity } from "../identity.js";
import {
  checkWebhookToken,
  matchWebhookHandshake,
  sameSecret,
  verifyWebhookRequest,
  WEBHOOK_DEFAULT_MAX_BYTES,
  WEBHOOK_MAX_BYTES_LIMIT,
  WEBHOOK_NAME_PATTERN,
  type WebhookCheck,
  type WebhookConfig,
  type WebhookHandshake,
  type WebhookRequest,
  webhookConfig,
  webhookSettingsKey,
} from "../webhook-ingress.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ProjectEventsService } from "./project-events-service.js";
import { requireTenantProject } from "./projects-service.js";

const tracer = getTracer("@catamorphic/core");

/** Headers senders use for a delivery's id: a redelivery is stored once. */
const DELIVERY_ID_HEADERS = [
  "webhook-id",
  "x-github-delivery",
  "x-shopify-webhook-id",
  "x-gitlab-event-uuid",
  "linear-delivery",
  "idempotency-key",
  "x-request-id",
];

/** Never stored or handed to a workflow. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

export class WebhookNotFoundError extends Error {
  constructor() {
    super("No workflow listens on this webhook");
    this.name = "WebhookNotFoundError";
  }
}

export class WebhookRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookRejectedError";
  }
}

export class WebhookTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Webhook bodies are limited to ${limit} bytes`);
    this.name = "WebhookTooLargeError";
  }
}

export class WebhookMethodNotAllowedError extends Error {
  constructor() {
    super("This webhook accepts POST requests and declared handshakes");
    this.name = "WebhookMethodNotAllowedError";
  }
}

/** What a request to a webhook URL became. */
export type WebhookReceipt =
  | { type: "event"; eventId: string; duplicate: boolean }
  /** A declared handshake: answer 200 with `answer`, store nothing. */
  | { type: "handshake"; answer: string };

export interface WebhookEndpoint {
  name: string;
  /** Path under the API base, e.g. `/hooks/<project>/<name>/<token>`. */
  path: string;
  /** Workflows bound to this name in the latest deployment or enabled. */
  workflows: string[];
  /** Whether an active enablement receives requests; otherwise they 404. */
  listening: boolean;
  /** Whether the listening workflows check a signature or token. */
  verified: boolean;
}

/**
 * Webhooks for project workflows (ADRs 0156, 0171). Each name a workflow
 * binds with `trigger("webhook", { name })` gets one public URL carrying an
 * unguessable token. A request is checked (token, size, then the declared
 * verification), answered synchronously when it is a declared handshake,
 * and otherwise stored as a durable Project Event and acknowledged; the
 * event dispatcher then runs every active workflow whose binding matches.
 */
export class WebhooksService {
  /** The host's body cap; endpoints may declare less, never more. */
  readonly maxBodyBytes: number;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      events: ProjectEventsService;
      /** A project secret's production value, for signature checks. */
      secretValue(input: {
        projectId: string;
        name: string;
      }): Promise<string | undefined>;
      /** Largest body any endpoint may accept. Defaults to 1 MiB. */
      maxBodyBytes?: number;
      now?: () => Date;
    },
  ) {
    this.maxBodyBytes = Math.min(
      deps.maxBodyBytes ?? WEBHOOK_DEFAULT_MAX_BYTES,
      WEBHOOK_MAX_BYTES_LIMIT,
    );
  }

  async receive(input: {
    projectId: string;
    name: string;
    token: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string>;
    body: Buffer;
  }): Promise<WebhookReceipt> {
    return withSpan(
      {
        tracer,
        name: "webhook.receive",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.webhook.name": input.name,
          "http.request.method": input.method,
        },
      },
      async (span) => {
        const endpoint = await this.db
          .selectFrom("webhook_endpoints")
          .select("token")
          .where("project_id", "=", input.projectId)
          .where("name", "=", input.name)
          .executeTakeFirst();
        if (!endpoint || !sameSecret(endpoint.token, input.token)) {
          throw new WebhookNotFoundError();
        }
        const config = await this.activeConfig(input.projectId, input.name);
        const limit = Math.min(
          config.maxBodyBytes ?? WEBHOOK_DEFAULT_MAX_BYTES,
          this.maxBodyBytes,
        );
        if (input.body.byteLength > limit)
          throw new WebhookTooLargeError(limit);
        const request: WebhookRequest = {
          method: input.method.toUpperCase(),
          headers: normalizeHeaders(input.headers),
          query: input.query,
          body: input.body,
        };
        const contentType = request.headers["content-type"] ?? null;
        const body = parseBody(input.body, contentType);
        const handshake = matchWebhookHandshake({
          rules: config.respond ?? [],
          request,
          body,
        });
        if (handshake) {
          await this.check({
            projectId: input.projectId,
            config,
            request,
            token: handshake.rule.token,
          });
          span.setAttribute("catamorphic.webhook.handshake", true);
          return { type: "handshake", answer: handshake.answer };
        }
        if (request.method !== "POST") throw new WebhookMethodNotAllowedError();
        await this.check({ projectId: input.projectId, config, request });
        const deliveryId = DELIVERY_ID_HEADERS.map(
          (name) => request.headers[name],
        ).find((value) => value && value.length <= 200);
        // A shared-secret token is a credential: it never reaches a run.
        const verify = config.verify;
        const tokenHeader =
          verify?.scheme === "token" ? verify.header?.toLowerCase() : undefined;
        const tokenQuery =
          verify?.scheme === "token" ? verify.query : undefined;
        const { event, created } = await this.deps.events.append({
          projectId: input.projectId,
          source: "webhook",
          kind: "webhook",
          externalId: `${input.name}:${deliveryId ?? crypto.randomUUID()}`,
          occurredAt: new Date().toISOString(),
          payload: {
            name: input.name,
            headers: Object.fromEntries(
              Object.entries(request.headers).filter(
                ([name]) => !DROPPED_HEADERS.has(name) && name !== tokenHeader,
              ),
            ),
            query: Object.fromEntries(
              Object.entries(request.query).filter(
                ([name]) => name !== tokenQuery,
              ),
            ),
            contentType,
            body,
          } satisfies JsonObject,
        });
        return { type: "event", eventId: event.id, duplicate: !created };
      },
    );
  }

  /**
   * The project's webhooks: every name the latest deployment binds or an
   * active enablement listens on, with its URL path. Needs `webhooks:read`:
   * the URL is the sender's credential.
   */
  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<WebhookEndpoint[]> {
    if (!hasProjectPermission(input.identity, input.projectId, "webhooks:read"))
      throw new AccessDeniedError();
    const latest = await this.db
      .selectFrom("trigger_definition_scans")
      .select("commit_sha")
      .where("project_id", "=", input.projectId)
      .orderBy("scanned_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const bindings = await this.db
      .selectFrom("trigger_definitions as definition")
      .leftJoin(
        "workflow_enablement_triggers as binding",
        "binding.trigger_definition_id",
        "definition.id",
      )
      .leftJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "binding.enablement_id",
      )
      .select([
        sql<string | null>`definition.config->>'name'`.as("name"),
        "definition.workflow_name as workflowName",
        "definition.commit_sha as commitSha",
        "definition.config as config",
        sql<boolean>`coalesce(binding.status = 'active' and enablement.status = 'active', false)`.as(
          "active",
        ),
      ])
      .where("definition.project_id", "=", input.projectId)
      .where("definition.trigger_kind", "=", "webhook")
      .execute();
    const byName = new Map<string, WebhookEndpoint>();
    for (const binding of bindings) {
      if (!binding.name) continue;
      if (!binding.active && binding.commitSha !== latest?.commit_sha) continue;
      const entry = byName.get(binding.name) ?? {
        name: binding.name,
        path: "",
        workflows: [],
        listening: false,
        verified: false,
      };
      if (!entry.workflows.includes(binding.workflowName))
        entry.workflows.push(binding.workflowName);
      if (binding.active) {
        entry.listening = true;
        entry.verified ||= Boolean(parseConfig(binding.config)?.verify);
      }
      byName.set(binding.name, entry);
    }
    const endpoints = [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const endpoint of endpoints) {
      endpoint.workflows.sort();
      const token = await this.ensureToken(input.projectId, endpoint.name);
      endpoint.path = `/hooks/${input.projectId}/${endpoint.name}/${token}`;
    }
    return endpoints;
  }

  /**
   * The URL path of a webhook name, whether or not a workflow binds it yet,
   * so a sender can be registered before its trigger library lands (ADR
   * 0177). Requests reach no workflow until one listens on the name.
   */
  async endpointPath(input: {
    identity: Identity;
    projectId: string;
    name: string;
  }): Promise<string> {
    if (!hasProjectPermission(input.identity, input.projectId, "webhooks:read"))
      throw new AccessDeniedError();
    if (!WEBHOOK_NAME_PATTERN.test(input.name))
      throw new Error(`Invalid webhook name '${input.name}'`);
    await requireTenantProject(
      this.db,
      input.identity.tenantId,
      input.projectId,
    );
    const token = await this.ensureToken(input.projectId, input.name);
    return `/hooks/${input.projectId}/${input.name}/${token}`;
  }

  /** Replace a webhook's token; senders need the new URL. */
  async rotate(input: {
    identity: Identity;
    projectId: string;
    name: string;
  }): Promise<WebhookEndpoint> {
    if (
      !hasProjectPermission(input.identity, input.projectId, "webhooks:write")
    )
      throw new AccessDeniedError();
    await this.db
      .updateTable("webhook_endpoints")
      .set({ token: newToken() })
      .where("project_id", "=", input.projectId)
      .where("name", "=", input.name)
      .execute();
    const endpoint = (await this.list(input)).find(
      (candidate) => candidate.name === input.name,
    );
    if (!endpoint) throw new WebhookNotFoundError();
    return endpoint;
  }

  private async ensureToken(projectId: string, name: string): Promise<string> {
    const inserted = await this.db
      .insertInto("webhook_endpoints")
      .values({ project_id: projectId, name, token: newToken() })
      .onConflict((conflict) =>
        conflict.columns(["project_id", "name"]).doNothing(),
      )
      .returning("token")
      .executeTakeFirst();
    if (inserted) return inserted.token;
    const existing = await this.db
      .selectFrom("webhook_endpoints")
      .select("token")
      .where("project_id", "=", projectId)
      .where("name", "=", name)
      .executeTakeFirstOrThrow();
    return existing.token;
  }

  /**
   * The settings every active binding of the name declares. No binding
   * means nobody listens; bindings that disagree fail closed.
   */
  private async activeConfig(
    projectId: string,
    name: string,
  ): Promise<WebhookConfig> {
    const rows = await this.db
      .selectFrom("trigger_definitions as definition")
      .innerJoin(
        "workflow_enablement_triggers as binding",
        "binding.trigger_definition_id",
        "definition.id",
      )
      .innerJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "binding.enablement_id",
      )
      .select("definition.config as config")
      .where("definition.project_id", "=", projectId)
      .where("definition.trigger_kind", "=", "webhook")
      .where(sql<boolean>`definition.config->>'name' = ${name}`)
      .where("binding.status", "=", "active")
      .where("enablement.status", "=", "active")
      .execute();
    if (rows.length === 0) throw new WebhookNotFoundError();
    const configs = rows.map((row) => parseConfig(row.config));
    const [first] = configs;
    if (!first || configs.some((config) => !config))
      throw new WebhookRejectedError("This webhook's settings are invalid");
    const key = webhookSettingsKey(first);
    if (configs.some((config) => config && webhookSettingsKey(config) !== key))
      throw new WebhookRejectedError(
        "Workflows on this webhook declare different settings",
      );
    return first;
  }

  /**
   * Runs a handshake's own token check, or else the endpoint's declared
   * verification; an endpoint without one only has its URL token.
   */
  private async check(input: {
    projectId: string;
    config: WebhookConfig;
    request: WebhookRequest;
    /** A handshake rule's own token check, replacing `verify`. */
    token?: WebhookHandshake["token"];
  }): Promise<void> {
    const { token, request } = input;
    const verify = input.config.verify;
    const secretName = token ? token.secret : verify?.secret;
    if (!secretName) return;
    const secret = await this.deps.secretValue({
      projectId: input.projectId,
      name: secretName,
    });
    if (!secret)
      throw new WebhookRejectedError(
        `The webhook secret ${secretName} is not set`,
      );
    const result: WebhookCheck = token
      ? checkWebhookToken({ check: token, request, secret })
      : verify
        ? verifyWebhookRequest({
            verify,
            request,
            secret,
            now: this.deps.now?.() ?? new Date(),
          })
        : { ok: true };
    if (!result.ok) throw new WebhookRejectedError(result.reason);
  }
}

function parseConfig(config: Json): WebhookConfig | undefined {
  const parsed = webhookConfig.safeParse(config);
  return parsed.success ? parsed.data : undefined;
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return normalized;
}

function parseBody(body: Buffer, contentType: string | null): Json {
  const text = body.toString("utf8");
  if (contentType?.includes("json")) {
    try {
      const parsed: Json = JSON.parse(text);
      return parsed;
    } catch {
      // Not valid JSON after all; the workflow still gets the text.
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
