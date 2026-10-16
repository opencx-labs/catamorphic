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
      reset: () => {
        loud = false;
        speech = [];
        segments.length = 0;
      },
    },
    recognize: async () => ({ text: transcripts.shift() ?? "", confidence: 0 }),
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
});

describe("VoiceEngine hears the person, not the room", () => {
  /** Seconds of speech at a level, then a second of silence. */
  const talk = (
    voice: ReturnType<typeof harness>,
    level: number,
    seconds: number,
  ) => {
    voice.frame(level, Math.round((seconds * 16_000) / WINDOW));
    voice.frame(0, 16_000 / WINDOW);
  };
  const said = (voice: ReturnType<typeof harness>) =>
    voice.events.flatMap((event) =>
      event.type === "utterance" ? [event.text] : [],
    );

  it("ignores a voice far quieter than the person's once they have spoken", async () => {
    const voice = harness(["list my sessions", "breaking news tonight"]);
    talk(voice, 0.5, 1);
    await voice.settle();
    // A television across the room: 14 dB under the person.
    talk(voice, 0.1, 2);
    await voice.settle();
    expect(said(voice)).toEqual(["list my sessions"]);
  });

  it("ends the person's turn when a quieter voice carries on after it", async () => {
    const lengths: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        lengths.push(samples.length / 16_000);
        return { text: "use the release branch", confidence: 0 };
      };
    });
    talk(voice, 0.5, 1);
    await voice.settle();
    // Their next turn runs straight into a far voice that goes on and on.
    voice.frame(0.5, 100);
    voice.frame(0.15, 400);
    await voice.settle();
    expect(lengths).toHaveLength(2);
    // A second of speech and the quarter second held after it, not five.
    expect(lengths[1]).toBeLessThan(2.5);
  });

  it("ends even a first turn when a quieter voice carries on after it", async () => {
    const lengths: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        lengths.push(samples.length / 16_000);
        return { text: "hello there", confidence: 0 };
      };
    });
    voice.frame(0.5, 150);
    voice.frame(0.12, 500);
    await voice.settle();
    expect(lengths).toHaveLength(1);
    expect(lengths[0]).toBeLessThan(3);
  });

  it("ignores another voice once it has heard the person's", async () => {
    const voice = harness(["list my sessions", "what is on tonight"]);
    talk(voice, 0.5, 1);
    await voice.settle();
    // Another voice, 4.4 dB under the person: not theirs, not nearer.
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(said(voice)).toEqual(["list my sessions"]);
    expect(voice.events).toContainEqual({ type: "ignored" });
  });

  it("hands the person to a nearer voice that keeps talking", async () => {
    const voice = harness(["breaking news", "more news", "list my sessions"]);
    // The television is heard first, long enough to be sure of it...
    talk(voice, 0.3, 1.5);
    await voice.settle();
    talk(voice, 0.3, 1.5);
    await voice.settle();
    // ...then the person, another voice 4.4 dB louder, takes over...
    talk(voice, 0.5, 1.5);
    await voice.settle();
    // ...and the television is someone else from then on.
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(said(voice)).toEqual([
      "breaking news",
      "more news",
      "list my sessions",
    ]);
    expect(voice.events.at(-1)).toEqual({ type: "ignored" });
  });

  it("keeps a voice the person taught it, however loud another is", async () => {
    // Ignored stretches are never recognized.
    const voice = harness(["list my sessions", "and the docs"]);
    voice.engine.setVoiceprint([0, 1]);
    // The person speaks, so voice knows how loud they are...
    talk(voice, 0.3, 1.5);
    await voice.settle();
    // ...and a voice 4.4 dB louder, long enough to be nearer, is not them.
    talk(voice, 0.5, 1.5);
    talk(voice, 0.5, 1.5);
    await voice.settle();
    expect(voice.events).toContainEqual({ type: "ignored" });
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(said(voice)).toEqual(["list my sessions", "and the docs"]);
  });

  it("is not taken over by a voice merely like theirs, a little louder", async () => {
    const voice = harness(
      ["list my sessions", "and the docs", "open the first", "quietly now"],
      (parts) => {
        // The person below 0.6; above it a voice only like theirs.
        parts.voiceprint = (samples) =>
          Math.max(...samples.map(Math.abs)) > 0.6
            ? [0.4, Math.sqrt(1 - 0.16)]
            : [1, 0];
      },
    );
    talk(voice, 0.4, 1.5);
    await voice.settle();
    talk(voice, 0.4, 1.5);
    await voice.settle();
    // 4.2 dB louder and alike enough: heard, but they are still the person.
    talk(voice, 0.65, 1.5);
    await voice.settle();
    // The person, 6 dB softer than they speak: still them, still heard.
    talk(voice, 0.2, 1.5);
    await voice.settle();
    expect(said(voice)).toEqual([
      "list my sessions",
      "and the docs",
      "open the first",
      "quietly now",
    ]);
  });

  it("judges speech too short to know by how loud it is", async () => {
    const voice = harness(["list my sessions", "stop"]);
    talk(voice, 0.5, 1);
    await voice.settle();
    // 8.9 dB under the person: through detection, not near enough.
    talk(voice, 0.18, 0.5);
    await voice.settle();
    expect(voice.events).toContainEqual({ type: "ignored" });
    talk(voice, 0.45, 0.5);
    await voice.settle();
    expect(said(voice)).toEqual(["list my sessions", "stop"]);
  });

  it("stops talking only for the person's voice", async () => {
    const voice = harness(["hello", "wait, stop"]);
    talk(voice, 0.5, 1);
    await voice.settle();
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(voice.events).not.toContainEqual({ type: "barge-in" });
    expect(voice.engine.audible).toBe(true);
    talk(voice, 0.45, 1.5);
    await voice.settle();
    expect(voice.events).toContainEqual({ type: "barge-in" });
    expect(said(voice)).toEqual(["hello", "wait, stop"]);
  });

  it("learns the person afresh from what is said with the keys held", async () => {
    const voice = harness(["breaking news", "it is me", "and again"]);
    talk(voice, 0.5, 1.5);
    await voice.settle();
    voice.engine.hold(true);
    voice.frame(0.3, 150);
    voice.engine.hold(false);
    voice.frame(0, 100);
    await voice.settle();
    talk(voice, 0.3, 1.5);
    await voice.settle();
    expect(said(voice)).toEqual(["breaking news", "it is me", "and again"]);
  });

  it("keeps no measure of how loud speech is from a hold that said nothing", async () => {
    const voice = harness(["", "hello"]);
    voice.engine.hold(true);
    voice.frame(0.9, 150);
    voice.engine.hold(false);
    await voice.settle();
    // Someone soft, 15.6 dB under the hold, before anyone is known.
    talk(voice, 0.15, 1);
    await voice.settle();
    expect(said(voice)).toEqual(["hello"]);
  });

  it("drops words the recognizer made of noise, unless the keys were held", async () => {
    const voice = harness([], (parts) => {
      parts.recognize = async () => ({ text: "Okay, so.", confidence: -0.8 });
    });
    talk(voice, 0.5, 1);
    await voice.settle();
    expect(said(voice)).toEqual([]);
    voice.engine.hold(true);
    voice.frame(0.5, 50);
    voice.engine.hold(false);
    await voice.settle();
    expect(said(voice)).toEqual(["Okay, so."]);
  });
});

