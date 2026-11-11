import { describe, expect, it, vi } from "vitest";
import type { VoiceAudioDown, VoiceWorkerEvent } from "../../shared/voice.js";
import { resample, type SpeechParts, VoiceEngine } from "./engine.js";

const WINDOW = 160;

/**
 * Recognition answers from a queue; synthesis, like Kokoro's, makes a
 * text a sentence at a time.
 */
function scripted(transcripts: string[]) {
  const synthesized: string[] = [];
  const made: string[] = [];
  const parts: SpeechParts = {
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
  };
  return { parts, synthesized, made };
}

/** What the engine told the audio page, besides what to play. */
function controls(voice: { audio: VoiceAudioDown[] }) {
  return voice.audio
    .map((message) => message.type)
    .filter((type) => type !== "play");
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

describe("VoiceEngine push to talk", () => {
  it("shows revised live words during a hold and sends one final message on release", async () => {
    let partial!: (text: string) => void;
    const write = vi.fn();
    const finish = vi.fn(async () => ({
      text: "The final words.",
      confidence: 0,
    }));
    const voice = harness([], (parts) => {
      parts.startRecognition = (onPartial) => {
        partial = onPartial;
        return { write, finish, cancel: vi.fn() };
      };
    });
    voice.engine.hold(true);
    voice.frame(0.5);
    partial("the first");
    partial("the final words");
    expect(write).toHaveBeenCalledOnce();
    expect(
      voice.events.filter((event) => event.type === "transcript"),
    ).toMatchObject([
      { text: "the first", final: false },
      { text: "the final words", final: false },
    ]);
    expect(voice.events.some((event) => event.type === "utterance")).toBe(
      false,
    );
    expect(finish).not.toHaveBeenCalled();
    voice.engine.hold(false);
    partial("a late guess");
    await voice.engine.recognized();
    expect(finish).toHaveBeenCalledOnce();
    expect(
      voice.events.filter((event) => event.type === "utterance"),
    ).toMatchObject([{ text: "The final words." }]);
    expect(
      voice.events.filter((event) => event.type === "transcript").at(-1),
    ).toMatchObject({ text: "", final: true });
    voice.engine.close();
  });

  it("keeps live dictation in its field and cancels previews when the target changes", async () => {
    const callbacks: ((text: string) => void)[] = [];
    const cancel = vi.fn();
    const voice = harness([], (parts) => {
      parts.startRecognition = (onPartial) => {
        callbacks.push(onPartial);
        return {
          write: vi.fn(),
          finish: async () => ({ text: "Dictated words.", confidence: 0 }),
          cancel,
        };
      };
    });
    voice.engine.setDictation(true);
    voice.engine.hold(true);
    callbacks[0]?.("dictated");
    expect(
      voice.events.filter((event) => event.type === "dictation"),
    ).toMatchObject([{ text: "dictated", final: false }]);
    voice.engine.forget();
    callbacks[0]?.("old words");
    expect(cancel).toHaveBeenCalledOnce();
    voice.engine.hold(true);
    callbacks[1]?.("new words");
    voice.engine.hold(false);
    await voice.engine.recognized();
    expect(
      voice.events
        .filter((event) => event.type === "dictation")
        .map((event) => event.text),
    ).toEqual(["dictated", "new words", "Dictated words."]);
    expect(voice.events.some((event) => event.type === "utterance")).toBe(
      false,
    );
    voice.engine.close();
  });

  const dictated = (voice: ReturnType<typeof harness>) =>
    voice.events.filter((event) => event.type === "dictation");
  it("keeps pauses within one hold and captures no audio from outside it", async () => {
    const recognize = vi.fn<SpeechParts["recognize"]>(async () => ({
      text: "first thought then another",
      confidence: 0,
    }));
    const voice = harness([], (parts) => {
      parts.recognize = recognize;
    });
    voice.frame(0.5, 100);
    voice.engine.hold(true);
    voice.frame(0.5, 50);
    voice.frame(0, 200);
    voice.frame(0.5, 50);
    await voice.settle();
    expect(recognize).not.toHaveBeenCalled();
    voice.engine.hold(false);
    voice.frame(0.5, 100);
    await voice.engine.recognized();
    expect(recognize).toHaveBeenCalledOnce();
    expect(recognize.mock.calls[0]?.[0]).toHaveLength(300 * WINDOW);
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual([
      { type: "utterance", text: "first thought then another", segment: 1 },
    ]);
  });

  it("keeps overlapping recognition in order without mixing successive holds", async () => {
    let first!: (value: { text: string; confidence: number }) => void;
    const recognize = vi
      .fn<SpeechParts["recognize"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: "second hold", confidence: 0 });
    const voice = harness([], (parts) => {
      parts.recognize = recognize;
    });
    voice.engine.hold(true);
    voice.frame(0.5, 30);
    voice.engine.hold(false);
    await voice.settle();
    voice.engine.hold(true);
    voice.frame(0.5, 30);
    voice.engine.hold(false);
    expect(recognize).toHaveBeenCalledOnce();
    first({ text: "first hold", confidence: 0 });
    await voice.engine.recognized();
    expect(
      voice.events
        .filter((event) => event.type === "utterance")
        .map((event) => event.text),
    ).toEqual(["first hold", "second hold"]);
  });

  it("cancels abandoned recognition so another target can transcribe immediately", async () => {
    let cancel!: (cause: Error) => void;
    const recognize = vi
      .fn<SpeechParts["recognize"]>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            cancel = reject;
          }),
      )
      .mockResolvedValueOnce({ text: "new target's words", confidence: 0 });
    const cancelRecognition = vi.fn(() => cancel(new Error("cancelled")));
    const voice = harness([], (parts) => {
      parts.recognize = recognize;
      parts.cancelRecognition = cancelRecognition;
    });
    voice.engine.hold(true);
    voice.frame(0.5, 30);
    voice.engine.hold(false);
    await voice.settle();
    voice.engine.forget();
    voice.engine.hold(true);
    voice.frame(0.5, 30);
    voice.engine.hold(false);
    await voice.engine.recognized();
    expect(cancelRecognition).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(
      voice.events
        .filter((event) => event.type === "utterance")
        .map((event) => event.text),
    ).toEqual(["new target's words"]);
    expect(voice.events.some((event) => event.type === "failed")).toBe(false);
  });

  it("does not let a stale recognition failure stop a new target", async () => {
    let fail!: (cause: Error) => void;
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((_, reject) => {
          fail = reject;
        });
    });
    voice.engine.hold(true);
    voice.frame(0.5, 30);
    voice.engine.hold(false);
    await voice.settle();
    voice.engine.forget();
    fail(new Error("old target"));
    await voice.engine.recognized();
    expect(voice.events.some((event) => event.type === "failed")).toBe(false);
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
  it("hears only while the keys are held, and at once when they come up", async () => {
    const voice = harness(["list my sessions"]);
    voice.frame(0.5, 20);
    voice.frame(0);
    await voice.settle();
    // Speech with no keys held is not listened to.
    expect(voice.events).toEqual([]);
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    expect(voice.events).toEqual([
      { type: "speech-start", segment: expect.any(Number) },
    ]);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events).toEqual([
      { type: "speech-start", segment: expect.any(Number) },
      { type: "speech-end" },
      {
        type: "utterance",
        text: "list my sessions",
        segment: expect.any(Number),
      },
    ]);
  });

  it("stops the agent the moment the keys go down", async () => {
    const voice = harness();
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

  it("drops what it was still recognizing when listening stops", async () => {
    let answer: (text: string) => void = () => {};
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((resolve) => {
          answer = (text) => resolve({ text, confidence: 0 });
        });
    });
    voice.engine.hold(true);
    voice.frame(0.5, 3);
    voice.engine.hold(false);
    await voice.settle();
    // Recognition is underway; listening stops before it answers.
    voice.engine.stopListening();
    answer("wait");
    await voice.settle();
    voice.drain();
    expect(voice.events.map((event) => event.type)).not.toContain("barge-in");
    expect(voice.events.map((event) => event.type)).not.toContain("utterance");
    expect(voice.audio).toContainEqual({ type: "close-microphone" });
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

  it("holds nothing once it stops listening", async () => {
    const voice = harness(["list my sessions"]);
    voice.engine.stopListening();
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events).toEqual([]);
  });
  it("dictates while the keys are held, a stretch per hold", async () => {
    const voice = harness(["first thought", "second thought"]);
    voice.engine.setDictation(true);
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

  it("hears a long hold in parts, losing nothing, and says it as one message", async () => {
    const lengths: number[] = [];
    const said = ["the first thirty seconds", "and the rest"];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => {
        lengths.push(samples.length);
        return { text: said.shift() ?? "", confidence: 0 };
      };
    });
    voice.engine.hold(true);
    // Forty seconds held, pauses and all: nothing is said until it ends.
    voice.frame(0.5, 4_000);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual(
      [],
    );
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual([
      {
        type: "utterance",
        text: "the first thirty seconds and the rest",
        segment: expect.any(Number),
      },
    ]);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(40 * 16_000);
  });

  it("keeps a reply that came in during a long hold for after it", async () => {
    const voice = harness(["the first thirty seconds", "and the rest"]);
    voice.engine.hold(true);
    voice.frame(0.5, 40);
    // The reply waits for the person, however long they hold.
    voice.engine.speak("reply", "Here is a long answer about the build.");
    await voice.settle();
    voice.frame(0.5, 3_200);
    voice.engine.hold(false);
    await voice.settle();
    expect(controls(voice)).toEqual([]);
    expect(voice.events).not.toContainEqual({ type: "barge-in" });
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual([
      {
        type: "utterance",
        text: "the first thirty seconds and the rest",
        segment: expect.any(Number),
      },
    ]);
  });

  it("dictates a long hold whose first piece was quiet without saying it heard nothing", async () => {
    const said = ["", "the rest of it"];
    const voice = harness([], (parts) => {
      parts.recognize = async () => ({
        text: said.shift() ?? "",
        confidence: 0,
      });
    });
    voice.engine.setDictation(true);
    voice.engine.hold(true);
    voice.frame(0.5, 4_000);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "unheard")).toEqual(
      [],
    );
    expect(dictated(voice).at(-1)).toMatchObject({
      text: "the rest of it",
      final: true,
    });
  });

  it("dictates a long hold that ends quiet without saying it heard nothing", async () => {
    const said = ["the first part", ""];
    const voice = harness([], (parts) => {
      parts.recognize = async () => ({
        text: said.shift() ?? "",
        confidence: 0,
      });
    });
    voice.engine.setDictation(true);
    voice.engine.hold(true);
    voice.frame(0.5, 4_000);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "unheard")).toEqual(
      [],
    );
  });

  it("says a long hold that heard no words came to nothing, once", async () => {
    const voice = harness([], (parts) => {
      parts.recognize = async () => ({ text: "", confidence: 0 });
    });
    voice.engine.hold(true);
    voice.frame(0.5, 4_000);
    voice.engine.hold(false);
    await voice.settle();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual(
      [],
    );
    expect(
      voice.events.filter((event) => event.type === "unheard"),
    ).toHaveLength(1);
  });

  it("drops a long hold's words with the chat voice moved away from", async () => {
    const said = ["for the old chat", "for the new chat"];
    const voice = harness([], (parts) => {
      parts.recognize = async (samples) => ({
        text: samples.length === 0 ? "" : (said.shift() ?? ""),
        confidence: 0,
      });
    });
    voice.engine.hold(true);
    // A first piece is heard while the keys are still down…
    voice.frame(0.5, 3_200);
    await voice.settle();
    // …then voice moves to another chat: what was said for the old one
    // goes no further.
    voice.engine.forget();
    voice.engine.hold(false);
    await voice.settle();
    voice.engine.hold(true);
    voice.frame(0.5, 20);
    voice.engine.hold(false);
    await voice.settle();
    expect(
      voice.events.flatMap((event) =>
        event.type === "utterance" ? [event.text] : [],
      ),
    ).toEqual(["for the new chat"]);
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
  it("answers nothing said for where it was before", async () => {
    let answer: (text: string) => void = () => {};
    const voice = harness([], (parts) => {
      parts.recognize = () =>
        new Promise((resolve) => {
          answer = (text) => resolve({ text, confidence: 0 });
        });
    });
    voice.engine.hold(true);
    voice.frame(0.5, 100);
    voice.engine.hold(false);
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
    voice.engine.hold(true);
    voice.frame(0.5, 100);
    voice.engine.hold(false);
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
