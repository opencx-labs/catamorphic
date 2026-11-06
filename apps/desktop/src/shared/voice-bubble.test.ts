import { describe, expect, it } from "vitest";
import {
  VOICE_BUBBLE_MARGIN,
  VOICE_BUBBLE_SIZE,
  voiceBubbleDragAt,
  voiceBubbleRest,
  voiceSpotsLayout,
} from "./voice-bubble.js";

// A display left of the main one, under a menu bar.
const area = { x: -1920, y: 25, width: 1920, height: 1055 };

describe("voiceBubbleRest", () => {
  it("rests at the bottom of the work area, left, middle or right", () => {
    expect(voiceBubbleRest(area)).toEqual({
      y: 25 + 1055 - VOICE_BUBBLE_SIZE - VOICE_BUBBLE_MARGIN,
      x: {
        left: -1920 + VOICE_BUBBLE_MARGIN,
        center: -1920 + (1920 - VOICE_BUBBLE_SIZE) / 2,
        right: -VOICE_BUBBLE_SIZE - VOICE_BUBBLE_MARGIN,
      },
    });
  });

  it("stays on a screen narrower than its margins", () => {
    const rest = voiceBubbleRest({ x: 0, y: 0, width: 80, height: 60 });
    expect(rest.x).toEqual({ left: 8, center: 8, right: 8 });
    expect(rest.y).toBe(0);
  });
});

describe("voiceBubbleDragAt", () => {
  const rest = voiceBubbleRest({ x: 0, y: 0, width: 1000, height: 800 });
  // left 28, center 468, right 908: 440 apart.

  it("follows the pointer between the outer spots", () => {
    expect(voiceBubbleDragAt({ rest, from: "center", left: 300 }).x).toBe(300);
    expect(voiceBubbleDragAt({ rest, from: "center", left: -50 }).x).toBe(28);
    expect(voiceBubbleDragAt({ rest, from: "center", left: 2000 }).x).toBe(908);
  });

  it("leaves its spot 40% of the way to the next, as the dock does", () => {
    // 35% of the way left: still the middle.
    expect(
      voiceBubbleDragAt({ rest, from: "center", left: 468 - 154 }).target,
    ).toBe("center");
    // 45% of the way: the left.
    expect(
      voiceBubbleDragAt({ rest, from: "center", left: 468 - 198 }).target,
    ).toBe("left");
    // From the left, the same holds toward the middle.
    expect(
      voiceBubbleDragAt({ rest, from: "left", left: 28 + 154 }).target,
    ).toBe("left");
    expect(
      voiceBubbleDragAt({ rest, from: "left", left: 28 + 198 }).target,
    ).toBe("center");
  });
});

describe("voiceSpotsLayout", () => {
  it("lays the spots where the bubble rests, with room for their glow", () => {
    const rest = voiceBubbleRest(area);
    const layout = voiceSpotsLayout(area);
    expect(layout.bounds.x).toBe(area.x);
    expect(layout.bounds.width).toBe(area.width);
    expect(layout.bounds.y + layout.top).toBe(rest.y);
    expect(layout.bounds.height).toBe(VOICE_BUBBLE_SIZE + 2 * layout.top);
    expect(layout.bounds.y + layout.bounds.height).toBeLessThanOrEqual(
      area.y + area.height,
    );
    expect(
      layout.slots.map(({ spot, left }) => [spot, layout.bounds.x + left]),
    ).toEqual([
      ["left", rest.x.left],
      ["center", rest.x.center],
      ["right", rest.x.right],
    ]);
  });
});
