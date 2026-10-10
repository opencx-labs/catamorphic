import { describe, expect, it } from "vitest";
import { VOICE_BARS } from "../../shared/voice.js";
import { LEVEL_FRAME_MS, speechLevels } from "./speech-levels.js";

const RATE = 24_000;
const FRAME = (RATE * LEVEL_FRAME_MS) / 1000;

function tone(hz: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < samples.length; index++)
    samples[index] = 0.3 * Math.sin((2 * Math.PI * hz * index) / RATE);
  return samples;
}

/** The levels of one frame, a bar each. */
function frame(levels: number[], at: number): number[] {
  return levels.slice(at * VOICE_BARS, (at + 1) * VOICE_BARS);
}

describe("speechLevels", () => {
  it("measures a clip frame by frame, a level per bar", () => {
    const levels = speechLevels(tone(450, 0.5), RATE);
    expect(levels).toHaveLength((0.5 * RATE * VOICE_BARS) / FRAME);
    for (const level of levels) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it("lifts the bars whose bands sound, not the others", () => {
    // Bars on screen: 2.2 kHz, 450 Hz, 200 Hz, 1 kHz, 4.8 kHz.
    const steady = frame(speechLevels(tone(450, 0.5), RATE), 12);
    expect(steady[1]).toBeGreaterThan(0.95);
    expect(steady[0]).toBeLessThan(0.6);
    expect(steady[4]).toBeLessThan(0.6);
  });

  it("rests at zero while the clip is silent", () => {
    const clip = new Float32Array(RATE);
    clip.set(tone(1000, 0.5), RATE / 2);
    const levels = speechLevels(clip, RATE);
    expect(frame(levels, 5).every((level) => level === 0)).toBe(true);
    expect(Math.max(...frame(levels, 40))).toBeGreaterThan(0.5);
  });
});
