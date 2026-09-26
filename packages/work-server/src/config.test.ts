import { expect, it } from "vitest";
import { workServerConfigFromEnv } from "./config.js";

it("reads the webhook body maximum and rejects values the server cannot honor", () => {
  expect(workServerConfigFromEnv({}).webhookMaxBodyBytes).toBeUndefined();
  expect(
    workServerConfigFromEnv({ WORK_WEBHOOK_MAX_BYTES: "4194304" })
      .webhookMaxBodyBytes,
  ).toBe(4_194_304);
  for (const value of ["0", "1.5", "lots", String(64 * 1024 * 1024 + 1)]) {
    expect(() =>
      workServerConfigFromEnv({ WORK_WEBHOOK_MAX_BYTES: value }),
    ).toThrow("WORK_WEBHOOK_MAX_BYTES");
  }
});
