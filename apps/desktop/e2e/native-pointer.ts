import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertIsolatedDesktopTestHost } from "../../../scripts/desktop-test-environment.js";

/**
 * Move through several points in one gesture, as a hand crossing an edge
 * does: on Linux one xdotool run emits the moves back to back, so the app
 * sees the last move inside a window just before the pointer leaves it
 * (separate runs leave process-spawn gaps a loaded host stretches).
 */
export async function moveNativePointerThrough(
  points: readonly { x: number; y: number }[],
) {
  assertIsolatedDesktopTestHost();
  if (process.platform !== "linux") {
    for (const point of points) await moveNativePointer(point);
    return;
  }
  const args = points.flatMap((point) => [
    "mousemove",
    String(Math.round(point.x)),
    String(Math.round(point.y)),
  ]);
  await promisify(execFile)("xdotool", args, { timeout: 10_000 });
}

/** CDP moves Chromium's pointer, but native hover reads the OS cursor. */
export async function moveNativePointer(point: { x: number; y: number }) {
  assertIsolatedDesktopTestHost();
  const coordinates = [Math.round(point.x), Math.round(point.y)].map(String);
  if (process.platform === "linux") {
    const { stdout } = await promisify(execFile)(
      "xdotool",
      ["getmouselocation", "--shell"],
      { timeout: 10_000 },
    );
    // --sync waits for an actual move, and hangs when already at the target.
    if (
      /^X=(\d+)$/m.exec(stdout)?.[1] === coordinates[0] &&
      /^Y=(\d+)$/m.exec(stdout)?.[1] === coordinates[1]
    )
      return;
    await promisify(execFile)(
      "xdotool",
      ["mousemove", "--sync", ...coordinates],
      {
        timeout: 10_000,
      },
    );
  } else {
    await promisify(execFile)(
      "python3",
      [
        path.join(import.meta.dirname, "native-pointer-macos.py"),
        ...coordinates,
      ],
      { timeout: 10_000 },
    );
  }
}

/** A real click at the current pointer position (the OS decides the window). */
export async function clickNativePointer(point: { x: number; y: number }) {
  assertIsolatedDesktopTestHost();
  const coordinates = [Math.round(point.x), Math.round(point.y)].map(String);
  if (process.platform === "linux") {
    // The move handles a pointer that is already there (--sync would hang).
    await moveNativePointer(point);
    await promisify(execFile)("xdotool", ["click", "1"], { timeout: 10_000 });
  } else {
    await promisify(execFile)(
      "python3",
      [
        path.join(import.meta.dirname, "native-pointer-macos.py"),
        ...coordinates,
        "click",
      ],
      { timeout: 10_000 },
    );
  }
}
