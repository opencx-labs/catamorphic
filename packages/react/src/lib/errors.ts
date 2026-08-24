/**
 * Typed error envelope for every `@catamorphic/react` hook. Hosts match on
 * `error.code` instead of string-matching `error.message`.
 */
export type CatamorphicErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "rate_limited"
  | "sandbox_unavailable"
  | "authentication_required"
  | "network"
  | "unknown";

export interface CatamorphicErrorInit {
  code: CatamorphicErrorCode;
  message?: string;
  status?: number;
  details?: unknown;
  cause?: unknown;
}

export class CatamorphicError extends Error {
  readonly code: CatamorphicErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(init: CatamorphicErrorInit) {
    super(init.message ?? defaultMessageFor(init.code));
    this.name = "CatamorphicError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.cause = init.cause;
  }
}

function defaultMessageFor(code: CatamorphicErrorCode): string {
  switch (code) {
    case "unauthorized":
      return "Unauthorized";
    case "forbidden":
      return "Forbidden";
    case "not_found":
      return "Not found";
    case "conflict":
      return "Conflict";
    case "validation":
      return "Validation failed";
    case "rate_limited":
      return "Rate limited";
    case "sandbox_unavailable":
      return "Sandbox unavailable";
    case "network":
      return "Network error";
    case "authentication_required":
      return "Authentication required";
    default:
      return "Unknown error";
  }
}

function codeForStatus(status: number): CatamorphicErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 428) return "authentication_required";
  if (status === 503) return "sandbox_unavailable";
  return "unknown";
}

function extractMessage(body: unknown): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body || undefined;
  if (typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  // Fastify error envelopes put the generic status text in `error`
  // ("Internal Server Error") and the actual cause in `message` — prefer it.
  const msg = record.message;
  if (typeof msg === "string" && msg.length > 0) return msg;
  const err = record.error;
  if (typeof err === "string" && err.length > 0) return err;
  return undefined;
}

export interface ToCatamorphicErrorInput {
  response?: { status?: number } | null;
  body?: unknown;
  cause?: unknown;
  fallbackMessage?: string;
}

/**
 * Map an openapi-fetch error (and optional fetch `Response`) into the
 * `CatamorphicError` envelope. Hooks pass whatever they got back from the
 * client straight through; the helper figures out the right code.
 */
export function toCatamorphicError(
  input: ToCatamorphicErrorInput = {},
): CatamorphicError {
  if (input.cause instanceof CatamorphicError) return input.cause;

  const status =
    input.response?.status ??
    (typeof input.body === "object" && input.body !== null
      ? (input.body as { status?: number }).status
      : undefined);

  if (typeof status === "number") {
    const code = codeForStatus(status);
    const message =
      extractMessage(input.body) ??
      input.fallbackMessage ??
      defaultMessageFor(code);
    return new CatamorphicError({
      code,
      message,
      status,
      details: input.body,
      cause: input.cause,
    });
  }

  // No HTTP status — assume fetch threw (DNS, offline, CORS, aborted, …).
  const message =
    extractMessage(input.body) ??
    (input.cause instanceof Error ? input.cause.message : undefined) ??
    input.fallbackMessage ??
    defaultMessageFor("network");

  return new CatamorphicError({
    code: "network",
    message,
    details: input.body,
    cause: input.cause,
  });
}

/**
 * Wrap an async fetch/openapi-fetch call so any thrown error (fetch blew up,
 * JSON parse blew up, etc.) comes out as a `CatamorphicError`. Hooks use
 * this in their `queryFn` / `mutationFn` to guarantee the error type.
 */
export async function runWithCatamorphicError<T>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CatamorphicError) throw err;
    throw toCatamorphicError({ cause: err });
  }
}

/**
 * Narrow an `openapi-fetch` result `{ data, error, response }` to `data`.
 * Throws a `CatamorphicError` built from the error body + response status
 * when the call failed. Hooks use this to convert the typed client's
 * result straight into the envelope.
 */
export function assertApiOk<TData>(
  result: {
    data?: TData;
    error?: unknown;
    response?: { status?: number };
  },
  fallbackMessage?: string,
): TData {
  if (result.error !== undefined && result.error !== null) {
    throw toCatamorphicError({
      response: result.response,
      body: result.error,
      fallbackMessage,
    });
  }
  if (result.data === undefined || result.data === null) {
    throw toCatamorphicError({
      response: result.response,
      fallbackMessage: fallbackMessage ?? "Empty response body",
    });
  }
  return result.data;
}
