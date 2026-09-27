import crypto from "node:crypto";
import {
  matchesWhere,
  webhookSettingsIssues,
  webhookSettingsKey,
} from "@catamorphic/parser";
import { z } from "zod";

/**
 * Declarative webhook ingress (ADR 0171): how one project webhook endpoint
 * checks a request and answers a sender's handshake. Every scheme is a pure
 * function of the request, the project secret and the clock, so GitHub,
 * Slack, Stripe, Shopify, GitLab, Linear and Standard Webhooks senders are
 * configurations of the one `webhook` trigger kind, not host code.
 */

/** A webhook's name: its URL segment and what workflows subscribe to. */
export const WEBHOOK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Body cap for an endpoint that declares none. */
export const WEBHOOK_DEFAULT_MAX_BYTES = 1024 * 1024;

/** Largest body cap an endpoint may declare; hosts may set a lower maximum. */
export const WEBHOOK_MAX_BYTES_LIMIT = 64 * 1024 * 1024;

/** Longest signature or timestamp header an endpoint reads. */
export const WEBHOOK_MAX_SIGNATURE_HEADER = 4096;

/** Shortest HMAC key accepted: a shorter one is guessable. */
export const WEBHOOK_MIN_KEY_BYTES = 16;

const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "Use the project secret's name");
const headerName = z.string().min(1).max(100);
const queryName = z.string().min(1).max(100);
/** Text that separates the parts of a composite header, e.g. "," or " ". */
const separator = z.string().min(1).max(5);

/**
 * An HMAC over a signed-content template. The signature header may carry a
 * prefix (`sha256=`), or several parts split by a `separator` of which those
 * starting with `prefix` are signatures (Stripe's `t=…,v1=…`, Standard
 * Webhooks' `v1,… v1,…`). Headers are read by plain splitting, never by a
 * project-authored regular expression, so reading one is linear in its
 * length. `content` builds the signed bytes from `{body}`, `{timestamp}` and
 * `{header:<name>}` (default `{body}`); `timestamp` rejects deliveries
 * outside a tolerance window and must be signed.
 */
