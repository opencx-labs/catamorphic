import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Image } from "microsandbox";

const run = promisify(execFile);

/** Builds a project Dockerfile into this machine's image cache (ADR 0176). */
export interface ImageBuilder {
  build(args: { reference: string; dockerfile: string }): Promise<void>;
}

/**
 * Build with the host's Docker (or a Docker-compatible CLI such as Podman)
 * and load the result into microsandbox's image cache. The build context is
 * the Dockerfile alone: images are reviewed as one file, and project files
 * reach the sandbox when its session starts.
 */
export function dockerImageBuilder(options?: {
  /** The CLI to run. Default `docker`; `podman` works the same way. */
  command?: string;
  /** Seconds one build may take. Default 30 minutes. */
  timeoutSeconds?: number;
}): ImageBuilder {
  const command = options?.command ?? "docker";
  const timeout = (options?.timeoutSeconds ?? 30 * 60) * 1000;
  return {
    build: async ({ reference, dockerfile }) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "work-image-"));
      try {
        await writeFile(path.join(directory, "Dockerfile"), dockerfile);
        await run(command, ["build", "-t", reference, directory], {
          timeout,
          maxBuffer: 64 * 1024 * 1024,
        }).catch((error: unknown) => {
          throw new Error(
            `Image build failed: ${error instanceof Error && "stderr" in error ? String(error.stderr).slice(-2000) : String(error)}`,
          );
        });
        const archive = path.join(directory, "image.tar");
        await run(command, ["save", "-o", archive, reference], { timeout });
        await Image.load(archive, { tag: reference });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/**
 * One build per reference at a time on this machine, and none when the
 * image is already cached.
 */
export function cachedImageBuilder(builder: ImageBuilder): ImageBuilder {
  const inFlight = new Map<string, Promise<void>>();
  return {
    build: (args) => {
      const running = inFlight.get(args.reference);
      if (running) return running;
      const build = (async () => {
        const cached = await Image.get(args.reference).catch(() => undefined);
        if (!cached) await builder.build(args);
      })().finally(() => inFlight.delete(args.reference));
      inFlight.set(args.reference, build);
      return build;
    },
  };
}
