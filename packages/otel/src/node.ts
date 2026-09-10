import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { metrics } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import {
  installProjectTelemetry,
  type ProjectTelemetryConfiguration,
} from "./project-telemetry.js";

/** Load only OTEL keys. Existing process settings always win, including none. */
export function loadTelemetryEnvironmentFile(args: {
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = args.env ?? process.env;
  let contents: string;
  try {
    contents = readFileSync(args.path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (key.startsWith("OTEL_") && env[key] === undefined) env[key] = value;
  }
}

/**
 * Host-only entry point. Standard SDK options override environment defaults;
 * arbitrary exporters/processors/readers remain injectable. No library imports it.
 */
export function startTelemetry(args: {
  serviceName: string;
  serviceVersion?: string;
  configuration?: Partial<NodeSDKConfiguration>;
  shutdownTimeoutMillis?: number;
}) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  // NodeSDK defaults differ by signal. Make explicit endpoint configuration
  // enable all three, while an unconfigured product has no outbound telemetry.
  for (const signal of ["TRACES", "METRICS", "LOGS"]) {
    const key = `OTEL_${signal}_EXPORTER`;
    if (!process.env[key]?.trim()) {
      process.env[key] =
        endpoint || process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim()
          ? "otlp"
          : "none";
    }
  }
  const sdk = (() => {
    try {
      const instance = new NodeSDK({
        resource: resourceFromAttributes({
          "service.name": args.serviceName,
          ...(args.serviceVersion
            ? { "service.version": args.serviceVersion }
            : {}),
        }),
        ...args.configuration,
      });
      try {
        instance.start();
      } catch (error) {
        void instance.shutdown().catch(() => {});
        throw error;
      }
      return instance;
    } catch {
      console.warn("Telemetry could not start; check the OTEL configuration.");
      return undefined;
    }
  })();
  const meter = metrics.getMeter("@catamorphic/host");
  meter
    .createObservableGauge("process.memory.usage", { unit: "By" })
    .addCallback((result) => {
      result.observe(process.memoryUsage().rss);
    });
  meter
    .createObservableCounter("process.cpu.time", { unit: "s" })
    .addCallback((result) => {
      const cpu = process.cpuUsage();
      result.observe(cpu.user / 1_000_000, { "cpu.mode": "user" });
      result.observe(cpu.system / 1_000_000, { "cpu.mode": "system" });
    });
  let projects: ReturnType<typeof installProjectTelemetry> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    configureProjects(projectsArgs: {
      resolve: (projectId: string) => ProjectTelemetryConfiguration | undefined;
      onError?: (projectId: string) => void;
    }): void {
      if (projects) throw new Error("Project telemetry is already configured");
      if (process.env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return;
      projects = installProjectTelemetry({
        ...projectsArgs,
        serviceName: args.serviceName,
      });
    },
    shutdown(): Promise<void> {
      stopping ??= new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, args.shutdownTimeoutMillis ?? 5000);
        // A failed exporter must neither reject application shutdown nor hang it.
        void Promise.allSettled([projects?.shutdown(), sdk?.shutdown()])
          .catch(() => {})
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      });
      return stopping;
    },
  };
}

export { CorrelationSpanProcessor } from "./correlation-processor.js";
export {
  createProjectTelemetry,
  installProjectTelemetry,
  type ProjectTelemetryConfiguration,
  type TelemetryEnvironment,
} from "./project-telemetry.js";
