export interface DockSize {
  width: number;
  height: number;
  expanded: boolean;
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
