import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCliError } from "./cli-error.js";
import { assertIsolatedDesktopTestHost } from "./desktop-test-environment.js";
import { runLoggedProcess, TestSignalController } from "./test.js";
import {
  removeTestDirectory,
  withTestProcessCleanup,
} from "./test-processes.js";

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

/**
 * What `bun install` reads: the image's dependency layer holds only these,
 * so it stays cached across source edits. `vendor/` holds the stand-ins the
 * root overrides install (`file:./vendor/...`).
 */
export function isInstallInput(file: string): boolean {
  return (
    file === "bun.lock" ||
    file === "package.json" ||
    /^(packages|apps)\/[^/]+\/package.json$/.test(file) ||
    file.startsWith("vendor/")
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

/** Each shard owns its Docker desktop; native and explicitly sharded runs stay single. */
export function desktopTestShards(input: {
  native: boolean;
  args: readonly string[];
  configured?: string;
}): number {
  if (input.native || input.args.some((arg) => arg.startsWith("--shard")))
    return 1;
  const count = Number(input.configured ?? "1");
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw new Error(
      "CATAMORPHIC_DESKTOP_TEST_SHARDS must be an integer from 1 to 8.",
    );
  return count;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const native = args[0] === "--native";
  if (native) args.shift();
  const shards = desktopTestShards({
    native,
    args,
    configured: process.env.CATAMORPHIC_DESKTOP_TEST_SHARDS,
  });
  // Native execution is reserved for Linux's private display and hosted macOS.
  // Ordinary invocations always enter Docker, including on a Linux workstation.
  if (native && process.platform !== "linux") assertIsolatedDesktopTestHost();
  const artifacts = path.resolve(
    root,
    process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ??
      path.join("test-results", `desktop-${randomUUID()}`),
  );
  await mkdir(artifacts, { recursive: true });
  // The container's unprivileged user writes diagnostics here, whatever this
  // host user's id is.
  if (!native) await chmod(artifacts, 0o777);
  const signals = new TestSignalController();
  const batch = `catamorphic-desktop-test-${randomUUID()}`;
  const containers = Array.from({ length: shards }, (_, index) =>
    shards === 1 ? batch : `${batch}-shard-${index + 1}`,
  );
  // macOS allows only 103 path bytes plus the terminator for a Unix socket.
  // Chromium adds its own temporary directory and SingletonSocket suffix.
  const context = await mkdtemp(path.join(tmpdir(), "d"));
  let succeeded = false;
  let step = 0;
  const run = async (
    command: string,
    commandArgs: string[],
    env = process.env,
    controller = signals,
  ) => {
    const result = await runLoggedProcess({
      command,
      args: commandArgs,
      cwd: root,
      env,
      signals: controller,
      temporaryRoot: context,
      logPath: path.join(artifacts, `${++step}-${path.basename(command)}.log`),
    });
    if (result.code !== 0)
      throw new Error(`${command} exited with code ${result.code}`);
  };
  try {
    await withTestProcessCleanup(context, async () => {
      if (native) {
        const vitestArgs = desktopVitestArguments({ args, artifacts });
        const env = {
          ...process.env,
          TMPDIR: context,
          TMP: context,
          TEMP: context,
          CATAMORPHIC_E2E_ARTIFACTS_DIR: artifacts,
        };
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
          if (isInstallInput(file)) {
            const manifest = path.join(context, "manifests", file);
            await mkdir(path.dirname(manifest), { recursive: true });
            await cp(source, manifest);
          }
        }
        // The image tag is worktree-specific; Docker's content-addressed layers
        // still share dependencies across worktrees, without sharing mutable data.
        const key = createHash("sha256")
          .update(root)
          .digest("hex")
          .slice(0, 12);
        const image = `catamorphic-desktop-tests:${key}`;
        await cp(
          path.join(root, "infra/desktop-tests/Dockerfile"),
          path.join(context, "Dockerfile"),
        );
        const imageFile = path.join(context, "image-id");
        await run("docker", [
          "build",
          "--tag",
          image,
          "--iidfile",
          imageFile,
          context,
        ]);
        // Another invocation can replace the cache tag after this build finishes.
        // Run this invocation's immutable image, never whatever the tag names later.
        const imageId = (await readFile(imageFile, "utf8")).trim();
        // Opt-in: installed speech models for the real-model voice suite
        // (ADR 0216), mounted read-only so the image never carries them.
        const voiceModels = process.env.CATAMORPHIC_VOICE_MODELS_DIR;
        // Opt-in: the external-test authority, for the live Google sign-in
        // check (e2e/google-sign-in.e2e.ts). It never rides in by default.
        const external = process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1";
        const outcomes = await Promise.allSettled(
          containers.map(async (_container, index) => {
            const shardArtifacts =
              shards === 1
                ? artifacts
                : path.join(artifacts, `shard-${index + 1}`);
            await mkdir(shardArtifacts, { recursive: true });
            await chmod(shardArtifacts, 0o777);
            // Cancellation may precede this shard's listener while directory
            // setup awaits. The root retains that signal for later launches.
            if (signals.signal) throw new Error("Desktop tests interrupted.");
            const controller =
              shards === 1 ? signals : new TestSignalController();
            try {
              await run(
                "docker",
                [
                  "run",
                  "--rm",
                  "--init",
                  "--name",
                  containers[index] ?? batch,
                  "--shm-size=1g",
                  "--mount",
                  `type=bind,source=${shardArtifacts},target=/artifacts`,
                  ...(voiceModels
                    ? [
                        "--mount",
                        `type=bind,source=${path.resolve(voiceModels)},target=/voice-models,readonly`,
                        "--env",
                        "CATAMORPHIC_VOICE_MODELS_DIR=/voice-models",
                      ]
                    : []),
                  ...(external
                    ? ["--env", "CATAMORPHIC_EXTERNAL_INTEGRATIONS=1"]
                    : []),
                  imageId,
                  ...args,
                  ...(shards > 1 ? [`--shard=${index + 1}/${shards}`] : []),
                ],
                process.env,
                controller,
              );
            } finally {
              if (controller !== signals) controller.close();
            }
          }),
        );
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Desktop test shards failed.");
        const inspect = execFileSync(
          "docker",
          ["image", "inspect", imageId, "--format", "{{.Size}}"],
          { encoding: "utf8" },
        );
        console.log(
          `Desktop test image: ${(Number(inspect) / 1024 ** 3).toFixed(2)} GiB uncompressed (cached)`,
        );
      }
    });
    succeeded = true;
  } finally {
    if (!native)
      for (const container of containers)
        spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
    signals.close();
    console.log(`Desktop test diagnostics: ${artifacts}`);
    if (succeeded) await removeTestDirectory(context);
    else console.error(`Desktop test temporary files preserved at ${context}`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    writeCliError(error);
    process.exitCode = 1;
  });
}
