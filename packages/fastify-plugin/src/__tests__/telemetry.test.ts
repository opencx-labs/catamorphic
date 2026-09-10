import { getTracer, withSpan } from "@catamorphic/otel";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachIdentity } from "../http-identity.js";
import { instrumentHttpServer } from "../telemetry.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => provider.register());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});
describe("HTTP telemetry", () => {
  it("extracts W3C context, parents service work, records template paths, and captures errors", async () => {
    const app = Fastify();
    instrumentHttpServer(app);
    app.addHook("onRequest", async (request) => {
      await Promise.resolve();
      attachIdentity(request, {
        tenantId: "trusted-tenant",
        externalUserId: "trusted-user",
      });
    });
    app.get("/projects/:projectId/work", async () =>
      withSpan(
        { tracer: getTracer("test"), name: "request-work" },
        async () => ({ ok: true }),
      ),
    );
    app.get("/failure", async () => {
      throw new Error("PRIVATE_ERROR");
    });
    app.get("/bad-request", (_request, reply) =>
      reply.code(400).send({ error: "input" }),
    );
    try {
      await app.inject({
        url: "/projects/private-id/work?token=PRIVATE_TOKEN",
        headers: {
          baggage:
            "user.id=spoofed,catamorphic.project.id=spoofed,catamorphic.agent.session.id=spoofed",
          traceparent:
            "00-12345678901234567890123456789012-1234567890123456-01",
        },
      });
      await app.inject("/failure");
      await app.inject("/bad-request");
      const spans = exporter.getFinishedSpans();
      const request = spans.find(
        (span) => span.name === "GET /projects/:projectId/work",
      );
      expect(request?.kind).toBe(SpanKind.SERVER);
      expect(request?.spanContext().traceId).toBe(
        "12345678901234567890123456789012",
      );
      expect(request?.parentSpanContext?.spanId).toBe("1234567890123456");
      expect(
        spans.find((span) => span.name === "request-work")?.parentSpanContext
          ?.spanId,
      ).toBe(request?.spanContext().spanId);
      expect(request?.attributes).toMatchObject({
        "catamorphic.project.id": "private-id",
        "catamorphic.tenant.id": "trusted-tenant",
        "user.id": "trusted-user",
      });
      expect(
        spans.find((span) => span.name === "request-work")?.attributes,
      ).toMatchObject({
        "catamorphic.project.id": "private-id",
        "catamorphic.tenant.id": "trusted-tenant",
        "user.id": "trusted-user",
      });
      expect(
        JSON.stringify(spans.map((span) => span.attributes)),
      ).not.toContain("spoofed");
      expect(
        spans.find((span) => span.name === "GET /failure")?.status.code,
      ).toBe(SpanStatusCode.ERROR);
      expect(
        spans.find((span) => span.name === "GET /bad-request")?.status.code,
      ).toBe(SpanStatusCode.UNSET);
      expect(
        JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            attributes: span.attributes,
            events: span.events,
          })),
        ),
      ).not.toContain("PRIVATE_");
    } finally {
      await app.close();
    }
  });
});
