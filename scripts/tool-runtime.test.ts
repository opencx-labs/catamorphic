import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toolRuntime } from "./tool-runtime.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "catamorphic-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFakeNode(input: { rootPath: string; version: string }): string {
  const binaryDirectory = path.join(
    input.rootPath,
    "node_modules",
    "node",
    "bin",
  );
  mkdirSync(binaryDirectory, { recursive: true });
  const binaryPath = path.join(binaryDirectory, "node");
  writeFileSync(binaryPath, `#!/bin/sh\nprintf '${input.version}\\n'\n`, {
    mode: 0o755,
  });
  return binaryPath;
}

describe("toolRuntime", () => {
  it("selects repository Node 24.13.0 ahead of an older ambient Node", () => {
    const ambientRoot = temporaryDirectory();
    const ambientNode = writeFakeNode({
      rootPath: ambientRoot,
      version: "v18.20.0",
    });
    const ambientBin = path.dirname(ambientNode);

    const runtime = toolRuntime({
      rootPath: repositoryRoot,
      env: { PATH: `${ambientBin}${path.delimiter}/usr/bin` },
    });

    expect(runtime.nodePath).toBe(
      path.join(repositoryRoot, "node_modules", "node", "bin", "node"),
    );
    expect(runtime.env.PATH).toBe(
      `${path.dirname(runtime.nodePath)}${path.delimiter}${ambientBin}${path.delimiter}/usr/bin`,
    );
    expect(
      execFileSync("node", ["--version"], {
        encoding: "utf8",
        env: runtime.env,
      }).trim(),
    ).toBe("v24.13.0");
  });

  it("rejects a repository Node with a different version", () => {
    const repository = temporaryDirectory();
    writeFakeNode({ rootPath: repository, version: "v24.12.0" });

    expect(() =>
      toolRuntime({ rootPath: repository, env: { PATH: "/usr/bin" } }),
    ).toThrow("Expected repository Node v24.13.0, received v24.12.0");
  });

  it("runs the checked-in Turbo entry point through pinned Node", () => {
    const ambientRoot = temporaryDirectory();
    const ambientNode = writeFakeNode({
      rootPath: ambientRoot,
      version: "v18.20.0",
    });

    expect(
      execFileSync("bun", ["scripts/tool-runtime.ts", "turbo", "--version"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.dirname(ambientNode)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      }).trim(),
    ).toBe("2.10.10");
  });

  it("routes dev infrastructure Turbo through the pinned launcher", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    );
    if (
      typeof packageJson !== "object" ||
      packageJson === null ||
      !("scripts" in packageJson) ||
      typeof packageJson.scripts !== "object" ||
      packageJson.scripts === null ||
      !("dev:infra" in packageJson.scripts)
    ) {
      throw new Error("Root package does not define dev:infra");
    }

    expect(packageJson.scripts["dev:infra"]).toBe(
      "docker compose up -d --wait && bun scripts/tool-runtime.ts turbo dev --filter=@catamorphic/cloudflare-sandbox-bridge",
    );
  });
});
