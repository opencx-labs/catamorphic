import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  correlationAttributes,
  extractTelemetryContext,
  injectTelemetryContext,
  setSpanCorrelation,
  withTelemetryContext,
} from "./correlation.js";
import { CorrelationSpanProcessor } from "./correlation-processor.js";
import { emitLog } from "./logging.js";
import { getTracer, withSpan } from "./tracing.js";

const exporter = new InMemorySpanExporter();
const processor = new CorrelationSpanProcessor();
const provider = new NodeTracerProvider({
  spanProcessors: [processor, new SimpleSpanProcessor(exporter)],
});
const logExporter = new InMemoryLogRecordExporter();
const logger = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
});
const tracer = getTracer("correlation-test");
const ids = {
  "catamorphic.tenant.id": "tenant",
  "user.id": "actor",
  "catamorphic.project.id": "project",
  "catamorphic.agent.session.id": "session",
  "gen_ai.conversation.id": "session",
  "catamorphic.agent.turn.id": "turn",
};
beforeAll(() => {
  provider.register();
  logs.setGlobalLoggerProvider(logger);
});
beforeEach(() => {
  exporter.reset();
  logExporter.reset();
});
afterAll(async () => {
  await Promise.all([provider.shutdown(), logger.shutdown()]);
  trace.disable();
  context.disable();
  propagation.disable();
  logs.disable();
});
const attributes = (name: string) =>
  exporter.getFinishedSpans().find((s) => s.name === name)?.attributes;

