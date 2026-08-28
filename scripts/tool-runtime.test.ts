import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function packageScripts(relativePath: string): Record<string, string> {
  const packageJson: unknown = JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("scripts" in packageJson) ||
    typeof packageJson.scripts !== "object" ||
    packageJson.scripts === null
  ) {
    throw new Error(`${relativePath} does not define scripts`);
  }
  return Object.fromEntries(
    Object.entries(packageJson.scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function workspacePackagePaths(): string[] {
  return ["apps", "packages"].flatMap((parent) =>
    readdirSync(path.join(repositoryRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const relativePath = `${parent}/${entry.name}`;
        return readFileSync(
          path.join(repositoryRoot, relativePath, "package.json"),
          "utf8",
        )
          ? [relativePath]
          : [];
      }),
  );
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

  it("routes explicit external tests through pinned Turbo", () => {
    expect(packageScripts("package.json")["test:external"]).toBe(
      "CATAMORPHIC_EXTERNAL_INTEGRATIONS=1 bun scripts/tool-runtime.ts turbo run test --no-daemon --concurrency=2 --filter=@catamorphic/daytona --filter=@catamorphic/s3 --filter=@catamorphic/cloudflare",
    );
  });

  it("defines dedicated root script test and typecheck commands", () => {
    const scripts = packageScripts("package.json");

    expect(scripts["test:scripts"]).toBe(
      "bun scripts/tool-runtime.ts vitest --config ./vitest.config.ts scripts",
    );
    expect(scripts["typecheck:scripts"]).toBe(
      "tsgo --project ./tsconfig.scripts.json",
    );
  });

  it("bounds every package-script test graph to two Turbo tasks", () => {
    const scripts = packageScripts("package.json");

    expect(
      ["test:workspace", "test:external"].map((name) =>
        scripts[name]?.match(/--concurrency=[0-9]+/)?.at(0),
      ),
    ).toEqual(["--concurrency=2", "--concurrency=2"]);
  });

  it("routes every desktop and PWA E2E Vitest entry point through pinned Node", () => {
    const desktopScripts = packageScripts("apps/desktop/package.json");
    const pwaScripts = packageScripts("apps/pwa/package.json");

    expect(desktopScripts["test:e2e"]).toBe(
      "bun --bun electron-vite build && CATAMORPHIC_E2E_WINDOW_MODE=hidden bun ../../scripts/tool-runtime.ts vitest --tool-cwd apps/desktop --config ./vitest.e2e.config.ts",
    );
    expect(desktopScripts["test:e2e:visible"]).toBe(
      "bun --bun electron-vite build && CATAMORPHIC_E2E_WINDOW_MODE=visible bun ../../scripts/tool-runtime.ts vitest --tool-cwd apps/desktop --config ./vitest.e2e.config.ts",
    );
    expect(desktopScripts["test:eval"]).toBe(
      "bun --bun electron-vite build && CATAMORPHIC_E2E_WINDOW_MODE=hidden bun ../../scripts/tool-runtime.ts vitest --tool-cwd apps/desktop --config ./vitest.eval.config.ts",
    );
    expect(pwaScripts["test:e2e"]).toBe(
      "bun --bun vite build && bun ../../scripts/tool-runtime.ts vitest --tool-cwd apps/pwa --config ./vitest.e2e.config.ts",
    );
  });

  it("routes every workspace-local Vitest command through the pinned launcher and its package cwd", () => {
    const vitestCommands = workspacePackagePaths().flatMap((packagePath) =>
      Object.entries(packageScripts(`${packagePath}/package.json`)).flatMap(
        ([scriptName, command]) =>
          command.includes("vitest")
            ? [{ packagePath, scriptName, command }]
            : [],
      ),
    );

    expect(vitestCommands.length).toBeGreaterThan(0);
    for (const command of vitestCommands) {
      expect(
        command.command,
        `${command.packagePath} ${command.scriptName}`,
      ).toContain(
        `bun ../../scripts/tool-runtime.ts vitest --tool-cwd ${command.packagePath}`,
      );
    }
  });
});
