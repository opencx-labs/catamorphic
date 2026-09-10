import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTelemetryContext } from "./correlation.js";
import { emitLog } from "./logging.js";
import { loadTelemetryEnvironmentFile, startTelemetry } from "./node.js";
import { getTracer, withSpan } from "./tracing.js";

async function receiver() {
  const received: {
    path: string;
    authorization: string | undefined;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local receiver");
  return {
    received,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith("OTEL_")) vi.stubEnv(key, undefined);
});
afterEach(() => {
  trace.disable();
  metrics.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
});

describe("host SDK", () => {
  it("picks up project configuration when its folder becomes available after initial work", async () => {
    const target = await receiver();
    const sdk = startTelemetry({ serviceName: "desktop-test" });
    let mapped = false;
    sdk.configureProjects({
      resolve: () =>
        mapped
          ? {
              remote: {
                OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
                OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
              },
            }
          : undefined,
    });
    const tracer = getTracer("project-test");
    try {
      await withSpan(
        {
          tracer,
          name: "before-mapping",
          attributes: { "catamorphic.project.id": "new-project" },
        },
        async () => {},
      );
      mapped = true;
      await withSpan(
        {
          tracer,
          name: "after-mapping",
          attributes: { "catamorphic.project.id": "new-project" },
        },
        async () => emitLog({ scope: "test", body: "project-ready" }),
      );
      await sdk.shutdown();
      const body = JSON.stringify(target.received);
      expect(body).toContain("after-mapping");
      expect(body).toContain("project-ready");
      expect(body).not.toContain("before-mapping");
    } finally {
      await sdk.shutdown();
      await target.close();
    }
  });

  it("exports all signals with standard endpoint and header precedence and drains on shutdown", async () => {
    const target = await receiver();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", target.endpoint);
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20generic");
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      `${target.endpoint}/custom-traces`,
    );
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "authorization=Bearer%20traces",
    );
    vi.stubEnv("OTEL_SERVICE_NAME", "custom-service");
    const sdk = startTelemetry({ serviceName: "fallback" });
    try {
      await withSpan(
        { tracer: getTracer("test"), name: "host-work" },
        async () => emitLog({ scope: "test", body: "host-log" }),
      );
      await sdk.shutdown();
      expect(target.received.map((item) => item.path).sort()).toEqual([
        "/custom-traces",
        "/v1/logs",
        "/v1/metrics",
      ]);
      expect(
        target.received.find((item) => item.path === "/custom-traces")
          ?.authorization,
      ).toBe("Bearer traces");
      expect(
        target.received.find((item) => item.path === "/v1/logs")?.authorization,
      ).toBe("Bearer generic");
      expect(
        target.received.every((item) => item.body.includes("custom-service")),
      ).toBe(true);
      expect(
        target.received.find((item) => item.path === "/v1/metrics")?.body,
      ).toContain("catamorphic.operation.duration");
      expect(
        target.received.find((item) => item.path === "/v1/logs")?.body,
      ).toContain("traceId");
    } finally {
      await sdk.shutdown();
      await target.close();
    }
  });

  it("isolates concurrent project destinations, descendants, metrics, logs, and disable overrides", async () => {
    const [a, b] = await Promise.all([receiver(), receiver()]);
    const sdk = startTelemetry({ serviceName: "desktop-test" });
    const env = (endpoint: string) => ({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    });
    sdk.configureProjects({
      resolve: (id) =>
        id === "off"
          ? {}
          : { remote: env(id === "a" ? a.endpoint : b.endpoint) },
    });
    const tracer = getTracer("project-test");
    try {
      await Promise.all(
        ["a", "b", "off"].map((id) =>
          withSpan(
            {
              tracer,
              name: `root-${id}`,
              attributes: { "catamorphic.project.id": id },
            },
            async () => {
              await Promise.resolve();
              await withSpan({ tracer, name: `child-${id}` }, async () =>
                emitLog({ scope: "test", body: `log-${id}` }),
              );
            },
          ),
        ),
      );
      await sdk.shutdown();
      for (const [id, target, other] of [
        ["a", a, "b"],
        ["b", b, "a"],
      ] as const) {
        const body = JSON.stringify(target.received);
        expect(body).toContain(`root-${id}`);
        expect(body).toContain(`child-${id}`);
        expect(body).toContain(`log-${id}`);
        expect(body).not.toContain(`root-${other}`);
        expect(body).not.toContain("root-off");
        expect(target.received.map((item) => item.path).sort()).toEqual([
          "/v1/logs",
          "/v1/metrics",
          "/v1/traces",
        ]);
      }
    } finally {
      await sdk.shutdown();
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("loads only OTEL file settings and preserves explicit machine environment settings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otel-env-"));
    try {
      const file = path.join(dir, "otel.env");
      await writeFile(
        file,
        'OTEL_SERVICE_NAME="project desktop"\nOTEL_TRACES_EXPORTER=otlp\nUNRELATED=never\n',
      );
      const env: NodeJS.ProcessEnv = { OTEL_TRACES_EXPORTER: "none" };
      loadTelemetryEnvironmentFile({ path: file, env });
      expect(env).toEqual({
        OTEL_SERVICE_NAME: "project desktop",
        OTEL_TRACES_EXPORTER: "none",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("fans out to local and remote independently without crossing their credentials", async () => {
  const [local, remote] = await Promise.all([receiver(), receiver()]);
  const sdk = startTelemetry({ serviceName: "desktop-test" });
  const destination = (endpoint: string, token: string) => ({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer%20${token}`,
  });
  sdk.configureProjects({
    resolve: (id) => ({
      local: destination(local.endpoint, "local"),
      remote: id === "both" ? destination(remote.endpoint, "remote") : false,
    }),
  });
  try {
    for (const id of ["both", "local-only"])
      await withSpan(
        {
          tracer: getTracer("test"),
          name: id,
          attributes: { "catamorphic.project.id": id },
        },
        async () => emitLog({ scope: "test", body: `log-${id}` }),
      );
    await sdk.shutdown();
    expect(JSON.stringify(local.received)).toContain("local-only");
    expect(JSON.stringify(remote.received)).toContain("both");
    expect(JSON.stringify(remote.received)).not.toContain("local-only");
    expect(
      local.received.every((item) => item.authorization === "Bearer local"),
    ).toBe(true);
    expect(
      remote.received.every((item) => item.authorization === "Bearer remote"),
    ).toBe(true);
  } finally {
    await sdk.shutdown();
    await Promise.all([local.close(), remote.close()]);
  }
});

it("bounds shutdown even when a processor never finishes", async () => {
  const sdk = startTelemetry({
    serviceName: "shutdown-test",
    shutdownTimeoutMillis: 15,
    configuration: {
      spanProcessors: [
        {
          onStart() {},
          onEnd() {},
          forceFlush: async () => {},
          shutdown: () => new Promise<void>(() => {}),
        },
      ],
    },
  });
  const shutdown = sdk.shutdown();
  expect(sdk.shutdown()).toBe(shutdown);
  await shutdown;
});

it("fails closed for invalid project endpoints without breaking user work", async () => {
  const onError = vi.fn();
  const sdk = startTelemetry({ serviceName: "invalid-project-test" });
  sdk.configureProjects({
    resolve: () => ({
      remote: { OTEL_EXPORTER_OTLP_ENDPOINT: "invalid-endpoint" },
    }),
    onError,
  });
  try {
    expect(
      await withSpan(
        {
          tracer: getTracer("test"),
          name: "work",
          attributes: { "catamorphic.project.id": "invalid" },
        },
        async () => "done",
      ),
    ).toBe("done");
    expect(onError).toHaveBeenCalledWith("invalid");
  } finally {
    await sdk.shutdown();
  }
});

it("does not reuse a project's exporter when an SDK identity scope is reset", async () => {
  const [project, host] = await Promise.all([receiver(), receiver()]);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", host.endpoint);
  vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
  const sdk = startTelemetry({ serviceName: "scope-reset" });
  sdk.configureProjects({
    resolve: () => ({
      remote: {
        OTEL_EXPORTER_OTLP_ENDPOINT: project.endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      },
    }),
  });
  const tracer = getTracer("scope-reset");
  try {
    await withSpan(
      {
        tracer,
        name: "project-root",
        attributes: {
          "catamorphic.project.id": "project",
          "catamorphic.agent.session.id": "session",
        },
      },
      async () => {
        await withTelemetryContext(
          {
            attributes: {
              "catamorphic.tenant.id": "new-tenant",
              "user.id": "new-user",
            },
            reset: true,
          },
          () =>
            withSpan({ tracer, name: "independent-work" }, async () => {
              emitLog({ scope: "test", body: "independent-log" });
            }),
        );
        await withSpan({ tracer, name: "project-restored" }, async () => {});
      },
    );
    await sdk.shutdown();
    const projectBody = JSON.stringify(project.received);
    const hostBody = JSON.stringify(host.received);
    expect(projectBody).toContain("project-restored");
    expect(projectBody).not.toContain("independent-");
    expect(hostBody).toContain("independent-work");
    expect(hostBody).toContain("independent-log");
    expect(hostBody).not.toContain("catamorphic.agent.session.id");
  } finally {
    await sdk.shutdown();
    await Promise.all([project.close(), host.close()]);
  }
});
