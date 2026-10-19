/**
 * How well voice hears the person and not the room (ADR 0236), on the real
 * speech models: a person near the microphone, another person across a
 * reverberant room, and the noise of real rooms, fed to the engine as the
 * audio page would.
 *
 *   bun apps/desktop/scripts/voice-benchmark/index.ts fetch
 *   bun apps/desktop/scripts/voice-benchmark/index.ts [before] [now] [--print]
 *     [--hearing '{"nearDb":8}'] [--only person,far]
 *
 * `fetch` downloads LibriSpeech dev-clean-2 and DEMAND rooms (about 650
 * MB, ffmpeg decodes them). Models come from `CATAMORPHIC_VOICE_MODELS_DIR`,
 * else Work's own (`~/Library/Application Support/Work/voice-models`).
 * `before` is voice as it was before ADR 0236; `now` is `HEARING`.
 *
 * The scenarios, eight people and eight others:
 * - person-*: five things said with pauses, in a quiet office, by a soft
 *   speaker on an ungained microphone, in a café, and over a far talker 12
 *   or 6 dB under them. Word error rate counts the far talker's words that
 *   got in; "missed" counts turns that ran into another.
 * - far*: the person says two things, then only the far talker talks for
 *   45 s: what reached the chat, per minute; with "-speaking", while the
 *   agent talks, how often it paused for them (ADR 0265) and how often it
 *   was cut off.
 * - echo*: the same, with the agent's own voice coming back through the
 *   speakers, what echo cancellation leaves of it.
 * - talking over the agent: the person's five things, each said while the
 *   agent talks: how soon it paused after they started, and whether it
 *   stopped.
 * - *-noise: two minutes of a room's noise alone.
 */
import os from "node:os";
import path from "node:path";
import {
  HEARING,
  type Hearing,
  resample,
  type SpeechParts,
  VoiceEngine,
} from "../../src/main/voice/engine.js";
import { voiceModelPaths } from "../../src/main/voice/models.js";
import { loadSherpaSpeech } from "../../src/main/voice/sherpa-speech.js";
import type { VoiceWorkerEvent } from "../../src/shared/voice.js";
import { fetchData, type Room, room, samples, utterances } from "./data.js";
import {
  activeLevel,
  concat,
  convolve,
  editDistance,
  gain,
  room as impulse,
  mix,
  RATE,
  rms,
  seeded,
  words,
} from "./signal.js";

/**
 * Voice as it heard before ADR 0236: anyone, at any level, with no word
 * too unsure (its voice print aside, which few people taught it).
 */
const BEFORE: Hearing = {
  nearDb: null,
  gateDb: 0,
  gateHoldSeconds: 0,
  sureOfWords: Number.NEGATIVE_INFINITY,
  sameVoice: -1,
  nearerDb: Number.POSITIVE_INFINITY,
  bargeInDb: null,
  // It never paused: the agent stopped once the words were heard.
  pauseSeconds: Number.POSITIVE_INFINITY,
  pauseDb: null,
  pauseAlike: null,
};

const PERSON_DB = -26;

interface Heard {
  at: number;
  event:
    | VoiceWorkerEvent
    /** What the engine told the audio page: the agent paused, or stopped. */
    | { type: "pause" | "resume" | "flush" };
}

/** The speakers, read once the data is there (`fetch` brings it). */
let corpus: {
  all: ReturnType<typeof utterances>;
  people: string[];
  others: string[];
} | null = null;
function speakers() {
  if (!corpus) {
    const all = utterances();
    const ids = [...new Set(all.map((u) => u.speaker))].sort();
    corpus = { all, people: ids.slice(0, 8), others: ids.slice(8, 16) };
  }
  return corpus;
}
const said = (speaker: string, min: number, max: number) =>
  speakers().all.filter(
    (u) => u.speaker === speaker && u.seconds >= min && u.seconds <= max,
  );

/**
 * A person's things to say, near the microphone. No one says everything
 * as loud: each thing is up to 6 dB softer or 3 dB louder, as a person
 * leans back, turns away or speaks up.
 */
function near(speaker: string, count: number, seed: number, at = PERSON_DB) {
  const h = impulse(0.3, 12, seed);
  const random = seeded(seed);
  return said(speaker, 2, 9)
    .slice(0, count)
    .map((u) => {
      const x = convolve(samples(u.file), h);
      const varies = -6 + 9 * random();
      return { text: u.text, samples: gain(x, at + varies - activeLevel(x)) };
    });
}

