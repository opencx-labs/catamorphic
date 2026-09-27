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
