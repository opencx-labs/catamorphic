import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
});
afterAll(async () => {
  await app?.stop();
});

describe("browser import IPC", () => {
  it("exposes platform capability from the main process", async () => {
    const support = await app.eval<{
      available: boolean;
      reason: string | null;
    }>("window.catamorphicDesktop.browserImportSupport()");
    expect(support.available).toBe(process.platform === "darwin");
    expect(support.reason).toBe(
      process.platform === "darwin" ? null : expect.any(String),
    );
  });
  it("rejects unrecognized source profiles before opening Keychain", async () => {
    const error = await app.eval<string>(
      `window.catamorphicDesktop.browserImportNativePasswords({ browserId: "unknown-browser", profileId: "../../outside" }).then(() => "unexpected success", e => e.message)`,
    );
    expect(error).toMatch(
      process.platform === "darwin" ? /no longer available/ : /requires macOS/,
    );
  });
});
