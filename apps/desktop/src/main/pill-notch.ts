import { execFile } from "node:child_process";
import type { Display } from "electron";
import {
  guessNotch,
  type NotchReport,
  notchFromReport,
  type PillNotch,
} from "../shared/pill-geometry.js";

/**
 * Each display's camera cutout as AppKit reports it (ADR 0242): the menu
 * bar's areas either side of it, read with JavaScript for Automation, so
 * no native module is needed. `NSScreenNumber` is Electron's display id.
 */
const SCRIPT = `ObjC.import("AppKit");
const out = [];
const screens = $.NSScreen.screens;
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const rect = (r) => [r.origin.x, r.origin.y, r.size.width, r.size.height];
  out.push({
    id: ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")),
    frame: rect(s.frame),
    left: rect(s.auxiliaryTopLeftArea),
    right: rect(s.auxiliaryTopRightArea),
    top: s.safeAreaInsets.top,
  });
}
JSON.stringify(out);`;

const PROBE_TIMEOUT_MS = 4_000;

function isRect(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part))
  );
}

/** A probe's output, keeping only well-formed reports. */
export function parseNotchReports(stdout: string): NotchReport[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): NotchReport[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, frame, left, right, top } = entry as Record<string, unknown>;
    if (
      typeof id !== "number" ||
      !isRect(frame) ||
      !isRect(left) ||
      !isRect(right) ||
      typeof top !== "number"
    )
      return [];
    return [{ id, frame, left, right, top }];
  });
}

/**
 * The notches of this computer's displays, refreshed on demand (display
 * changes, waking). Until a probe answers, and off macOS, an internal
 * display with a tall menu bar counts as notched (`guessNotch`). A
 * full-screen Space reports no safe area: a display that had a cutout keeps
 * it, since the hardware has not changed.
 */
export class PillNotches {
  private readonly known = new Map<number, PillNotch | null>();
  private probing: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly options: {
      platform: NodeJS.Platform;
      /** Runs the probe; tests and other platforms replace it. */
      run?: (script: string) => Promise<string>;
      onChange: () => void;
    },
  ) {}

  notchFor(
    display: Pick<Display, "id" | "internal" | "bounds" | "workArea">,
  ): PillNotch | null {
    if (this.options.platform !== "darwin") return null;
    const known = this.known.get(display.id);
    return known !== undefined ? known : guessNotch(display);
  }

  /** Reads every display again; overlapping calls coalesce into one more. */
  refresh(): Promise<void> {
    if (this.options.platform !== "darwin") return Promise.resolve();
    if (this.probing) {
      this.again = true;
      return this.probing;
    }
    const run = this.options.run ?? runJxa;
    this.probing = run(SCRIPT)
      .then((stdout) => this.apply(parseNotchReports(stdout)))
      .catch(() => {})
      .finally(() => {
        this.probing = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.probing;
  }

  private apply(reports: readonly NotchReport[]) {
    let changed = false;
    for (const report of reports) {
      const next = notchFromReport(report);
      const previous = this.known.get(report.id);
      // No safe area at all is a full-screen Space, not new hardware.
      if (!next && report.top <= 0 && previous) continue;
      if (
        previous === undefined ||
        JSON.stringify(previous) !== JSON.stringify(next)
      ) {
        this.known.set(report.id, next);
        changed = true;
      }
    }
    if (changed) this.options.onChange();
  }
}

function runJxa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: PROBE_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}
