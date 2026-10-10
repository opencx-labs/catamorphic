import { describe, expect, it } from "vitest";
import type { VoiceAudioDown, VoiceWorkerEvent } from "../../shared/voice.js";
import { resample, type SpeechParts, VoiceEngine } from "./engine.js";

const WINDOW = 160;

/**
 * Parts driven by the test: speech is "detected" while frames are loud,
 * and a segment ends after a quiet window. Recognition answers from a
 * queue; synthesis, like Kokoro's, makes a text a sentence at a time.
 */
function scripted(transcripts: string[]) {
  let loud = false;
  let speech: number[] = [];
  const segments: Float32Array[] = [];
  const synthesized: string[] = [];
  const made: string[] = [];
  const parts: SpeechParts = {
    activity: {
      windowSize: WINDOW,
      accept: (window) => {
        const level = Math.max(...window.map(Math.abs));
        if (level > 0.1) {
          loud = true;
          speech.push(...window);
        } else if (loud) {
          loud = false;
          segments.push(Float32Array.from(speech));
          speech = [];
        }
      },
      detected: () => loud,
      takeSegments: () => segments.splice(0),
    },
    recognize: async () => transcripts.shift() ?? "",
    synthesize: async (text, onSentence) => {
      synthesized.push(text);
      const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
      for (const sentence of sentences) {
        await Promise.resolve();
        made.push(sentence.trim());
        const clip = { samples: new Float32Array(10), sampleRate: 24_000 };
        if (onSentence?.(clip) === false) break;
      }
      return { samples: new Float32Array(10), sampleRate: 24_000 };
    },
    cue: () => ({ samples: new Float32Array(4), sampleRate: 24_000 }),
    // Two people, told apart by how loud they speak: 0.5 is the person,
    // anything quieter someone else.
    voiceprint: (samples) =>
      samples.reduce(
        (loudest, sample) => Math.max(loudest, Math.abs(sample)),
        0,
      ) > 0.4
        ? [1, 0]
        : [0, 1],
  };
  return { parts, synthesized, made };
}

function harness(
  transcripts: string[] = [],
  adjust: (parts: SpeechParts) => void = () => {},
) {
  const { parts, synthesized, made } = scripted(transcripts);
  adjust(parts);
  const events: VoiceWorkerEvent[] = [];
  const audio: VoiceAudioDown[] = [];
  const engine = new VoiceEngine(
    parts,
    (event) => events.push(event),
    (message) => audio.push(message),
  );
  const frame = (level: number, count = 1) => {
    for (let i = 0; i < count; i++) {
      engine.onAudio({
        type: "frame",
        samples: new Float32Array(WINDOW).fill(level),
        sampleRate: 16_000,
      });
    }
  };
  const drain = () => {
    const last = audio.filter((message) => message.type === "play").at(-1);
    if (last?.type === "play")
      engine.onAudio({ type: "drained", seq: last.seq });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    engine,
    events,
    audio,
    synthesized,
    made,
    frame,
    drain,
    settle,
  };
}

