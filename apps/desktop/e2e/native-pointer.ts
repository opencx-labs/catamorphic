import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { assertIsolatedDesktopTestHost } from "../../../scripts/desktop-test-environment.js";

export interface NativeDisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Quartz's actual click surface, rather than a possibly off-screen viewport. */
export async function readNativeMacDisplays(): Promise<NativeDisplayBounds[]> {
  assertIsolatedDesktopTestHost();
  if (process.platform !== "darwin")
    throw new Error("Quartz displays require a dedicated macOS test runner");
  const { stdout } = await promisify(execFile)(
    "python3",
    [path.join(import.meta.dirname, "native-pointer-macos.py"), "--displays"],
    { timeout: 10_000 },
  );
  return z
    .array(
      z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      }),
    )
    .nonempty()
    .parse(JSON.parse(stdout));
}

/**
 * Move through several points in one gesture, as a hand crossing an edge
 * does: one xdotool or helper run emits the moves back to back, so the app
 * sees the last move inside a window just before the pointer leaves it
 * (separate runs leave process-spawn gaps a loaded host stretches).
 */
export async function moveNativePointerThrough(
  points: readonly { x: number; y: number }[],
) {
  assertIsolatedDesktopTestHost();
  const coordinates = points.flatMap((point) => [
    String(Math.round(point.x)),
    String(Math.round(point.y)),
  ]);
  if (process.platform !== "linux") {
    await promisify(execFile)(
      "python3",
      [
        path.join(import.meta.dirname, "native-pointer-macos.py"),
        ...coordinates,
      ],
      { timeout: 10_000 },
    );
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

/** macOS virtual key codes the native tests press. */
export const MAC_KEY_CODES = { grave: 50, v: 9, w: 13 } as const;

/**
 * A real key press on the macOS test desktop, through AppKit and the
 * system's shortcuts (Cmd+` going between windows), not the web page.
 */
export async function pressNativeMacKey(
  key: keyof typeof MAC_KEY_CODES,
  modifiers: readonly ("command" | "shift" | "option" | "control")[] = [],
) {
  assertIsolatedDesktopTestHost();
  if (process.platform !== "darwin")
    throw new Error("Native key presses run on the macOS test desktop only");
  await promisify(execFile)(
    "python3",
    [
      path.join(import.meta.dirname, "native-keys-macos.py"),
      String(MAC_KEY_CODES[key]),
      ...modifiers,
    ],
    { timeout: 10_000 },
  );
}