describe("correlation context", () => {
  it("enriches nested spans and logs, including third-party instrumentation, without inheriting arbitrary attributes", async () => {
    await withSpan(
      { tracer, name: "turn", attributes: { ...ids, content: "SECRET" } },
      async () => {
        await Promise.resolve();
        await withSpan({ tracer, name: "tool" }, async () => {
          // The host processor also covers instrumentations using the raw API.
          await trace
            .getTracer("third-party")
            .startActiveSpan("client", async (span) => {
              await Promise.resolve();
              emitLog({ scope: "test", body: "completed" });
              span.end();
            });
        });
      },
    );
    expect(attributes("tool")).toEqual(ids);
    expect(attributes("client")).toEqual(ids);
    expect(logExporter.getFinishedLogRecords()[0]?.attributes).toEqual(ids);
    expect(logExporter.getFinishedLogRecords()[0]?.spanContext?.spanId).toBe(
      exporter
        .getFinishedSpans()
        .find((s) => s.name === "client")
        ?.spanContext().spanId,
    );
  });

  it("isolates overlapping async scopes and restores parents after failure", async () => {
    await Promise.all(
      ["one", "two"].map((id) =>
        withSpan(
          {
            tracer,
            name: id,
            attributes: { ...ids, "catamorphic.project.id": id },
          },
          async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, id === "one" ? 8 : 1),
            );
            await withSpan({ tracer, name: `${id}.child` }, async () => {});
            await expect(
              withTelemetryContext(
                { attributes: { "catamorphic.project.id": "temporary" } },
                async () => {
                  throw new Error("failure");
                },
              ),
            ).rejects.toThrow("failure");
            expect(correlationAttributes()["catamorphic.project.id"]).toBe(id);
          },
        ),
      ),
    );
    expect(attributes("one.child")?.["catamorphic.project.id"]).toBe("one");
    expect(attributes("two.child")?.["catamorphic.project.id"]).toBe("two");
    expect(correlationAttributes()).toEqual({});
  });

  it("clears incompatible inherited identifiers at tenant, project and session boundaries", async () => {
    await withSpan({ tracer, name: "parent", attributes: ids }, async () => {
      await withSpan(
        {
          tracer,
          name: "project",
          attributes: { "catamorphic.project.id": "other" },
        },
        async () => {},
      );
      await withSpan(
        {
          tracer,
          name: "tenant",
          attributes: { "catamorphic.tenant.id": "other" },
        },
        async () => {},
      );
      await withSpan(
        {
          tracer,
          name: "session",
          attributes: { "catamorphic.agent.session.id": "other" },
        },
        async () => {},
      );
    });
    expect(attributes("project")).toEqual({
      "catamorphic.tenant.id": "tenant",
      "user.id": "actor",
      "catamorphic.project.id": "other",
    });
    expect(attributes("tenant")).toEqual({ "catamorphic.tenant.id": "other" });
    expect(attributes("session")).toEqual({
      "catamorphic.tenant.id": "tenant",
      "user.id": "actor",
      "catamorphic.project.id": "project",
      "catamorphic.agent.session.id": "other",
    });
  });

  it("clears prior run attempts for child workflows", async () => {
    await withSpan(
      {
        tracer,
        name: "run",
        attributes: {
          ...ids,
          "catamorphic.run.id": "run",
          "catamorphic.workflow.name": "parent",
          "catamorphic.queue.job.id": "job",
          "catamorphic.queue.job.attempt": 2,
        },
      },
      async () => {
        await withSpan(
          {
            tracer,
            name: "child-run",
            attributes: { "catamorphic.run.id": "child" },
          },
          async () => {},
        );
      },
    );
    expect(attributes("child-run")).toEqual({
      ...ids,
      "catamorphic.run.id": "child",
    });
  });

  it("clears a caller's run/job before starting an operation whose own ID is resolved later", async () => {
    await withSpan(
      {
        tracer,
        name: "caller",
        attributes: {
          ...ids,
          "catamorphic.run.id": "old-run",
          "catamorphic.queue.job.id": "old-job",
          "catamorphic.queue.job.attempt": 3,
        },
      },
      async () => {
        await withSpan(
          {
            tracer,
            name: "created-run",
            attributes: {
              "catamorphic.run.id": undefined,
              "catamorphic.workflow.name": "new-workflow",
            },
          },
          async (span) => {
            setSpanCorrelation({
              span,
              attributes: { "catamorphic.run.id": "new-run" },
            });
            await withSpan({ tracer, name: "new-work" }, async () => {});
          },
        );
      },
    );
    for (const name of ["created-run", "new-work"]) {
      expect(attributes(name)).toEqual({
        ...ids,
        "catamorphic.run.id": "new-run",
        "catamorphic.workflow.name": "new-workflow",
      });
    }
  });

  it("does not inherit IDs for explicit root spans or reset scopes", async () => {
    await withSpan({ tracer, name: "parent", attributes: ids }, async () => {
      tracer.startSpan("new-root", { root: true }).end();
      await withTelemetryContext(
        { attributes: { "catamorphic.run.id": "persisted" }, reset: true },
        () => withSpan({ tracer, name: "job" }, async () => {}),
      );
      expect(correlationAttributes()).toEqual(ids);
    });
    expect(attributes("new-root")).toEqual({});
    expect(attributes("job")).toEqual({ "catamorphic.run.id": "persisted" });
  });

  it("binds identity discovered after request creation without losing the project", async () => {
    await withSpan(
      {
        tracer,
        name: "request",
        attributes: { "catamorphic.project.id": "project" },
      },
      async (span) => {
        setSpanCorrelation({
          span,
          attributes: { "catamorphic.tenant.id": "tenant", "user.id": "actor" },
        });
        await withSpan({ tracer, name: "authenticated" }, async () => {});
      },
    );
    expect(attributes("authenticated")).toEqual({
      "catamorphic.project.id": "project",
      "catamorphic.tenant.id": "tenant",
      "user.id": "actor",
    });
  });

  it("transports only explicitly allowed correlation and strips baggage at ingress and egress by default", async () => {
    await withSpan(
      { tracer, name: "source", attributes: ids },
      async (span) => {
        const untrusted = propagation.setBaggage(
          context.active(),
          propagation.createBaggage({
            secret: { value: "SECRET" },
            "user.id": { value: "spoofed" },
          }),
        );
        const ordinary = injectTelemetryContext({ parent: untrusted });
        expect(ordinary.baggage).toBeUndefined();
        const carrier = injectTelemetryContext({
          parent: untrusted,
          baggageKeys: [
            "catamorphic.project.id",
            "catamorphic.agent.session.id",
          ],
        });
        expect(carrier.baggage).toContain("catamorphic.project.id=project");
        expect(carrier.baggage).not.toContain("user.id");
        expect(carrier.baggage).not.toContain("SECRET");
        const incoming = {
          ...carrier,
          baggage: `${carrier.baggage},user.id=spoofed`,
        };
        const ordinaryIngress = extractTelemetryContext({ carrier: incoming });
        expect(correlationAttributes(ordinaryIngress)).toEqual({});
        expect(propagation.getBaggage(ordinaryIngress)).toBeUndefined();
        const trusted = extractTelemetryContext({
          carrier: incoming,
          baggageKeys: ["catamorphic.project.id"],
        });
        expect(correlationAttributes(trusted)).toEqual({
          "catamorphic.project.id": "project",
        });
        expect(trace.getSpanContext(trusted)?.traceId).toBe(
          span.spanContext().traceId,
        );
        expect(propagation.getBaggage(trusted)).toBeUndefined();
      },
    );
    expect(correlationAttributes(ROOT_CONTEXT)).toEqual({});
  });

  it("bounds correlation values and snapshots caller-owned attribute objects", async () => {
    const mutable = { "catamorphic.project.id": "original" };
    await withTelemetryContext({ attributes: mutable }, async () => {
      mutable["catamorphic.project.id"] = "mutated";
      expect(correlationAttributes()["catamorphic.project.id"]).toBe(
        "original",
      );
      await withSpan(
        {
          tracer,
          name: "invalid",
          attributes: {
            "catamorphic.agent.turn.id": "x".repeat(1025),
            "catamorphic.queue.job.attempt": NaN,
          },
        },
        async () => {},
      );
    });
    expect(attributes("invalid")).toEqual({
      "catamorphic.project.id": "original",
    });
  });
});