export const webhookHmacVerify = z.strictObject({
  scheme: z.literal("hmac"),
  /** The project secret holding the signing key. */
  secret: secretName,
  algorithm: z.enum(["sha1", "sha256", "sha512"]).optional(),
  /** The header carrying the signature. */
  header: headerName,
  /** Text before the signature, e.g. "sha256=" or "v0=". */
  prefix: z.string().max(40).optional(),
  encoding: z.enum(["hex", "base64"]).optional(),
  /** Splits a composite header into parts; signatures start with `prefix`. */
  separator: separator.optional(),
  /** The signed bytes: `{body}`, `{timestamp}`, `{header:<name>}`. */
  content: z.string().min(1).max(500).optional(),
  timestamp: z
    .strictObject({
      header: headerName,
      /** Text before the Unix seconds, e.g. "t=". */
      prefix: z.string().max(40).optional(),
      /** Splits a composite header; the first part with `prefix` wins. */
      separator: separator.optional(),
      /** Seconds a delivery may be early or late. Defaults to 300. */
      toleranceSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .optional(),
  /** How the secret's value encodes the key. Defaults to utf8. */
  secretEncoding: z.enum(["utf8", "base64"]).optional(),
  /** Text removed from the secret's value before decoding, e.g. "whsec_". */
  secretPrefix: z.string().max(40).optional(),
});

/** A shared secret the sender repeats in a header or query parameter. */
export const webhookTokenVerify = z.strictObject({
  scheme: z.literal("token"),
  secret: secretName,
  header: headerName.optional(),
  query: queryName.optional(),
  /** Text before the token, e.g. "Bearer ". */
  prefix: z.string().max(40).optional(),
});

const tokenCheck = z.strictObject({
  secret: secretName,
  header: headerName.optional(),
  query: queryName.optional(),
});

/**
 * A synchronous answer to a sender's handshake, checked in order before a
 * request becomes an event. `when` is a filter over `{ method, headers,
 * query, body }`; `echo` names the value to answer with (`body.challenge`,
 * `query.hub.challenge`). A rule with its own `token` check replaces the
 * endpoint's `verify` for the requests it matches (GET subscriptions carry
 * no signature); every other rule answers only verified requests.
 */
export const webhookHandshake = z.strictObject({
  when: z.record(z.string(), z.json()),
  echo: z
    .string()
    .regex(
      /^(body|query|headers)\.[^\s]+$/,
      "Name a value under body, query or headers",
    ),
  token: tokenCheck.optional(),
});

/** Everything a `trigger("webhook", …)` binding configures. */
export const webhookConfig = z
  .strictObject({
    name: z
      .string()
      .regex(WEBHOOK_NAME_PATTERN, "Use lowercase letters, digits and dashes"),
    verify: z
      .discriminatedUnion("scheme", [webhookHmacVerify, webhookTokenVerify])
      .optional(),
    respond: z.array(webhookHandshake).max(10).optional(),
    /**
     * Where the sender's own id for an event is, for senders that repeat it
     * in the body rather than a delivery header (Slack's `body.event_id`,
     * Stripe's `body.id`): a retried event is stored and run once.
     */
    deliveryId: z
      .string()
      .regex(
        /^(body|query|headers)\.[^\s]+$/,
        "Name a value under body, query or headers",
      )
      .optional(),
    /** Largest body accepted, up to the host's maximum. Defaults to 1 MiB. */
    maxBodyBytes: z
      .number()
      .int()
      .positive()
      .max(WEBHOOK_MAX_BYTES_LIMIT)
      .optional(),
  })
  .superRefine((config, context) => {
    for (const issue of webhookSettingsIssues(config))
      context.addIssue({ code: "custom", ...issue });
  });

export type WebhookConfig = z.output<typeof webhookConfig>;
export type WebhookVerify = NonNullable<WebhookConfig["verify"]>;
export type WebhookHandshake = z.output<typeof webhookHandshake>;

/** A request as the endpoint received it: exact bytes, lowercase headers. */
export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: Buffer;
}

export type WebhookCheck = { ok: true } | { ok: false; reason: string };

/** Checks a request against the endpoint's scheme with the secret's value. */
export function verifyWebhookRequest(input: {
  verify: WebhookVerify;
  request: WebhookRequest;
  secret: string;
  now: Date;
}): WebhookCheck {
  const { verify, request } = input;
  if (verify.scheme === "token")
    return checkWebhookToken({ check: verify, request, secret: input.secret });
  const received = request.headers[verify.header.toLowerCase()];
  if (!received) return { ok: false, reason: "Missing signature" };
  if (received.length > WEBHOOK_MAX_SIGNATURE_HEADER)
    return { ok: false, reason: "Signature header too long" };
  const source = verify.timestamp;
  let timestamp = "";
  if (source) {
    const raw = request.headers[source.header.toLowerCase()] ?? "";
    if (raw.length > WEBHOOK_MAX_SIGNATURE_HEADER)
      return { ok: false, reason: "Timestamp header too long" };
    timestamp =
      headerParts({ value: raw, ...source }).find((part) => part !== "") ?? "";
    if (!/^\d{1,12}$/.test(timestamp))
      return { ok: false, reason: "Missing timestamp" };
    if (
      Math.abs(input.now.getTime() / 1000 - Number(timestamp)) >
      (source.toleranceSeconds ?? 300)
    )
      return { ok: false, reason: "Timestamp outside the tolerance window" };
  }
  const content = signedContent({
    template: verify.content ?? "{body}",
    request,
    timestamp,
  });
  const secret =
    verify.secretPrefix && input.secret.startsWith(verify.secretPrefix)
      ? input.secret.slice(verify.secretPrefix.length)
      : input.secret;
  const key =
    verify.secretEncoding === "base64"
      ? Buffer.from(secret, "base64")
      : Buffer.from(secret, "utf8");
  // An empty or short key makes every signature forgeable or guessable.
  if (key.byteLength < WEBHOOK_MIN_KEY_BYTES)
    return {
      ok: false,
      reason: `The signing secret must be at least ${WEBHOOK_MIN_KEY_BYTES} bytes`,
    };
  const encoding = verify.encoding ?? "hex";
  const expected = crypto
    .createHmac(verify.algorithm ?? "sha256", key)
    .update(content)
    .digest(encoding);
  const matched = headerParts({ value: received, ...verify }).some(
    (signature) =>
      sameSecret(
        expected,
        encoding === "hex" ? signature.toLowerCase() : signature,
      ),
  );
  return matched
    ? { ok: true }
    : { ok: false, reason: "Signature does not match" };
}

/**
 * The values a header carries: split by `separator` when there is one,
 * trimmed, keeping the parts that start with `prefix`, without it. Linear
 * in the header's length.
 */
function headerParts(input: {
  value: string;
  prefix?: string;
  separator?: string;
}): string[] {
  const prefix = input.prefix ?? "";
  const parts = input.separator
    ? input.value.split(input.separator)
    : [input.value];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length));
}

