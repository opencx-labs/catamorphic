import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCliError } from "./cli-error.js";
import { assertIsolatedDesktopTestHost } from "./desktop-test-environment.js";
import { runLoggedProcess, TestSignalController } from "./test.js";

const root = path.resolve(import.meta.dirname, "..");

/** Copy source, including uncommitted work, without local state or secrets. */
export function includeDesktopTestSource(file: string): boolean {
  return !file
    .split("/")
    .some(
      (part) =>
        [
          ".git",
          "node_modules",
          "dist",
          "out",
          ".turbo",
          "test-results",
          ".claude",
          ".codex",
          ".npmrc",
          ".netrc",
          ".pypirc",
        ].includes(part) ||
        part === ".env" ||
        part.startsWith(".env.") ||
        /\.(pem|key|p12|p8)$/.test(part),
    );
}

export function desktopVitestArguments(input: {
  args: readonly string[];
  artifacts: string;
}): string[] {
  return [
    "scripts/tool-runtime.ts",
    "vitest",
    "--tool-cwd",
    "apps/desktop",
    "--config",
    "./vitest.e2e.config.ts",
    "--reporter=default",
    "--reporter=junit",
    `--outputFile.junit=${path.join(input.artifacts, "junit.xml")}`,
    ...input.args,
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const native = args[0] === "--native";
  if (native) args.shift();
  // Native execution is reserved for Linux's private display and hosted macOS.
  // Ordinary invocations always enter Docker, including on a Linux workstation.
  if (native && process.platform !== "linux") assertIsolatedDesktopTestHost();
  const artifacts =
    process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ??
    path.join(root, "test-results", `desktop-${randomUUID()}`);
  await mkdir(artifacts, { recursive: true });
  const signals = new TestSignalController();
  const container = `catamorphic-desktop-test-${randomUUID()}`;
  const context = native
    ? undefined
    : await mkdtemp(path.join(tmpdir(), "ct-desktop-"));
  let step = 0;
  const run = async (
    command: string,
    commandArgs: string[],
    env = process.env,
  ) => {
    const result = await runLoggedProcess({
      command,
      args: commandArgs,
      cwd: root,
      env,
      signals,
      logPath: path.join(artifacts, `${++step}-${path.basename(command)}.log`),
    });
    if (result.code !== 0)
      throw new Error(`${command} exited with code ${result.code}`);
  };
  try {
    if (native) {
      const vitestArgs = desktopVitestArguments({ args, artifacts });
      const env = { ...process.env, CATAMORPHIC_E2E_ARTIFACTS_DIR: artifacts };
      if (process.platform === "linux") {
        // Own the X server and window manager lifecycle; never use the host DISPLAY.
        await run(
          "xvfb-run",
          [
            "-a",
            "--server-args=-screen 0 1440x900x24 -nolisten tcp",
            "bash",
            path.join(root, "scripts/desktop-test-display.sh"),
            "bun",
            ...vitestArgs,
          ],
          env,
        );
      } else {
        await run("bun", vitestArgs, env);
      }
    } else if (context) {
      const files = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
        .split("\0")
        .filter(Boolean)
        .filter(includeDesktopTestSource);
      for (const file of new Set(files)) {
        const source = path.join(root, file);
        const stat = await lstat(source).catch(() => undefined);
        if (!stat?.isFile()) continue;
        const destination = path.join(context, "source", file);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination);
        if (
          file === "bun.lock" ||
          file === "package.json" ||
          /^(packages|apps)\/[^/]+\/package.json$/.test(file)
        ) {
          const manifest = path.join(context, "manifests", file);
          await mkdir(path.dirname(manifest), { recursive: true });
          await cp(source, manifest);
        }
      }
      // The image tag is worktree-specific; Docker's content-addressed layers
      // still share dependencies across worktrees, without sharing mutable data.
      const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
      const image = `catamorphic-desktop-tests:${key}`;
      await cp(
        path.join(root, "infra/desktop-tests/Dockerfile"),
        path.join(context, "Dockerfile"),
      );
      await run("docker", ["build", "--tag", image, context]);
      await run("docker", [
        "run",
        "--rm",
        "--init",
        "--name",
        container,
        "--shm-size=1g",
        "--mount",
        `type=bind,source=${artifacts},target=/artifacts`,
        image,
        ...args,
      ]);
      const inspect = execFileSync(
        "docker",
        ["image", "inspect", image, "--format", "{{.Size}}"],
        { encoding: "utf8" },
      );
      console.log(
        `Desktop test image: ${(Number(inspect) / 1024 ** 3).toFixed(2)} GiB uncompressed (cached)`,
      );
    }
  } finally {
    if (!native)
      spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
    signals.close();
    if (context) await rm(context, { recursive: true, force: true });
    console.log(`Desktop test diagnostics: ${artifacts}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    writeCliError(error);
    process.exitCode = 1;
  });
}
