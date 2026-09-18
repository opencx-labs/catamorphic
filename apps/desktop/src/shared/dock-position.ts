export interface DockSize {
  width: number;
  height: number;
  expanded: boolean;
}

/**
 * The workspace's chat region, relative to its window's content area. While
 * a workspace window is in front, the detached dock rests inside this
 * region instead of the display's work area so it never covers sidebars.
 */
export interface DockRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A capture of the display behind the detached dock, minus the dock. */
export interface DockScreenCapture {
  pngBase64: string;
  width: number;
  height: number;
}

export interface DockDrag {
  phase: "start" | "move" | "end" | "cancel";
  screenX: number;
  reducedMotion: boolean;
}

/** Resting positions are relative to the display, never saved coordinates. */
export function dockPosition({
  area,
  width,
  height,
  side,
  centered,
}: {
  area: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  side: "left" | "right";
  centered: boolean;
}) {
  const margin = Math.min(12, Math.max(0, (area.width - width) / 2));
  return {
    x: Math.round(
      centered
        ? area.x + (area.width - width) / 2
        : side === "left"
          ? area.x + margin
          : area.x + area.width - width - margin,
    ),
    y: Math.max(area.y, area.y + area.height - height - 12),
  };
}
