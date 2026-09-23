import crypto from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { type Identity, isBuilder } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ProjectEventsService } from "./project-events-service.js";

const tracer = getTracer("@catamorphic/core");

/** Largest request body a webhook accepts. */
export const WEBHOOK_MAX_BYTES = 1024 * 1024;

/** Headers senders use for a delivery's id: a redelivery is stored once. */
const DELIVERY_ID_HEADERS = [
  "webhook-id",
  "x-github-delivery",
  "x-shopify-webhook-id",
  "x-gitlab-event-uuid",
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

interface VerifyConfig {
  secret: string;
  header: string;
  prefix?: string;
  encoding?: "hex" | "base64";
}

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

export interface WebhookEndpoint {
  name: string;
  /** Path under the API base, e.g. `/hooks/<project>/<name>/<token>`. */
  path: string;
  /** Workflows bound to this name in the latest deployment or enabled. */
  workflows: string[];
  /** Whether an active enablement receives requests; otherwise they 404. */
  listening: boolean;
  /** Whether the listening workflows check a signature. */
  verified: boolean;
}

/**
 * Webhooks for project workflows (ADR 0156). Each name a workflow binds
 * with `trigger("webhook", { name })` gets one public URL carrying an
 * unguessable token. A request is checked (token, then the declared HMAC),
 * stored as a durable Project Event, and acknowledged; the event dispatcher
 * then runs every active workflow bound to the name.
 */
export class WebhooksService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      events: ProjectEventsService;
      /** A project secret's production value, for signature checks. */
      secretValue(input: {
        projectId: string;
        name: string;
      }): Promise<string | undefined>;
    },
  ) {}

  async ingest(input: {
    projectId: string;
    name: string;
    token: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }): Promise<{ eventId: string; duplicate: boolean }> {
    return withSpan(
      {
        tracer,
        name: "webhook.ingest",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.webhook.name": input.name,
        },
      },
      async () => {
        const endpoint = await this.db
          .selectFrom("webhook_endpoints")
          .select("token")
          .where("project_id", "=", input.projectId)
          .where("name", "=", input.name)
          .executeTakeFirst();
        if (!endpoint || !sameSecret(endpoint.token, input.token)) {
          throw new WebhookNotFoundError();
        }
        const verify = await this.activeVerification(
          input.projectId,
          input.name,
        );
        const headers = normalizeHeaders(input.headers);
        if (verify) {
          await this.checkSignature(input.projectId, verify, headers, input);
        }
        const contentType = headers["content-type"] ?? null;
        const deliveryId = DELIVERY_ID_HEADERS.map(
          (name) => headers[name],
        ).find((value) => value && value.length <= 200);
        const { event, created } = await this.deps.events.append({
          projectId: input.projectId,
          source: "webhook",
          kind: "webhook",
          externalId: `${input.name}:${deliveryId ?? crypto.randomUUID()}`,
          occurredAt: new Date().toISOString(),
          payload: {
            name: input.name,
            headers: Object.fromEntries(
              Object.entries(headers).filter(
                ([name]) => !DROPPED_HEADERS.has(name),
              ),
            ),
            contentType,
            body: parseBody(input.body, contentType),
          } satisfies JsonObject,
        });
        return { eventId: event.id, duplicate: !created };
      },
    );
  }

  /**
   * The project's webhooks: every name the latest deployment binds or an
   * active enablement listens on, with its URL path. Builders only; the URL
   * is the sender's credential.
   */
  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<WebhookEndpoint[]> {
    if (!isBuilder(input.identity, input.projectId))
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
        entry.verified ||= Boolean(verifyOf(binding.config));
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

  /** Replace a webhook's token; senders need the new URL. */
  async rotate(input: {
    identity: Identity;
    projectId: string;
    name: string;
  }): Promise<WebhookEndpoint> {
    if (!isBuilder(input.identity, input.projectId))
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
   * The signature check every active binding of the name declares. No
   * binding means nobody listens; bindings that disagree fail closed.
   */
  private async activeVerification(
    projectId: string,
    name: string,
  ): Promise<VerifyConfig | undefined> {
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
    const checks = new Set(
      rows.map((row) => JSON.stringify(verifyOf(row.config) ?? null)),
    );
    if (checks.size > 1)
      throw new WebhookRejectedError(
        "Workflows on this webhook declare different signature checks",
      );
    return verifyOf(rows[0]?.config ?? null);
  }

  private async checkSignature(
    projectId: string,
    verify: VerifyConfig,
    headers: Record<string, string>,
    input: { body: Buffer },
  ): Promise<void> {
    const key = await this.deps.secretValue({
      projectId,
      name: verify.secret,
    });
    if (!key)
      throw new WebhookRejectedError(
        `The signing secret ${verify.secret} is not set`,
      );
    const received = headers[verify.header.toLowerCase()];
    const prefix = verify.prefix ?? "";
    if (!received?.startsWith(prefix))
      throw new WebhookRejectedError("Missing or malformed signature");
    const expected = crypto
      .createHmac("sha256", key)
      .update(input.body)
      .digest(verify.encoding ?? "hex");
    if (!sameSecret(expected, received.slice(prefix.length)))
      throw new WebhookRejectedError("Signature does not match");
  }
}

function verifyOf(config: Json): VerifyConfig | undefined {
  if (!isJsonObject(config)) return undefined;
  const verify = config.verify;
  if (
    !isJsonObject(verify) ||
    typeof verify.secret !== "string" ||
    typeof verify.header !== "string"
  )
    return undefined;
  return {
    secret: verify.secret,
    header: verify.header,
    ...(typeof verify.prefix === "string" ? { prefix: verify.prefix } : {}),
    ...(verify.encoding === "base64" || verify.encoding === "hex"
      ? { encoding: verify.encoding }
      : {}),
  };
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function sameSecret(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}