/** Someone across the room, talking on with short pauses. */
function far(speaker: string, seconds: number, seed: number, db: number) {
  const parts: Float32Array[] = [];
  let total = 0;
  for (const [index, u] of said(speaker, 2, 20).entries()) {
    const pause = new Float32Array(
      Math.round(RATE * (0.2 + ((index * 37) % 60) / 100)),
    );
    parts.push(samples(u.file), pause);
    total += u.seconds + pause.length / RATE;
    if (total >= seconds) break;
  }
  const x = convolve(concat(parts), impulse(0.6, -2, seed)).subarray(
    0,
    Math.round(seconds * RATE),
  );
  return gain(x, db - activeLevel(x));
}

function noise(name: Room, seconds: number, offset: number, db: number) {
  const recording = room(name);
  const length = Math.round(seconds * RATE);
  const start = Math.round(offset * RATE) % (recording.length - length);
  const x = recording.slice(start, start + length);
  return gain(x, db - rms(x));
}

/** Feeds a stream to the engine as 20 ms frames, as the audio page does. */
async function listen(
  parts: SpeechParts,
  hearing: Hearing,
  stream: Float32Array,
  options: {
    voiceprint?: number[] | null;
    speakingFrom?: number;
    /** Cut off, the agent starts talking again: it always talks. */
    talksOn?: boolean;
  } = {},
): Promise<Heard[]> {
  const heard: Heard[] = [];
  let fed = 0;
  const engine = new VoiceEngine(
    parts,
    (event) => heard.push({ at: fed / RATE, event }),
    (message) => {
      if (message.type !== "play" && message.type !== "close-microphone")
        heard.push({ at: fed / RATE, event: { type: message.type } });
    },
    hearing,
  );
  if (options.voiceprint) engine.setVoiceprint(options.voiceprint);
  const frame = RATE / 50;
  let ends = 0;
  let speaking = false;
  for (let offset = 0; offset < stream.length; offset += frame) {
    // Playback never reports drained here: the agent talks on.
    if (
      options.speakingFrom !== undefined &&
      fed / RATE >= options.speakingFrom &&
      (!speaking || (options.talksOn && !engine.audible))
    ) {
      speaking = true;
      engine.speak("reply", "Okay.");
    }
    engine.onAudio({
      type: "frame",
      samples: stream.subarray(offset, offset + frame),
      sampleRate: RATE,
    });
    fed += frame;
    // Recognition is many times faster than real time: what ended is known
    // before more audio arrives.
    const ended = heard.filter((h) => h.event.type === "speech-end").length;
    if (ended !== ends) {
      ends = ended;
      await engine.recognized();
    }
    if (offset % (frame * 25) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await engine.recognized();
  return heard;
}

const utteranceTexts = (heard: Heard[]) =>
  heard.flatMap((h) =>
    h.event.type === "utterance" ? [{ at: h.at, text: h.event.text }] : [],
  );

async function person(
  parts: SpeechParts,
  hearing: Hearing,
  options: {
    far?: number;
    room: Room;
    snr: number;
    at?: number;
    print?: (speaker: string) => number[];
  },
) {
  const at = options.at ?? PERSON_DB;
  const { people, others } = speakers();
  let errors = 0;
  let total = 0;
  let missed = 0;
  let heardCount = 0;
  for (const [index, speaker] of people.entries()) {
    const things = near(speaker, 5, 100 + index, at);
    const layout: { start: number; end: number; text: string }[] = [];
    let t = 1.5;
    for (const thing of things) {
      layout.push({
        start: t,
        end: t + thing.samples.length / RATE,
        text: thing.text,
      });
      t += thing.samples.length / RATE + 3;
    }
    const stream = new Float32Array(Math.round((t + 1) * RATE));
    for (const [i, thing] of things.entries())
      mix(stream, thing.samples, Math.round((layout[i]?.start ?? 0) * RATE));
    if (options.far !== undefined)
      mix(
        stream,
        far(others[index] ?? "", t + 1, 200 + index, at - options.far),
      );
    mix(stream, noise(options.room, t + 1, index * 37, at - options.snr));
    const heard = utteranceTexts(
      await listen(parts, hearing, stream, {
        voiceprint: options.print?.(speaker) ?? null,
      }),
    );
    heardCount += heard.length;
    const reference = layout.flatMap((l) => words(l.text));
    errors += editDistance(
      reference,
      heard.flatMap((h) => words(h.text)),
    );
    total += reference.length;
    for (const [i, l] of layout.entries()) {
      const next = layout[i + 1]?.start ?? t + 1;
      if (!heard.some((h) => h.at >= l.end - 0.3 && h.at < next + 0.5))
        missed += 1;
    }
  }
  return {
    "word errors": `${((100 * errors) / total).toFixed(1)}%`,
    heard: `${heardCount}/${people.length * 5}`,
    missed,
  };
}

async function background(
  parts: SpeechParts,
  hearing: Hearing,
  options: {
    far: number;
    speaking?: boolean;
    /** The agent's own voice, at `far` dB under the person, not a talker. */
    echo?: Float32Array;
    print?: (speaker: string) => number[];
  },
) {
  const { people, others } = speakers();
  let messages = 0;
  let cutOff = 0;
  let paused = 0;
  let seconds = 0;
  for (const [index, other] of others.slice(0, 6).entries()) {
    const speaker = people[index] ?? "";
    const [first, second] = near(speaker, 2, 400 + index);
    const gap = new Float32Array(RATE * 2);
    const warmup = concat([
      new Float32Array(RATE),
      first?.samples ?? gap,
      gap,
      second?.samples ?? gap,
      gap,
    ]);
    const stream = concat([
      warmup,
      options.echo
        ? gain(
            options.echo.subarray(0, 45 * RATE),
            PERSON_DB - options.far - activeLevel(options.echo),
          )
        : far(other, 45, 300 + index, PERSON_DB - options.far),
    ]);
    mix(
      stream,
      noise("DLIVING", stream.length / RATE, index * 53, PERSON_DB - 30),
    );
    const after = warmup.length / RATE;
    const heard = (
      await listen(parts, hearing, stream, {
        voiceprint: options.print?.(speaker) ?? null,
        ...(options.speaking ? { speakingFrom: after } : {}),
      })
    ).filter((h) => h.at > after + 0.3);
    messages += heard.filter((h) => h.event.type === "utterance").length;
    cutOff += heard.filter((h) => h.event.type === "barge-in").length;
    paused += heard.filter((h) => h.event.type === "pause").length;
    seconds += 45;
  }
  return {
    "messages/min": +((60 * messages) / seconds).toFixed(2),
    ...(options.speaking
      ? { "agent paused": paused, "agent cut off": cutOff }
      : {}),
  };
}

/**
 * The person talking over the agent, five things each, after two to be
 * known by: how soon the agent pauses once they start (ADR 0265), and
 * whether their words stop it.
 */
async function overAgent(
  parts: SpeechParts,
  hearing: Hearing,
  options: { print?: (speaker: string) => number[] },
) {
  const { people } = speakers();
  const delays: number[] = [];
  let things = 0;
  let stopped = 0;
  for (const [index, speaker] of people.entries()) {
    const [first, second, ...over] = near(speaker, 7, 500 + index);
    const gap = new Float32Array(RATE * 2);
    const pieces: Float32Array[] = [
      new Float32Array(RATE),
      first?.samples ?? gap,
      gap,
      second?.samples ?? gap,
      gap,
    ];
    const starts: number[] = [];
    let t = pieces.reduce((sum, part) => sum + part.length, 0) / RATE;
    const talkFrom = t;
    for (const thing of over) {
      starts.push(t + activeOnset(thing.samples));
      pieces.push(thing.samples, gap);
      t += (thing.samples.length + gap.length) / RATE;
    }
    const stream = concat(pieces);
    mix(
      stream,
      noise("OOFFICE", stream.length / RATE, index * 41, PERSON_DB - 30),
    );
    const heard = await listen(parts, hearing, stream, {
      voiceprint: options.print?.(speaker) ?? null,
      speakingFrom: talkFrom - 0.5,
      talksOn: true,
    });
    for (const [i, start] of starts.entries()) {
      const end = starts[i + 1] ?? Number.POSITIVE_INFINITY;
      things += 1;
      const pause = heard.find(
        (h) => h.event.type === "pause" && h.at >= start && h.at < end,
      );
      if (pause) delays.push(pause.at - start);
      if (
        heard.some(
          (h) => h.event.type === "barge-in" && h.at >= start && h.at < end,
        )
      )
        stopped += 1;
    }
  }
  delays.sort((a, b) => a - b);
  const median = delays[Math.floor(delays.length / 2)] ?? Number.NaN;
  return {
    paused: `${delays.length}/${things}`,
    "paused after (median s)": +median.toFixed(2),
    stopped: `${stopped}/${things}`,
  };
}

/** Where speech in a clip starts: its first 32 ms window near its level. */
function activeOnset(x: Float32Array): number {
  const level = activeLevel(x);
  for (let start = 0; start + 512 <= x.length; start += 512)
    if (rms(x.subarray(start, start + 512)) >= level - 20) return start / RATE;
  return 0;
}

async function roomNoise(
  parts: SpeechParts,
  hearing: Hearing,
  name: Room,
  db: number,
) {
  const heard = utteranceTexts(
    await listen(parts, hearing, noise(name, 120, 11, db)),
  );
  return {
    "messages/min": +(heard.length / 2).toFixed(2),
    heard: heard.map((h) => h.text).join(" | "),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "fetch") {
    fetchData();
    return;
  }
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args.splice(index, 2)[1] : undefined;
  };
  const override: Partial<Hearing> = JSON.parse(flag("--hearing") ?? "{}");
  const only = flag("--only")?.split(",");
  const usePrint = args.includes("--print");
  const variants = args.filter((a) => a === "before" || a === "now");
  const models =
    process.env.CATAMORPHIC_VOICE_MODELS_DIR ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Work",
      "voice-models",
    );
  const parts = await loadSherpaSpeech(voiceModelPaths(models), "af_heart");
  // The agent's own voice, as it would come back through the speakers.
  const reply = await parts.synthesize(
    "I looked at the pull request and the build. The tests pass on the main branch, but two checks failed on yours: the desktop suite timed out on the voice test, and the lint step found an unused import in the engine. I can fix the import now and run the suite again, or wait until you have read the review. Tell me which you would like, and I will keep an eye on the checks either way. ".repeat(
      2,
    ),
  );
  const echo = convolve(
    resample(reply.samples, reply.sampleRate),
    impulse(0.4, 0, 7),
  );
  // The person's voice print, from what they say outside the scenarios.
  const prints = new Map<string, number[]>();
  const print = (speaker: string) => {
    let known = prints.get(speaker);
    if (!known) {
      const enroll = concat(
        said(speaker, 2, 30)
          .slice(-4)
          .map((u) => samples(u.file)),
      );
      const x = convolve(enroll.subarray(0, 8 * RATE), impulse(0.3, 12, 999));
      known = parts.voiceprint?.(x) ?? [];
      prints.set(speaker, known);
    }
    return known;
  };
  const withPrint = usePrint ? { print } : {};
  for (const name of variants.length ? variants : ["before", "now"]) {
    const hearing = { ...(name === "before" ? BEFORE : HEARING), ...override };
    const want = (scenario: string) =>
      !only || only.some((o) => scenario.startsWith(o));
    const table: Record<string, Record<string, string | number>> = {};
    const scenarios: [
      string,
      () => Promise<Record<string, string | number>>,
    ][] = [
      [
        "person, quiet office",
        () =>
          person(parts, hearing, { room: "OOFFICE", snr: 30, ...withPrint }),
      ],
      [
        "person, soft and ungained",
        () =>
          person(parts, hearing, {
            room: "OOFFICE",
            snr: 20,
            at: -44,
            ...withPrint,
          }),
      ],
      [
        "person, café",
        () =>
          person(parts, hearing, { room: "PCAFETER", snr: 10, ...withPrint }),
      ],
      [
        "person, far talker 12 dB under",
        () =>
          person(parts, hearing, {
            room: "DLIVING",
            snr: 30,
            far: 12,
            ...withPrint,
          }),
      ],
      [
        "person, far talker 6 dB under",
        () =>
          person(parts, hearing, {
            room: "DLIVING",
            snr: 30,
            far: 6,
            ...withPrint,
          }),
      ],
      [
        "far talker 12 dB under",
        () => background(parts, hearing, { far: 12, ...withPrint }),
      ],
      [
        "far talker 6 dB under",
        () => background(parts, hearing, { far: 6, ...withPrint }),
      ],
      [
        "far talker 6 dB under, agent speaking",
        () =>
          background(parts, hearing, { far: 6, speaking: true, ...withPrint }),
      ],
      [
        "echo 20 dB under, agent speaking",
        () =>
          background(parts, hearing, {
            far: 20,
            speaking: true,
            echo,
            ...withPrint,
          }),
      ],
      [
        "echo 12 dB under, agent speaking",
        () =>
          background(parts, hearing, {
            far: 12,
            speaking: true,
            echo,
            ...withPrint,
          }),
      ],
      ["talking over the agent", () => overAgent(parts, hearing, withPrint)],
      ["café noise", () => roomNoise(parts, hearing, "PCAFETER", -40)],
      ["office noise", () => roomNoise(parts, hearing, "OOFFICE", -40)],
      ["bus noise", () => roomNoise(parts, hearing, "TBUS", -36)],
    ];
    for (const [scenario, measure] of scenarios)
      if (want(scenario)) table[scenario] = await measure();
    console.log(
      `\n${name}${usePrint ? ", voice print" : ""} ${JSON.stringify(hearing)}`,
    );
    console.table(table);
  }
}

await main();
process.exit(0);
