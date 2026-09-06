import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPushTransport } from "./web-push.js";

const directories: string[] = [];
function dataDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-push-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
describe("host Web Push keys", () => {
  it("keeps the same private key across restarts with owner-only permissions", () => {
    const directory = dataDir();
    const first = createPushTransport({ dataDir: directory });
    expect(createPushTransport({ dataDir: directory }).publicKey).toBe(
      first.publicKey,
    );
    if (process.platform !== "win32")
      expect(
        fs.statSync(path.join(directory, "web-push-vapid.json")).mode & 0o777,
      ).toBe(0o600);
  });
  it("rejects malformed stored keys without replacing them or recursing", () => {
    const directory = dataDir();
    const file = path.join(directory, "web-push-vapid.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    expect(() => createPushTransport({ dataDir: directory })).toThrow(
      "Stored Web Push signing keys are invalid",
    );
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });
});
