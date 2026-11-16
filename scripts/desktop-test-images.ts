import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Names the worktree an image was built from (see `docker build --label`). */
export const DESKTOP_TEST_IMAGE_LABEL =
  "org.catamorphic.desktop-tests.worktree";

/** The runner's entrypoint, which identifies images built before the label. */
const DESKTOP_TEST_ENTRYPOINT = ["bun", "scripts/desktop-test.ts", "--native"];

/** Free space Docker's disk keeps for a build; below it, unused cache goes. */
const MIN_FREE_SPACE = "10GB";

export interface DockerImage {
  id: string;
  tags: string[];
  labels: Record<string, string>;
  entrypoint: string[];
}

/**
 * This runner's images that nothing will run again: untagged ones (a rebuild
 * in the same worktree took their tag) and ones from worktrees that no longer
 * exist. Each worktree rebuilt a 4 GB image per change, and every replaced
 * one stayed until Docker's disk filled.
 */
export function staleDesktopTestImages(
  images: readonly DockerImage[],
  input: { exists?: (path: string) => boolean } = {},
): string[] {
  const exists = input.exists ?? existsSync;
  return images
    .filter((image) => {
      const worktree = image.labels[DESKTOP_TEST_IMAGE_LABEL];
      const ours =
        worktree !== undefined ||
        (image.entrypoint.length === DESKTOP_TEST_ENTRYPOINT.length &&
          image.entrypoint.every(
            (part, index) => part === DESKTOP_TEST_ENTRYPOINT[index],
          ));
      if (!ours) return false;
      return (
        image.tags.length === 0 || (worktree !== undefined && !exists(worktree))
      );
    })
    .map((image) => image.id);
}

/**
 * Removes stale desktop test images and, when Docker's disk runs low, build
 * cache no image uses. Never forced: an image a running test still uses
 * stays. Best effort: a failure here never fails a test run.
 */
export function removeStaleDesktopTestImages(): void {
  try {
    const ids = execFileSync(
      "docker",
      ["images", "--all", "--quiet", "--no-trunc"],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter(Boolean);
    if (ids.length > 0) {
      const inspected: unknown = JSON.parse(
        execFileSync("docker", ["image", "inspect", ...new Set(ids)], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      const stale = staleDesktopTestImages(
        Array.isArray(inspected) ? inspected.flatMap(dockerImage) : [],
      );
      let removed = 0;
      for (const id of stale)
        if (
          spawnSync("docker", ["image", "rm", id], { stdio: "ignore" })
            .status === 0
        )
          removed += 1;
      if (removed > 0)
        console.log(`Removed ${removed} stale desktop test images`);
    }
    spawnSync(
      "docker",
      ["builder", "prune", "--force", "--min-free-space", MIN_FREE_SPACE],
      { stdio: "ignore" },
    );
  } catch (error) {
    console.warn(
      `Stale desktop test images were not removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function dockerImage(value: unknown): DockerImage[] {
  if (!isRecord(value) || typeof value.Id !== "string") return [];
  const config = isRecord(value.Config) ? value.Config : {};
  const labels = isRecord(config.Labels) ? config.Labels : {};
  return [
    {
      id: value.Id,
      tags: Array.isArray(value.RepoTags)
        ? value.RepoTags.filter((tag): tag is string => typeof tag === "string")
        : [],
      labels: Object.fromEntries(
        Object.entries(labels).flatMap(([key, label]) =>
          typeof label === "string" ? [[key, label]] : [],
        ),
      ),
      entrypoint: Array.isArray(config.Entrypoint)
        ? config.Entrypoint.filter(
            (part): part is string => typeof part === "string",
          )
        : [],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
