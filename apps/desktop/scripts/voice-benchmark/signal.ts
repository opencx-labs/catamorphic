/** The signal processing the benchmark's rooms need, and nothing more. */
export const RATE = 16_000;

/** A seeded random source, so every run mixes the same rooms. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < length / 2; k++) {
        const a = start + k;
        const b = a + length / 2;
        const tr = (re[b] ?? 0) * cr - (im[b] ?? 0) * ci;
        const ti = (re[b] ?? 0) * ci + (im[b] ?? 0) * cr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] ?? 0) / n;
      im[i] = (im[i] ?? 0) / n;
    }
}

export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  let n = 1;
  while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = (ar[i] ?? 0) * (br[i] ?? 0) - (ai[i] ?? 0) * (bi[i] ?? 0);
    ai[i] = (ar[i] ?? 0) * (bi[i] ?? 0) + (ai[i] ?? 0) * (br[i] ?? 0);
    ar[i] = r;
  }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, x.length));
}

/**
 * A room's impulse response: the direct sound, then a tail decaying 60 dB
 * over `rt60` seconds, `drrDb` under it. Near the microphone the direct
 * sound dominates; across a room the tail does.
 */
export function room(rt60: number, drrDb: number, seed: number): Float32Array {
  const random = seeded(seed);
  const h = new Float32Array(Math.round(rt60 * 1.1 * RATE));
  h[0] = 1;
  const start = Math.round(0.004 * RATE);
  let energy = 0;
  for (let i = start; i < h.length; i++) {
    const u = Math.max(1e-12, random());
    const noise =
      Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    const value = noise * Math.exp((-6.9 * (i - start)) / RATE / rt60);
    h[i] = value;
    energy += value * value;
  }
  const gain = Math.sqrt(10 ** (-drrDb / 10) / energy);
  for (let i = start; i < h.length; i++) h[i] = (h[i] ?? 0) * gain;
  return h;
}

/** Active speech level, dBFS: 20 ms frames within 30 dB of the loudest. */
export function activeLevel(x: Float32Array): number {
  const frame = RATE / 50;
  const powers: number[] = [];
  for (let i = 0; i + frame <= x.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += (x[j] ?? 0) ** 2;
    powers.push(sum / frame);
  }
  const loudest = Math.max(0, ...powers);
  const active = powers.filter((p) => p > loudest / 1000);
  const mean = active.reduce((a, b) => a + b, 0) / Math.max(1, active.length);
  return 10 * Math.log10(mean + 1e-20);
}

export function rms(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / Math.max(1, x.length) + 1e-20);
}

export function gain(x: Float32Array, db: number): Float32Array {
  const g = 10 ** (db / 20);
  return x.map((v) => v * g);
}

export function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function mix(into: Float32Array, x: Float32Array, at = 0): void {
  for (let i = 0; i < x.length && at + i < into.length; i++)
    into[at + i] = (into[at + i] ?? 0) + (x[i] ?? 0);
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

export function editDistance(
  a: readonly string[],
  b: readonly string[],
): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length] ?? 0;
}
