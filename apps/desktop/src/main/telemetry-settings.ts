import fs from "node:fs";
import path from "node:path";
import type { ProjectTelemetryConfiguration } from "@catamorphic/otel/node";
import { z } from "zod";

const Environment = z.record(z.string().regex(/^OTEL_[A-Z0-9_]+$/), z.string());
const Destinations = z
  .object({
    local: Environment.or(z.literal(false)).optional(),
    remote: Environment.or(z.literal(false)).optional(),
  })
  .strict();
const Settings = Destinations.or(z.literal(false));
const Machine = z
  .object({
    defaults: Settings.optional(),
    projects: z.record(z.string(), Settings).optional(),
  })
  .strict();

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error("Cannot read telemetry settings", { cause: error });
  }
}

/** Committed defaults, then machine defaults, then the machine's project override. */
export function projectTelemetrySettings(args: {
  projectId: string;
  rootPath?: string;
  userDataPath: string;
  env?: NodeJS.ProcessEnv;
}): ProjectTelemetryConfiguration | undefined {
  if ((args.env ?? process.env).OTEL_SDK_DISABLED?.toLowerCase() === "true")
    return {};
  const manifest = args.rootPath
    ? readJson(path.join(args.rootPath, ".catamorphic/project.json"))
    : undefined;
  const rawProject =
    manifest && typeof manifest === "object" && "telemetry" in manifest
      ? manifest.telemetry
      : undefined;
  const project =
    rawProject === undefined ? undefined : Settings.parse(rawProject);
  const machine = Machine.parse(
    readJson(path.join(args.userDataPath, "otel-projects.json")) ?? {},
  );
  const overrides = [
    project,
    machine.defaults,
    machine.projects?.[args.projectId],
  ];
  if (overrides.every((value) => value === undefined)) return undefined;
  let config: ProjectTelemetryConfiguration = {};
  for (const override of overrides) {
    if (override === undefined) continue;
    if (override === false) {
      config = { local: false, remote: false };
      continue;
    }
    for (const destination of ["local", "remote"] as const) {
      const value = override[destination];
      if (value === undefined) continue;
      config[destination] =
        value === false ? false : { ...(config[destination] || {}), ...value };
    }
  }
  if (config.local) {
    for (const [key, value] of Object.entries(config.local)) {
      if (
        !/^OTEL_EXPORTER_OTLP(?:_(?:TRACES|LOGS|METRICS))?_ENDPOINT$/.test(key)
      )
        continue;
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)) {
        throw new Error(
          "Local telemetry destinations must use loopback endpoints",
        );
      }
    }
  }
  return config;
}