describe("VoiceEngine held keys", () => {
  it("hears only while the keys are held, and at once when they come up", async () => {
    const voice = harness(["list my sessions"]);
    voice.engine.setHandsFree(false);
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
    voice.engine.setHandsFree(false);
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
    voice.engine.setHandsFree(false);
    voice.engine.hold(true);
    voice.frame(0.3, 100);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.at(-1)).toEqual({
      type: "utterance",
      text: "what is on tonight",
    });
  });

  it("once it stops listening, finishes what it says and hears nothing more", async () => {
    const voice = harness(["wait", "one more thing"]);
    voice.engine.speak("bye", "Talk soon.");
    await voice.settle();
    // Speech underway when listening stops ends, and nothing is heard.
    voice.frame(0.5, 3);
    voice.engine.stopListening();
    voice.frame(0);
    voice.frame(0.5, 3);
    voice.frame(0);
    await voice.settle();
    voice.drain();
    expect(voice.events).toEqual([
      { type: "speaking", id: "bye" },
      { type: "speech-start" },
      { type: "speech-end" },
      { type: "spoken", id: "bye", interrupted: false },
    ]);
  });

  it("drops what it was still recognizing when listening stops", async () => {
    let answer: (text: string) => void = () => {};
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((resolve) => {
          answer = (text) => resolve({ text, confidence: 0 });
        });
    });
    voice.engine.speak("bye", "Talk soon.");
    voice.frame(0.5, 3);
    voice.frame(0);
    await voice.settle();
    // Recognition is underway; listening stops before it answers.
    voice.engine.stopListening();
    answer("wait");
    await voice.settle();
    voice.drain();
    expect(voice.events.map((event) => event.type)).not.toContain("barge-in");
    expect(voice.events.map((event) => event.type)).not.toContain("utterance");
    expect(voice.events.at(-1)).toEqual({
      type: "spoken",
      id: "bye",
      interrupted: false,
    });
  });

  it("closes the microphone when it stops listening, and on a page that takes over", () => {
    const voice = harness();
    voice.engine.stopListening();
    voice.engine.stopListening();
    voice.engine.audioReplaced();
    expect(
      voice.audio.filter((message) => message.type === "close-microphone"),
    ).toHaveLength(2);
  });

  it("counts what a replaced audio page had still to play as played", async () => {
    const voice = harness();
    voice.engine.speak("reply", "Here is the answer.");
    await voice.settle();
    expect(voice.engine.audible).toBe(true);
    // The page that was playing it is gone; it never reports drained.
    voice.engine.audioReplaced();
    expect(voice.engine.audible).toBe(false);
    expect(voice.events.at(-1)).toEqual({
      type: "spoken",
      id: "reply",
      interrupted: false,
    });
    expect(
      voice.audio.some((message) => message.type === "close-microphone"),
    ).toBe(false);
  });

  it("talks while the keys are held even when voice listens on its own", async () => {
    const voice = harness(["use the release branch"]);
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.engine.hold(true);
    expect(voice.events).toContainEqual({ type: "barge-in" });
    // Pauses while held split nothing: detection rests until release.
    voice.frame(0.5, 20);
    voice.frame(0, 5);
    voice.frame(0.5, 20);
    await voice.settle();
    expect(
      voice.events.filter((event) => event.type === "utterance"),
    ).toHaveLength(0);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual([
      { type: "utterance", text: "use the release branch" },
    ]);
    // Detection starts afresh: nothing from before the keys comes back.
    voice.frame(0);
    await voice.settle();
    expect(
      voice.events.filter((event) => event.type === "utterance"),
    ).toHaveLength(1);
  });

  it("keeps speech already under way when the keys go down", async () => {
    const recognized: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        recognized.push(samples.length);
        return { text: "list my sessions", confidence: 0 };
      };
    });
    voice.frame(0.5, 10);
    voice.engine.hold(true);
    voice.frame(0.5, 10);
    voice.engine.hold(false);
    await voice.settle();
    expect(
      voice.events.filter((event) => event.type === "speech-start"),
    ).toHaveLength(1);
    // Twenty windows of speech, and the quiet before them.
    expect(recognized).toEqual([20 * WINDOW]);
  });

  it("holds nothing once it stops listening", async () => {
    const voice = harness(["list my sessions"]);
    voice.engine.setHandsFree(false);
    voice.engine.stopListening();
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events).toEqual([]);
  });
});

