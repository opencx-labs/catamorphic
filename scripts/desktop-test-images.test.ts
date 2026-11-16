import { describe, expect, it } from "vitest";
import {
  DESKTOP_TEST_IMAGE_LABEL,
  type DockerImage,
  staleDesktopTestImages,
} from "./desktop-test-images.js";

const runner = ["bun", "scripts/desktop-test.ts", "--native"];
const now = Date.parse("2026-11-16T12:00:00Z");
const hour = 60 * 60 * 1000;
const image = (overrides: Partial<DockerImage> & { id: string }) => ({
  tags: [],
  labels: {},
  entrypoint: runner,
  createdAt: now - 2 * hour,
  ...overrides,
});

describe("staleDesktopTestImages", () => {
  it("selects the runner's untagged images and those of removed worktrees", () => {
    const exists = (worktree: string) => worktree === "/work/live";
    expect(
      staleDesktopTestImages(
        [
          // Replaced by a rebuild in the same worktree: untagged.
          image({ id: "replaced" }),
          image({
            id: "replaced-labelled",
            labels: { [DESKTOP_TEST_IMAGE_LABEL]: "/work/live" },
          }),
          // The current image of a worktree that still exists.
          image({
            id: "current",
            tags: ["catamorphic-desktop-tests:aaaa"],
            labels: { [DESKTOP_TEST_IMAGE_LABEL]: "/work/live" },
          }),
          // A worktree since removed.
          image({
            id: "orphaned",
            tags: ["catamorphic-desktop-tests:bbbb"],
            labels: { [DESKTOP_TEST_IMAGE_LABEL]: "/work/removed" },
          }),
          // Tagged and from before the label: its worktree is unknown.
          image({ id: "unlabelled", tags: ["catamorphic-desktop-tests:cccc"] }),
          // Not the runner's at all, tagged or not.
          image({ id: "other", entrypoint: ["docker-entrypoint.sh"] }),
          image({ id: "bun-base", entrypoint: ["bun"] }),
          // Just built: another run may be about to start it.
          image({ id: "just-built", createdAt: now - 5 * 60 * 1000 }),
        ],
        { exists, now },
      ),
    ).toEqual(["replaced", "replaced-labelled", "orphaned"]);
  });
});
