import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginsPreamble,
  stagePluginDocs,
} from "../coding-agent/plugin-staging.js";

describe("buildPluginsPreamble", () => {
  it("returns empty string when no plugins are attached", () => {
    expect(buildPluginsPreamble()).toBe("");
    expect(buildPluginsPreamble([])).toBe("");
  });

  it("lists each plugin with its staged doc paths", () => {
    const preamble = buildPluginsPreamble([
      {
        packageName: "@opencx/workflow-sdk",
        displayName: "OpenCX",
        description: "OpenCX triggers and actions.",
        files: {
          "README.md": "# OpenCX",
          "dist/index.d.ts": "export {};",
        },
      },
    ]);
    expect(preamble).toContain("Attached packages");
    expect(preamble).toContain("@opencx/workflow-sdk (OpenCX)");
    expect(preamble).toContain("OpenCX triggers and actions.");
    expect(preamble).toContain("_plugins/opencx__workflow-sdk/README.md");
    expect(preamble).toContain("_plugins/opencx__workflow-sdk/dist/index.d.ts");
  });
});

describe("stagePluginDocs", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes plugin files under _plugins/<slug>/", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-stage-"));
    await stagePluginDocs(tmpDir, [
      {
        packageName: "@opencx/workflow-sdk",
        displayName: "OpenCX",
        description: "",
        files: {
          "README.md": "# Hi",
          "dist/index.d.ts": "export const x: number;",
        },
      },
    ]);
    const readme = await fs.readFile(
      path.join(tmpDir, "_plugins", "opencx__workflow-sdk", "README.md"),
      "utf-8",
    );
    expect(readme).toBe("# Hi");
    const types = await fs.readFile(
      path.join(
        tmpDir,
        "_plugins",
        "opencx__workflow-sdk",
        "dist",
        "index.d.ts",
      ),
      "utf-8",
    );
    expect(types).toContain("number");
  });

  it("is a no-op when no plugins are passed", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-stage-empty-"));
    await stagePluginDocs(tmpDir, undefined);
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual([]);
  });
});
