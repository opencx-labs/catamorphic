import { spawn } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  desktopTestShards,
  desktopVitestArguments,
  includeDesktopTestSource,
  isInstallInput,
} from "./desktop-test.js";
import { isIsolatedDesktopTestHost } from "./desktop-test-environment.js";

describe("desktop test isolation", () => {
  it("keeps each configured shard in a separate Docker invocation without recursive native sharding", () => {
    expect(
      desktopTestShards({ native: false, args: [], configured: "4" }),
    ).toBe(4);
    expect(desktopTestShards({ native: true, args: [], configured: "4" })).toBe(
      1,
    );
    expect(
      desktopTestShards({
        native: false,
        args: ["--shard=2/4"],
        configured: "4",
      }),
    ).toBe(1);
    for (const configured of ["0", "9", "2.5", "invalid"])
      expect(() =>
        desktopTestShards({ native: false, args: [], configured }),
      ).toThrow();
  });
  it("rejects ordinary desktops, including CI flags on a developer Mac", () => {
    for (const env of [
      {},
      { CI: "true" },
      { CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1" },
      { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
    ]) {
      expect(isIsolatedDesktopTestHost({ platform: "darwin", env })).toBe(
        false,
      );
    }
    expect(
      isIsolatedDesktopTestHost({ platform: "linux", env: { DISPLAY: ":0" } }),
    ).toBe(false);
    expect(
      isIsolatedDesktopTestHost({
        platform: "linux",
        env: { DISPLAY: "host:0", CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1" },
      }),
    ).toBe(false);
  });

  it("accepts a private Linux X server and dedicated hosted macOS", () => {
    expect(
      isIsolatedDesktopTestHost({
        platform: "linux",
        env: {
          DISPLAY: ":99",
          CATAMORPHIC_E2E_PRIVATE_DISPLAY: "1",
        },
      }),
    ).toBe(true);
    expect(
      isIsolatedDesktopTestHost({
        platform: "darwin",
        env: {
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
        },
      }),
    ).toBe(true);
  });

  it("excludes credentials, host dependencies, and generated output from the snapshot", () => {
    for (const file of [
      ".env",
      ".env.local",
      "apps/desktop/.env",
      "key.p8",
      "signing.p12",
      ".git",
      "packages/core/node_modules/x/index.js",
      "apps/desktop/out/main.js",
      "packages/app/dist/index.js",
      "test-results/log.txt",
      ".claude/settings.local.json",
    ]) {
      expect(includeDesktopTestSource(file), file).toBe(false);
    }
    for (const file of [
      "bun.lock",
      "package.json",
      "packages/core/package.json",
      "apps/desktop/e2e/new.e2e.ts",
      "packages/core/src/new.ts",
    ]) {
      expect(includeDesktopTestSource(file), file).toBe(true);
    }
  });

  it("preserves file filters and shard selection through the pinned Node entrypoint", () => {
    const args = desktopVitestArguments({
      args: ["window-state", "--shard=2/8"],
      artifacts: "/tmp/results",
    });
    expect(args.slice(0, 4)).toEqual([
      "scripts/tool-runtime.ts",
      "vitest",
      "--tool-cwd",
      "apps/desktop",
    ]);
    expect(args.slice(-2)).toEqual(["window-state", "--shard=2/8"]);
    expect(args).toContain("--outputFile.junit=/tmp/results/junit.xml");
  });
});

describe("desktop test image dependencies", () => {
  it("install from the manifests, the lockfile and every overridden stand-in", () => {
    const manifest: { overrides: Record<string, string> } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const local = Object.values(manifest.overrides)
      .filter((spec) => spec.startsWith("file:./"))
      .map((spec) => `${spec.slice("file:./".length)}/package.json`);
    expect(local.length).toBeGreaterThan(0);
    for (const file of [
      "bun.lock",
      "package.json",
      "packages/core/package.json",
      "apps/desktop/package.json",
      ...local,
    ])
      expect(isInstallInput(file), file).toBe(true);
    expect(isInstallInput("packages/core/src/index.ts")).toBe(false);
    expect(isInstallInput("packages/core/node_modules/x/package.json")).toBe(
      false,
    );
  });
});

for (const duringStartup of [false, true])
  it(`cleans owned containers when cancelled ${duringStartup ? "during startup" : "after launch"}`, async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-shard-cancel-"),
    );
    const binary = path.join(temporary, "bin");
    const markers = path.join(temporary, "containers");
    const preparing = path.join(temporary, "preparing");
    const trace = path.join(temporary, "docker.jsonl");
    const preload = path.join(temporary, "delay-setup.mjs");
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const mkdir=fs.promises.mkdir;
fs.promises.mkdir=async(...args)=>{if(String(args[0]).endsWith('/shard-2')){fs.writeFileSync(${JSON.stringify(preparing)},'waiting');await new Promise(resolve=>setTimeout(resolve,1000));}return mkdir(...args)};
syncBuiltinESMExports();`,
    );
    fs.mkdirSync(binary);
    fs.mkdirSync(markers);
    fs.writeFileSync(
      path.join(binary, "docker"),
      `#!/usr/bin/env bun
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), markers=${JSON.stringify(markers)};
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
if(args[0]==='build'){fs.writeFileSync(args[args.indexOf('--iidfile')+1],'sha256:fixture');}
else if(args[0]==='run'){fs.writeFileSync(path.join(markers,args[args.indexOf('--name')+1]),'running');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);}
else if(args[0]==='rm'){for(const name of args.slice(2))fs.rmSync(path.join(markers,name),{force:true});}
else if(args[0]==='image')console.log('1000');
`,
      { mode: 0o755 },
    );
    const child = spawn(
      "bun",
      [
        ...(duringStartup ? ["--preload", preload] : []),
        path.join(import.meta.dirname, "desktop-test.ts"),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        detached: true,
        env: {
          ...process.env,
          PATH: `${binary}${path.delimiter}${process.env.PATH ?? ""}`,
          CATAMORPHIC_DESKTOP_TEST_SHARDS: "4",
          CATAMORPHIC_E2E_ARTIFACTS_DIR: path.join(temporary, "artifacts"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      await vi.waitFor(
        () =>
          duringStartup
            ? expect(fs.existsSync(preparing)).toBe(true)
            : expect(fs.readdirSync(markers)).toHaveLength(4),
        {
          timeout: 20_000,
          interval: 25,
        },
      );
      child.kill("SIGTERM");
      await vi.waitFor(
        () =>
          expect(
            child.exitCode !== null || child.signalCode !== null,
            stderr,
          ).toBe(true),
        { timeout: 12_000, interval: 25 },
      );
      expect(await exited).not.toBe(0);
      if (duringStartup) {
        const calls: string[][] = fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          calls
            .filter((call) => call[0] === "run")
            .some((call) =>
              call.some((argument) => argument.endsWith("-shard-2")),
            ),
        ).toBe(false);
      }
      expect(fs.readdirSync(markers), stderr).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);