describe("VoiceEngine", () => {
  it("hears an utterance once the speech ends", async () => {
    const voice = harness(["list my sessions"]);
    voice.frame(0.5, 3);
    expect(voice.events).toEqual([{ type: "speech-start" }]);
    voice.frame(0);
    await voice.settle();
    expect(voice.events).toEqual([
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "utterance", text: "list my sessions" },
    ]);
  });

  it("drops hesitation sounds", async () => {
    const voice = harness(["Um."]);
    voice.frame(0.5, 2);
    voice.frame(0);
    await voice.settle();
    expect(voice.events.map((event) => event.type)).toEqual([
      "speech-start",
      "speech-end",
    ]);
  });

  it("plays a reply a sentence at a time, and reports when the last one ends", async () => {
    const voice = harness();
    voice.engine.speak(
      "reply",
      "I started a session to fix the tests. It will report back when it is done.",
    );
    await voice.settle();
    expect(voice.synthesized).toEqual([
      "I started a session to fix the tests. It will report back when it is done.",
    ]);
    const plays = voice.audio.filter((message) => message.type === "play");
    expect(plays).toHaveLength(2);
    expect(voice.events).toEqual([{ type: "speaking", id: "reply" }]);
    // The first sentence ending is not the reply ending.
    const first = plays[0];
    if (first?.type === "play")
      voice.engine.onAudio({ type: "drained", seq: first.seq });
    expect(voice.engine.audible).toBe(true);
    voice.drain();
    expect(voice.events.at(-1)).toEqual({
      type: "spoken",
      id: "reply",
      interrupted: false,
    });
    expect(voice.engine.audible).toBe(false);
  });

  it("stops when the person has talked over it, once their words end", async () => {
    const voice = harness(["wait, use the other branch"]);
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.frame(0.5, 3);
    await voice.settle();
    // Talking alone changes nothing: no word is heard until it ends.
    expect(voice.events).not.toContainEqual({ type: "barge-in" });
    voice.frame(0);
    await voice.settle();
    expect(voice.events).toContainEqual({ type: "barge-in" });
    expect(voice.events).toContainEqual({
      type: "spoken",
      id: "reply",
      interrupted: true,
    });
    expect(voice.audio.some((message) => message.type === "flush")).toBe(true);
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "wait, use the other branch",
    });
  });

  it("ignores its own voice coming back through the speakers", async () => {
    const voice = harness(["answer about the build"]);
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.frame(0.5, 3);
    voice.frame(0);
    await voice.settle();
    expect(voice.events.map((event) => event.type)).not.toContain("utterance");
    expect(voice.events.map((event) => event.type)).not.toContain("barge-in");
    expect(voice.audio.some((message) => message.type === "flush")).toBe(false);
  });

  it("makes no more of a reply once told to stop", async () => {
    const voice = harness();
    voice.engine.speak("reply", "One thing. Another thing. A third thing.");
    voice.engine.stopSpeaking();
    await voice.settle();
    expect(voice.made).toEqual(["One thing."]);
    expect(voice.audio.some((message) => message.type === "play")).toBe(false);
    expect(voice.events.at(-1)).toEqual({
      type: "spoken",
      id: "reply",
      interrupted: true,
    });
  });

  it("stops at once when told to", async () => {
    const voice = harness();
    voice.engine.speak("a", "First answer is quite long here.");
    voice.engine.speak("b", "Second answer is also quite long.");
    voice.engine.stopSpeaking();
    await voice.settle();
    expect(
      voice.events.filter((event) => event.type === "spoken"),
    ).toHaveLength(2);
    expect(voice.engine.audible).toBe(false);
  });
});