/**
 * The first handshake rule a request matches, and the value to answer
 * with. `body` is the parsed body the rules' filters read.
 */
export function matchWebhookHandshake(input: {
  rules: readonly WebhookHandshake[];
  request: WebhookRequest;
  body: unknown;
}): { rule: WebhookHandshake; answer: string } | undefined {
  const view = {
    method: input.request.method.toUpperCase(),
    headers: input.request.headers,
    query: input.request.query,
    body: input.body,
  };
  for (const rule of input.rules) {
    if (!matchesWhere(rule.when, view)) continue;
    const answer = valueAt(view, rule.echo.split("."));
    if (typeof answer === "string" || typeof answer === "number")
      return { rule, answer: String(answer) };
  }
  return undefined;
}

/**
 * The sender's id for this event at the declared `deliveryId` path, when it
 * is a string or number of at most 200 characters.
 */
export function declaredWebhookDeliveryId(input: {
  path: string;
  request: WebhookRequest;
  body: unknown;
}): string | undefined {
  const value = valueAt(
    {
      headers: input.request.headers,
      query: input.request.query,
      body: input.body,
    },
    input.path.split("."),
  );
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value);
  return id.length > 0 && id.length <= 200 ? id : undefined;
}

/** A shared secret carried in a header or query parameter. */
export function checkWebhookToken(input: {
  check: { header?: string; query?: string; prefix?: string };
  request: WebhookRequest;
  secret: string;
}): WebhookCheck {
  const raw = input.check.header
    ? input.request.headers[input.check.header.toLowerCase()]
    : input.check.query
      ? input.request.query[input.check.query]
      : undefined;
  const prefix = input.check.prefix ?? "";
  if (!raw?.startsWith(prefix)) return { ok: false, reason: "Missing token" };
  return sameSecret(input.secret, raw.slice(prefix.length))
    ? { ok: true }
    : { ok: false, reason: "Token does not match" };
}

function signedContent(input: {
  template: string;
  request: WebhookRequest;
  timestamp: string;
}): Buffer {
  // Splitting on a capturing pattern keeps each placeholder as its own part.
  const parts = input.template
    .split(/(\{(?:body|timestamp|header:[A-Za-z0-9-]+)\})/)
    .map((part) => {
      if (part === "{body}") return input.request.body;
      if (part === "{timestamp}") return Buffer.from(input.timestamp, "utf8");
      const header = /^\{header:([A-Za-z0-9-]+)\}$/.exec(part)?.[1];
      return Buffer.from(
        header === undefined
          ? part
          : (input.request.headers[header.toLowerCase()] ?? ""),
        "utf8",
      );
    });
  return Buffer.concat(parts);
}

/**
 * Resolves `body.challenge` or `query.hub.challenge`: at each level the
 * longest dotted key that exists wins, so dotted query names work.
 */
function valueAt(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return value;
  if (typeof value !== "object" || value === null) return undefined;
  for (let end = segments.length; end > 0; end -= 1) {
    const key = segments.slice(0, end).join(".");
    if (Object.hasOwn(value, key))
      return valueAt(Reflect.get(value, key), segments.slice(end));
  }
  return undefined;
}

/** Constant-time comparison of two secrets or signatures. */
export function sameSecret(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export { webhookSettingsKey };