describe("VoiceEngine dictation", () => {
  const dictated = (voice: ReturnType<typeof harness>) =>
    voice.events.filter((event) => event.type === "dictation");

  it("shows the words while the person talks, then what they said", async () => {
    const heard: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        heard.push(samples.length);
        return {
          text: samples.length < 16_000 ? "list my" : "list my sessions",
          confidence: 0,
        };
      };
    });
    voice.engine.setDictation(true);
    // A second and a half of speech, in 10 ms windows.
    for (let i = 0; i < 15; i++) {
      voice.frame(0.5, 10);
      await voice.settle();
    }
    const partials = dictated(voice);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials.every((event) => !event.final)).toBe(true);
    expect(partials[0]).toEqual({
      type: "dictation",
      segment: 1,
      text: "list my",
      final: false,
    });
    voice.frame(0);
    await voice.settle();
    expect(dictated(voice).at(-1)).toEqual({
      type: "dictation",
      segment: 1,
      text: "list my sessions",
      final: true,
    });
    // Dictation sends nothing: no utterance for the conversation.
    expect(voice.events.map((event) => event.type)).not.toContain("utterance");
  });

  it("numbers each stretch of speech, and ends one that said nothing", async () => {
    const voice = harness(["Um.", "open the docs"]);
    voice.engine.setDictation(true);
    voice.frame(0.5, 3);
    voice.frame(0);
    await voice.settle();
    voice.frame(0.5, 3);
    voice.frame(0);
    await voice.settle();
    expect(dictated(voice).filter((event) => event.final)).toEqual([
      { type: "dictation", segment: 1, text: "", final: true },
      { type: "dictation", segment: 2, text: "open the docs", final: true },
    ]);
  });

  it("writes nothing for someone else's voice", async () => {
    const voice = harness(["what is on tonight"]);
    voice.engine.setDictation(true);
    voice.engine.setVoiceprint([1, 0]);
    voice.frame(0.3, 150);
    voice.frame(0);
    await voice.settle();
    expect(dictated(voice).at(-1)).toEqual({
      type: "dictation",
      segment: 1,
      text: "",
      final: true,
    });
    expect(voice.events).toContainEqual({ type: "ignored" });
  });

  it("dictates while the keys are held, a stretch per hold", async () => {
    const voice = harness(["first thought", "second thought"]);
    voice.engine.setDictation(true);
    voice.engine.setHandsFree(false);
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    voice.engine.hold(false);
    await voice.settle();
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    voice.engine.hold(false);
    await voice.settle();
    expect(dictated(voice).filter((event) => event.final)).toEqual([
      { type: "dictation", segment: 1, text: "first thought", final: true },
      { type: "dictation", segment: 2, text: "second thought", final: true },
    ]);
  });

  it("hears a long hold in parts, losing nothing", async () => {
    const lengths: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        lengths.push(samples.length);
        return { text: "more words", confidence: 0 };
      };
    });
    voice.engine.setHandsFree(false);
    voice.engine.hold(true);
    // Forty seconds held.
    voice.frame(0.5, 4_000);
    voice.engine.hold(false);
    await voice.settle();
    expect(
      voice.events.filter((event) => event.type === "utterance"),
    ).toHaveLength(2);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(40 * 16_000);
  });

  it("hears what the person is still saying as voice turns off, then nothing", async () => {
    const voice = harness(["send the report"]);
    voice.engine.setDictation(true);
    voice.frame(0.5, 100);
    await voice.engine.finish();
    expect(dictated(voice).at(-1)).toEqual({
      type: "dictation",
      segment: 1,
      text: "send the report",
      final: true,
    });
    expect(voice.audio).toContainEqual({ type: "close-microphone" });
    const heard = voice.events.length;
    voice.frame(0.5, 100);
    voice.frame(0);
    await voice.settle();
    expect(voice.events).toHaveLength(heard);
  });

  it("hears nothing more from the press that turned it off", async () => {
    const voice = harness(["send the report", "report"]);
    voice.engine.setDictation(true);
    voice.frame(0.5, 100);
    voice.frame(0);
    await voice.settle();
    // The tap that turns voice off holds for a moment: what it caught
    // from before it was already heard.
    voice.engine.hold(true);
    await voice.engine.finish();
    expect(
      dictated(voice).filter((event) => event.final && event.text),
    ).toEqual([
      { type: "dictation", segment: 1, text: "send the report", final: true },
    ]);
  });

  it("does not repeat what a hold heard when the person talks on", async () => {
    const lengths: number[] = [];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        lengths.push(samples.length / 16_000);
        return { text: "more words", confidence: 0 };
      };
    });
    voice.engine.setDictation(true);
    voice.frame(0, 100);
    voice.engine.hold(true);
    voice.frame(0.5, 100);
    voice.engine.hold(false);
    // Half a second more, listening on its own.
    voice.frame(0.5, 50);
    voice.frame(0);
    await voice.settle();
    expect(lengths).toHaveLength(2);
    expect(lengths[1]).toBeLessThan(0.6);
  });

  it("stops the agent's voice when dictation starts", async () => {
    const voice = harness();
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.engine.setDictation(true);
    expect(voice.engine.audible).toBe(false);
    expect(voice.events).toContainEqual({
      type: "spoken",
      id: "reply",
      interrupted: true,
    });
  });
});

describe("VoiceEngine moving on", () => {
  it("answers nothing said for where it was before", async () => {
    let answer: (text: string) => void = () => {};
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((resolve) => {
          answer = (text) => resolve({ text, confidence: 0 });
        });
    });
    voice.frame(0.5, 100);
    voice.frame(0);
    await voice.settle();
    // Voice moves to another chat while the last words are recognized.
    voice.engine.forget();
    answer("delete that branch");
    await voice.settle();
    expect(voice.events.map((event) => event.type)).not.toContain("utterance");
  });

  it("says nothing once the worker lets it go", async () => {
    let answer: (text: string) => void = () => {};
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((resolve) => {
          answer = (text) => resolve({ text, confidence: 0 });
        });
    });
    voice.frame(0.5, 100);
    voice.frame(0);
    await voice.settle();
    voice.engine.close();
    const said = voice.events.length;
    answer("list my sessions");
    await voice.settle();
    expect(voice.events).toHaveLength(said);
    expect(voice.audio).toContainEqual({ type: "close-microphone" });
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