describe("VoiceEngine voice print", () => {
  /** Seconds of speech at a level, then the silence that ends it. */
  const talk = (
    voice: ReturnType<typeof harness>,
    level: number,
    seconds: number,
  ) => {
    voice.frame(level, Math.round((seconds * 16_000) / WINDOW));
    voice.frame(0);
  };

  it("learns the person's voice from a few seconds, never from its own prompt", async () => {
    const voice = harness(["ignored while learning"]);
    voice.engine.speak("learn", "Talk to me for a few seconds.");
    voice.engine.learn();
    await voice.settle();
    talk(voice, 0.5, 3);
    await voice.settle();
    // Heard while the prompt was still playing: not learned from.
    voice.drain();
    talk(voice, 0.5, 3.5);
    await voice.settle();
    expect(voice.events.some((event) => event.type === "learned")).toBe(false);
    talk(voice, 0.5, 3);
    await voice.settle();
    expect(voice.events).toContainEqual({
      type: "learned",
      voiceprint: [1, 0],
    });
    expect(voice.events.some((event) => event.type === "utterance")).toBe(
      false,
    );
  });

  it("ignores someone else once it knows the voice, and still hears the person", async () => {
    const voice = harness(["it is not a man for my phone", "list my sessions"]);
    voice.engine.setVoiceprint([1, 0]);
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({ type: "ignored" });
    talk(voice, 0.5, 1.5);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "it is not a man for my phone",
    });
  });

  it("does not stop for someone else talking over it", async () => {
    const voice = harness(["what is on tonight"]);
    voice.engine.setVoiceprint([1, 0]);
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    talk(voice, 0.3, 2);
    await voice.settle();
    expect(voice.events).not.toContainEqual({ type: "barge-in" });
    expect(voice.engine.audible).toBe(true);
  });

  it("lets speech too short to check through", async () => {
    const voice = harness(["stop"]);
    voice.engine.setVoiceprint([1, 0]);
    talk(voice, 0.3, 0.5);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({ type: "utterance", text: "stop" });
  });

  it("listens to the microphone as heard, not as cleaned", async () => {
    const voice = harness(["list my sessions"], (parts) => {
      parts.denoise = (samples) => new Float32Array(samples.length);
    });
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "list my sessions",
    });
  });

  it("keeps listening after a stretch of speech fails", async () => {
    let checks = 0;
    const voice = harness(["list my sessions"], (parts) => {
      parts.voiceprint = () => {
        checks += 1;
        if (checks === 1) throw new Error("bad audio");
        return [1, 0];
      };
    });
    voice.engine.setVoiceprint([1, 0]);
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(voice.events).toContainEqual({
      type: "failed",
      message: "Listening failed: bad audio",
    });
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "list my sessions",
    });
  });

  it("tells who spoke with the noise removed", async () => {
    const voice = harness(["never heard"], (parts) => {
      // Cleaned, the person's voice is as quiet as someone else's.
      parts.denoise = (samples) => samples.map((sample) => sample * 0.6);
    });
    voice.engine.setVoiceprint([1, 0]);
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({ type: "ignored" });
  });

  it("recognizes the audio as heard, not as cleaned", async () => {
    const levels: number[] = [];
    const voice = harness([], (parts) => {
      parts.denoise = (samples) => samples.map((sample) => sample * 0.6);
      parts.recognize = async (samples) => {
        levels.push(Math.max(...samples.map(Math.abs)));
        return "list my sessions";
      };
    });
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(levels).toEqual([0.5]);
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "list my sessions",
    });
  });
});

describe("VoiceEngine push to talk", () => {
  it("hears only while the keys are held, and at once when they come up", async () => {
    const voice = harness(["list my sessions"]);
    voice.engine.setPushToTalk(true);
    voice.frame(0.5, 20);
    voice.frame(0);
    await voice.settle();
    // Speech with no keys held is not listened to.
    expect(voice.events).toEqual([]);
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    expect(voice.events).toEqual([{ type: "speech-start" }]);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events).toEqual([
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "utterance", text: "list my sessions" },
    ]);
  });

  it("stops the agent the moment the keys go down", async () => {
    const voice = harness();
    voice.engine.setPushToTalk(true);
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.engine.hold(true);
    expect(voice.events).toContainEqual({ type: "barge-in" });
    expect(voice.events).toContainEqual({
      type: "spoken",
      id: "reply",
      interrupted: true,
    });
  });

  it("takes held speech as the person's, whatever the voice print", async () => {
    const voice = harness(["what is on tonight"]);
    voice.engine.setVoiceprint([1, 0]);
    voice.engine.setPushToTalk(true);
    voice.engine.hold(true);
    voice.frame(0.3, 100);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "what is on tonight",
    });
  });
});

describe("resample", () => {
  it("brings 48 kHz down to 16 kHz", () => {
    const input = Float32Array.from({ length: 480 }, (_, i) => i / 480);
    const output = resample(input, 48_000);
    expect(output).toHaveLength(160);
    expect(output[80]).toBeCloseTo(0.5, 2);
  });

  it("passes 16 kHz through untouched", () => {
    const input = new Float32Array(16);
    expect(resample(input, 16_000)).toBe(input);
  });
});
