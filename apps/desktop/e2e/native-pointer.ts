import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertIsolatedDesktopTestHost } from "../../../scripts/desktop-test-environment.js";

/** CDP moves Chromium's pointer, but native hover reads the OS cursor. */
export async function moveNativePointer(point: { x: number; y: number }) {
  assertIsolatedDesktopTestHost();
  const coordinates = [Math.round(point.x), Math.round(point.y)].map(String);
  if (process.platform === "linux") {
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
