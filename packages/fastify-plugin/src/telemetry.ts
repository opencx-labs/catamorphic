import {
  emitLog,
  extractTelemetryContext,
  getMeter,
  getTracer,
  SeverityNumber,
} from "@catamorphic/otel";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";

/** Explicit host opt-in; works under Bun and bundlers without module patching. */
export function instrumentHttpServer(app: FastifyInstance): void {
  const tracer = getTracer("@catamorphic/http");
  app.addHook("onRequest", (request, reply, done) => {
    const projectId =
      request.params &&
      typeof request.params === "object" &&
      "projectId" in request.params &&
      typeof request.params.projectId === "string"
        ? request.params.projectId
        : undefined;
    const parent = extractTelemetryContext({ carrier: request.headers });
    const method =
      /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)$/.test(
        request.method,
      )
        ? request.method
        : "_OTHER";
    const span = tracer.startSpan(
      method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": method,
          ...(projectId ? { "catamorphic.project.id": projectId } : {}),
        },
      },
      parent,
    );
    const state = {
      span,
      context: trace.setSpan(parent, span),
      started: performance.now(),
      finished: false,
    };
    const finish = (aborted = false) => {
      if (state.finished) return;
      state.finished = true;
      const route = request.routeOptions.url;
      const status = reply.statusCode;
      const attributes = {
        "http.request.method": method,
        ...(route ? { "http.route": route } : {}),
        ...(aborted
          ? { "error.type": "client_cancelled" }
          : { "http.response.status_code": status }),
        ...(!aborted && status >= 500 ? { "error.type": String(status) } : {}),
      };
      span.updateName(route ? `${method} ${route}` : method);
      span.setAttributes(attributes);
      if (!aborted && status >= 500)
        span.setStatus({ code: SpanStatusCode.ERROR });
      context.with(state.context, () => {
        getMeter("@catamorphic/http")
          .createHistogram("http.server.request.duration", {
            unit: "s",
            advice: {
              explicitBucketBoundaries: [
                0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5,
                5, 7.5, 10,
              ],
            },
          })
          .record((performance.now() - state.started) / 1000, attributes);
        emitLog({
          scope: "@catamorphic/http",
          body: aborted
            ? "HTTP request disconnected"
            : "HTTP request completed",
          attributes,
          severity:
            !aborted && status >= 500
              ? SeverityNumber.ERROR
              : SeverityNumber.INFO,
        });
      });
      span.end();
    };
    reply.raw.once("finish", () => finish());
    reply.raw.once("close", () => finish(!reply.raw.writableFinished));
    context.with(state.context, done);
  });
}
