import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { workServerConfigFromEnv } from "./config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-config-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it("reads the webhook body maximum and rejects values the server cannot honor", () => {
  const env = { WORK_DATA_DIR: dir };
  expect(workServerConfigFromEnv(env).webhookMaxBodyBytes).toBeUndefined();
  expect(
    workServerConfigFromEnv({ ...env, WORK_WEBHOOK_MAX_BYTES: "4194304" })
      .webhookMaxBodyBytes,
  ).toBe(4_194_304);
  for (const value of ["0", "1.5", "lots", String(64 * 1024 * 1024 + 1)]) {
    expect(() =>
      workServerConfigFromEnv({ ...env, WORK_WEBHOOK_MAX_BYTES: value }),
    ).toThrow("WORK_WEBHOOK_MAX_BYTES");
  }
});

it("reads sign-in configuration files into typed config (ADR 0183)", () => {
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  // No file configures local sign-in with default policies.
  expect(workServerConfigFromEnv({ WORK_DATA_DIR: dataDir }).auth).toEqual({
    local: { enabled: true },
    providers: [],
    sessions: { accessTokenMinutes: 15, idleDays: 14, maxDays: 30 },
    directory: { checkMinutes: 5, graceMinutes: 30 },
  });
  fs.writeFileSync(
    path.join(dataDir, "auth-config.json"),
    JSON.stringify({ local: { enabled: false } }),
  );
  expect(
    workServerConfigFromEnv({ WORK_DATA_DIR: dataDir }).auth?.local,
  ).toEqual({ enabled: false });
  const configured = path.join(dir, "sign-in.json");
  fs.writeFileSync(
    configured,
    JSON.stringify({ sessions: { idleDays: 14, maxDays: 7 } }),
  );
  expect(() =>
    workServerConfigFromEnv({
      WORK_DATA_DIR: dataDir,
      WORK_AUTH_CONFIG: configured,
    }),
  ).toThrow(configured);
});

it("reads trusted proxies and the sign-in limit switch", () => {
  const env = { WORK_DATA_DIR: dir };
  const defaults = workServerConfigFromEnv(env);
  expect(defaults.trustedProxies).toBeUndefined();
  expect(defaults.authRateLimit).toBeUndefined();
  const configured = workServerConfigFromEnv({
    ...env,
    WORK_TRUSTED_PROXIES: " 10.0.0.0/8, fd00::/8 ,",
    WORK_AUTH_RATE_LIMIT: "off",
  });
  expect(configured.trustedProxies).toEqual(["10.0.0.0/8", "fd00::/8"]);
  expect(configured.authRateLimit).toBe(false);
  expect(() =>
    workServerConfigFromEnv({ ...env, WORK_TRUSTED_PROXIES: "10.0.0.0/40" }),
  ).toThrow("WORK_TRUSTED_PROXIES");
  expect(() =>
    workServerConfigFromEnv({ ...env, WORK_AUTH_RATE_LIMIT: "false" }),
  ).toThrow("WORK_AUTH_RATE_LIMIT");
});

it("reads machine classes, the Hetzner token and the worker image (ADR 0205)", () => {
  const env = { WORK_DATA_DIR: dir };
  const file = path.join(dir, "machines.json");
  const classes = {
    desk: {
      platform: "hetzner-cloud",
      serverType: "cpx41",
      location: "fsn1",
      image: "ubuntu-24.04",
      sshKeys: ["ops", 42],
      firewalls: [7],
      labels: { team: "eng" },
      snapshot: true,
    },
    office: { platform: "pool" },
  };
  fs.writeFileSync(file, JSON.stringify({ classes }));
  const configured = workServerConfigFromEnv({
    ...env,
    WORK_MACHINES_CONFIG: file,
    WORK_HETZNER_TOKEN: " hcloud-token ",
  });
  expect(configured.machines?.classes).toEqual(classes);
  expect(configured.hetznerToken).toBe("hcloud-token");
  // A Hetzner class needs the token, which never lives in the file.
  expect(() =>
    workServerConfigFromEnv({ ...env, WORK_MACHINES_CONFIG: file }),
  ).toThrow("WORK_HETZNER_TOKEN");
  for (const invalid of [
    { classes: { Desk: { platform: "pool" } } },
    { classes: { desk: { platform: "pool", serverType: "cpx41" } } },
    { classes: { desk: { platform: "aws" } } },
    { classes: { desk: { ...classes.desk, labels: { "work-machine": "x" } } } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    expect(() =>
      workServerConfigFromEnv({
        ...env,
        WORK_MACHINES_CONFIG: file,
        WORK_HETZNER_TOKEN: "t",
      }),
    ).toThrow(file);
  }
  fs.writeFileSync(file, "{ not json");
  expect(() =>
    workServerConfigFromEnv({ ...env, WORK_MACHINES_CONFIG: file }),
  ).toThrow("not readable JSON");

  // The worker image: the published image's own (where its build says it
  // was published, and which release), or the operator's.
  const published = {
    ...env,
    WORK_IMAGE_REPOSITORY: "ghcr.io/acme/work-server",
    WORK_VERSION: "0.1.0-alpha.18",
  };
  expect(workServerConfigFromEnv(env).workerImage).toBeUndefined();
  expect(workServerConfigFromEnv(published).workerImage).toBe(
    "ghcr.io/acme/work-server:0.1.0-alpha.18",
  );
  // Neither half alone names an image.
  expect(
    workServerConfigFromEnv({ ...env, WORK_VERSION: "0.1.0-alpha.18" })
      .workerImage,
  ).toBeUndefined();
  expect(
    workServerConfigFromEnv({
      ...env,
      WORK_IMAGE_REPOSITORY: "ghcr.io/acme/work-server",
    }).workerImage,
  ).toBeUndefined();
  expect(
    workServerConfigFromEnv({
      ...published,
      WORK_WORKER_IMAGE: "registry.example.com/work:pinned",
    }).workerImage,
  ).toBe("registry.example.com/work:pinned");
});
