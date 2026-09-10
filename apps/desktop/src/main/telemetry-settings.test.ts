import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectTelemetrySettings } from "./telemetry-settings.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-otel-"));
  fs.mkdirSync(path.join(directory, ".catamorphic"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function settings(project: unknown, machine: unknown = {}) {
  fs.writeFileSync(
    path.join(directory, ".catamorphic/project.json"),
    JSON.stringify({ telemetry: project }),
  );
  fs.writeFileSync(
    path.join(directory, "otel-projects.json"),
    JSON.stringify(machine),
  );
  return projectTelemetrySettings({
    projectId: "test",
    rootPath: directory,
    userDataPath: directory,
    env: {},
  });
}
describe("desktop telemetry settings", () => {
  it("uses committed defaults and overlays independent local and remote machine settings", () => {
    expect(
      settings(
        {
          local: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
          remote: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://team.invalid" },
        },
        {
          defaults: { local: false },
          projects: {
            test: {
              remote: {
                OTEL_EXPORTER_OTLP_HEADERS: "authorization=local-secret",
              },
            },
          },
        },
      ),
    ).toEqual({
      local: false,
      remote: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://team.invalid",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=local-secret",
      },
    });
  });
  it("supports disabling the entire project and the machine-wide SDK override", () => {
    expect(
      settings(
        { remote: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://team.invalid" } },
        { projects: { test: false } },
      ),
    ).toEqual({ local: false, remote: false });
    expect(
      projectTelemetrySettings({
        projectId: "test",
        userDataPath: directory,
        env: { OTEL_SDK_DISABLED: "true" },
      }),
    ).toEqual({});
  });
  it("rejects non-OTEL keys and nonlocal destinations marked local", () => {
    expect(() => settings({ remote: { ANTHROPIC_API_KEY: "no" } })).toThrow();
    expect(() =>
      settings({
        local: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://team.invalid" },
      }),
    ).toThrow("loopback");
  });
  it("preserves absent configuration and rejects malformed explicit configuration", () => {
    expect(
      projectTelemetrySettings({
        projectId: "test",
        userDataPath: directory,
        env: {},
      }),
    ).toBeUndefined();
    expect(() => settings("malformed")).toThrow();
  });
});
