import type { FastifyReply, FastifyRequest } from "fastify";

/** URLs can carry OAuth codes, bearer state and webhook tokens. */
export function requestLogFields(request: FastifyRequest) {
  return {
    method: request.method,
    route: request.routeOptions?.url ?? "[unmatched]",
    remoteAddress: request.ip,
  };
}

/** Provider and database exception messages can repeat credential material. */
export function errorLogFields(_error: unknown) {
  return { type: "Error", message: "Request failed", stack: "" };
}

/** Sending an Error invokes Fastify's raw-message logger; send safe data. */
export function apiErrorResponse(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const status =
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
      ? error.statusCode
      : 500;
  request.log.error(
    { errorType: errorLogFields(error).type },
    "API request failed",
  );
  return reply.status(status).send({
    error: status >= 500 ? "Internal server error" : "Invalid request",
  });
}

/** Fastify's default 404 logs the credential-bearing raw URL as its message. */
export function apiNotFoundResponse(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.status(404).send({ error: "Not found" });
}
