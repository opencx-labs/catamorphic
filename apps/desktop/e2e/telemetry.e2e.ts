import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { type AppHandle, launchApp, removeE2eDirectory } from "./harness.js";

async function receiver() {
  const received: { path: string; body: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString(),
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No receiver address");
  return {
    received,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it("exports desktop project signals using committed settings and machine destination overrides", async () => {
  const [local, remote] = await Promise.all([receiver(), receiver()]);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-e2e-otel-"),
  );
  const env = {
    OTEL_SDK_DISABLED: "false",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_METRICS_EXPORTER: "none",
  };
  let app: AppHandle | undefined;
  try {
    fs.writeFileSync(
      path.join(directory, "otel-projects.json"),
      JSON.stringify({
        defaults: {
          local: false,
          remote: {
            OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20machine-secret",
          },
        },
      }),
    );
    app = await launchApp({
      userDataDir: directory,
      env,
    });
    const project = await app.eval<{ id: string; root: string }>(`(async () => {
      const project = await window.catamorphicDesktop.createDefaultProject();
      return { id: project.id, root: await window.catamorphicDesktop.projectRoot(project.id) };
    })()`);
    const manifestPath = path.join(project.root, ".catamorphic/project.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const settings = {
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_BSP_SCHEDULE_DELAY: "50",
      OTEL_BLRP_SCHEDULE_DELAY: "50",
      OTEL_METRIC_EXPORT_INTERVAL: "100",
      OTEL_METRIC_EXPORT_TIMEOUT: "100",
    };
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        telemetry: {
          local: { ...settings, OTEL_EXPORTER_OTLP_ENDPOINT: local.endpoint },
          remote: { ...settings, OTEL_EXPORTER_OTLP_ENDPOINT: remote.endpoint },
        },
      }),
    );
    // Configuration takes effect on restart. Preserve the real project and
    // machine settings while starting fresh providers in the next process.
    await app.stop({ preserveUserData: true });
    app = await launchApp({ userDataDir: directory, env });
    const status = await app.eval<number>(`(async () => {
      const server = await window.catamorphicDesktop.getServerState();
      return (await fetch(server.url + '/api/projects/' + ${JSON.stringify(project.id)})).status;
    })()`);
    expect(status).toBe(200);
    await expect
      .poll(
        () => new Set(remote.received.map((request) => request.path)).size,
        { timeout: 10_000 },
      )
      .toBe(3);
    expect(local.received).toEqual([]);
    expect(
      remote.received.every(
        (request) => request.authorization === "Bearer machine-secret",
      ),
    ).toBe(true);
    for (const signal of ["traces", "metrics", "logs"]) {
      const payload = remote.received
        .filter((request) => request.path === `/v1/${signal}`)
        .map((request) => request.body)
        .join("");
      expect(payload).toContain(project.id);
      expect(payload).not.toContain("machine-secret");
    }
  } finally {
    if (app) await app.stop();
    else removeE2eDirectory(directory);
    await Promise.all([local.close(), remote.close()]);
  }
});
