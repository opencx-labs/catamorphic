import type { AgentErrorKind } from "@catamorphic/agent-protocol";
import { APICallError, RetryError } from "ai";

/**
 * Failure signatures in provider messages, for errors that carry no status
 * code (a stream `error` part, a transport failure). Auth first: an invalid
 * key can also produce the 4xx phrasings below.
 */
const KIND_SIGNATURES: Array<{ kind: AgentErrorKind; pattern: RegExp }> = [
  { kind: "auth", pattern: /\buser not found\b/i }, // OpenRouter 401
  { kind: "auth", pattern: /\binvalid x-api-key\b/i }, // Anthropic
  { kind: "auth", pattern: /\bauthentication[_ ]error\b/i },
  { kind: "auth", pattern: /\bincorrect api key\b/i }, // OpenAI
  { kind: "auth", pattern: /\binvalid api key\b/i },
  { kind: "auth", pattern: /\bno auth credentials\b/i },
  { kind: "auth", pattern: /\bunauthorized\b/i },
  // Mid-conversation model switches: reasoning output is signed by the
  // producing model; another model rejects the history.
  { kind: "model_incompat", pattern: /\bsignature\b/i },
  { kind: "model_incompat", pattern: /\bthinking.{0,40}block/i },
  { kind: "model_incompat", pattern: /\bencrypted.{0,20}(reasoning|content)/i },
  { kind: "model_incompat", pattern: /\breasoning.{0,40}not supported/i },
  { kind: "rate_limit", pattern: /\brate.?limit/i },
  { kind: "rate_limit", pattern: /\btoo many requests\b/i },
  { kind: "rate_limit", pattern: /\bquota\b/i },
  { kind: "unavailable", pattern: /\boverloaded\b/i },
  { kind: "unavailable", pattern: /\bservice unavailable\b/i },
  { kind: "unavailable", pattern: /\binternal server error\b/i },
  { kind: "unavailable", pattern: /\bECONN(RESET|REFUSED)\b/ },
  { kind: "unavailable", pattern: /\bETIMEDOUT\b|\bENOTFOUND\b/ },
  { kind: "unavailable", pattern: /\bfetch failed\b/i },
];

export interface ClassifiedError {
  message: string;
  kind?: AgentErrorKind;
  /**
   * The model provider answered the request with a refusal (a status code,
   * or a recognized provider failure): nothing ran on its side.
   */
  providerRejected: boolean;
}

/**
 * Classify a failed model call (ADR 0057's error kinds): `auth` offers a
 * re-connect path, `rate_limit` and `unavailable` explain an outage,
 * `model_incompat` retries with sanitized reasoning history.
 */
export function classifyModelError(error: unknown): ClassifiedError {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const message = errorMessage(cause);
  if (APICallError.isInstance(cause)) {
    const text = `${cause.message}\n${cause.responseBody ?? ""}`;
    const kind = statusKind(cause.statusCode) ?? signatureKind(text);
    return { message, ...(kind ? { kind } : {}), providerRejected: true };
  }
  const kind = signatureKind(message);
  return {
    message,
    ...(kind ? { kind } : {}),
    providerRejected: Boolean(kind),
  };
}

function statusKind(status: number | undefined): AgentErrorKind | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (
    status === 408 ||
    status === 529 ||
    (status !== undefined && status >= 500)
  )
    return "unavailable";
  return undefined;
}

function signatureKind(text: string): AgentErrorKind | undefined {
  return KIND_SIGNATURES.find(({ pattern }) => pattern.test(text))?.kind;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
