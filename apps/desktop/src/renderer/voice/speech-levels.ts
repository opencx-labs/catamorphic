import { VOICE_BARS } from "../../shared/voice.js";

export const LEVEL_FRAME_MS = 20;
/**
 * Where the bars listen, in their order on screen: the low bands that
 * carry most of a voice in the middle, the high ones at the edges.
 */
const BAND_HZ = [2200, 450, 200, 1000, 4800];
const BAND_Q = 1.4;
/**
 * A band's full height is its level in the clip's loudest tenth of
 * speech, so ordinary speech fills the bars; louder frames top out.
 */
const FULL_PERCENTILE = 0.9;
/**
 * A quiet band is lifted to fill its bar too, but at most this much
 * (6 dB), so a bar whose band hardly sounds stays low.
 */
const MAX_LIFT = 4;
/** Frames this far below the loudest are silence, and rest at 0. */
const SILENT = 1e-3;

/**
 * Per frame, how loud each band of a clip is, from 0 to 1: a band-pass
 * filter per band (RBJ, 0 dB peak) and the energy of each frame through
 * it, against the band's full level.
 */
export function speechLevels(
  samples: Float32Array,
  sampleRate: number,
): number[] {
  const hop = Math.max(1, Math.round((sampleRate * LEVEL_FRAME_MS) / 1000));
  const frames = Math.ceil(samples.length / hop);
  const energy = new Float64Array(frames * VOICE_BARS);
  for (let band = 0; band < VOICE_BARS; band++) {
    const w = (2 * Math.PI * (BAND_HZ[band] ?? 1000)) / sampleRate;
    const alpha = Math.sin(w) / (2 * BAND_Q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const a1 = (-2 * Math.cos(w)) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let index = 0; index < samples.length; index++) {
      const x = samples[index] ?? 0;
      const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      const slot = Math.floor(index / hop) * VOICE_BARS + band;
      energy[slot] = (energy[slot] ?? 0) + y * y;
    }
  }
  const at = (frame: number, band: number) =>
    energy[frame * VOICE_BARS + band] ?? 0;
  const totals = Array.from({ length: frames }, (_, frame) => {
    let total = 0;
    for (let band = 0; band < VOICE_BARS; band++) total += at(frame, band);
    return total;
  });
  const floor = Math.max(...totals, 0) * SILENT;
  const voiced = totals.flatMap((total, frame) =>
    total > floor ? [frame] : [],
  );
  const full = Array.from({ length: VOICE_BARS }, (_, band) => {
    const sorted = voiced.map((frame) => at(frame, band)).sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * FULL_PERCENTILE)] ?? 0;
  });
  const loudestBand = Math.max(...full, 0);
  const levels: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const silent = (totals[frame] ?? 0) <= floor;
    for (let band = 0; band < VOICE_BARS; band++) {
      const reference = Math.max(full[band] ?? 0, loudestBand / MAX_LIFT);
      const ratio = silent || reference === 0 ? 0 : at(frame, band) / reference;
      // Energy to a perceived level: roughly amplitude, opened up.
      levels.push(Math.round(Math.min(1, ratio ** 0.35) * 100) / 100);
    }
  }
  return levels;
}
