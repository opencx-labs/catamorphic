import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildPackagePayload } from "./build-package-payload.js";

it("retains the exact runtime and types in JavaScript even when packaging drops declaration files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-payload-"));
  try {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@test/sdk", version: "1.0.0" }),
    );
    await fs.writeFile(
      path.join(root, "dist/index.js"),
      "export const value = 1;",
    );
    await fs.writeFile(
      path.join(root, "dist/index.d.ts"),
      "export declare const value: 1;",
    );
    const payload = await buildPackagePayload({ root });
    await fs.rm(path.join(root, "dist/index.d.ts"));
    const source = await fs.readFile(
      path.join(root, "dist/package-payload.js"),
      "utf8",
    );
    expect(source).toContain("export declare const value: 1;");
    const installed = await import(path.join(root, "dist/package-payload.js"));
    expect(installed.default).toEqual(payload);
    expect(payload.files["dist/index.js"]).toBe("export const value = 1;");
    await fs.writeFile(
      path.join(root, "dist/index.d.ts"),
      "export declare const value: 2;",
    );
    const next = await buildPackagePayload({ root });
    expect(next.files["dist/package-payload.js"]).toBeUndefined();
    expect(next.files["dist/index.d.ts"]).toContain("value: 2");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
