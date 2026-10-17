import type { MessagePortMain } from "electron";
import {
  SPEECH_SAMPLE_RATE,
  type VoiceAudioUp,
  type VoiceWorkerCommand,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import { type SpeechParts, VoiceEngine } from "./engine.js";
import { fakeSpeech } from "./fake-speech.js";

/**
 * The speech worker (ADR 0216), an Electron utility process: the models
 * take a gigabyte and their inference whole CPU cores, so they stay out of
 * the main process. The audio page's port brings microphone frames and
 * takes speech back directly; the main process sees only conversation
 * events.
 *
 * Nothing the person says is lost to loading (ADR 0236): the microphone
 * opens as voice starts, and until the models are ready this worker keeps
 * what it hears, and the presses that came with it, in order, then hears
 * them all. Between voices it rests with the models loaded, so the next
 * start is quick, until the main process lets it go.
 */
let engine: VoiceEngine | null = null;
let audio: MessagePortMain | null = null;
/** The models, loading or loaded, and what they are loaded from. */
let loaded: { key: string; parts: Promise<SpeechParts> } | null = null;
/** Counts starts and rests: a start that a later one overtook is dropped. */
let starts = 0;
/** What arrived before the engine could hear it, oldest first. */
let waiting: ({ audio: VoiceAudioUp } | { command: VoiceWorkerCommand })[] = [];
let waitingSamples = 0;
/** Kept at most while the models load: a first download takes longer. */
const WAIT_SECONDS = 30;

const emit = (event: VoiceWorkerEvent) => process.parentPort.postMessage(event);

function onAudio(data: VoiceAudioUp): void {
  if (engine) {
    engine.onAudio(data);
    return;
  }
  if (data.type === "failed") {
    emit({ type: "failed", message: data.message });
    return;
  }
  if (data.type !== "frame") return;
  waiting.push({ audio: data });
  waitingSamples +=
    (data.samples.length * SPEECH_SAMPLE_RATE) / data.sampleRate;
  // The oldest goes first: what was said last is what matters.
  while (waitingSamples > WAIT_SECONDS * SPEECH_SAMPLE_RATE) {
    const oldest = waiting.findIndex((entry) => "audio" in entry);
    const [dropped] = oldest < 0 ? [] : waiting.splice(oldest, 1);
    if (!dropped || !("audio" in dropped) || dropped.audio.type !== "frame")
      break;
    waitingSamples -=
      (dropped.audio.samples.length * SPEECH_SAMPLE_RATE) /
      dropped.audio.sampleRate;
  }
}

/** A command for the engine, kept in order with the audio until it is. */
function forEngine(command: VoiceWorkerCommand): void {
  if (!engine) {
    waiting.push({ command });
    return;
  }
  switch (command.type) {
    case "hands-free":
      engine.setHandsFree(command.enabled);
      return;
    case "dictation":
      engine.setDictation(command.enabled);
      return;
    case "hold":
      engine.hold(command.held, { discard: command.discard === true });
      return;
    case "stop-listening":
      engine.stopListening();
      return;
    case "learn":
      engine.learn();
      return;
    case "finish": {
      const ending = engine;
      void ending.finish().then(() => {
        if (engine === ending) emit({ type: "finished" });
      });
      return;
    }
    case "forget":
      engine.forget();
      return;
    case "voiceprint":
      engine.setVoiceprint(command.voiceprint);
      return;
    case "speak":
      engine.speak(command.id, command.text);
      return;
    case "cue":
      engine.cue();
      return;
    case "voice":
      engine.setVoice(command.voice);
      return;
    case "stop-speaking":
      engine.stopSpeaking();
      return;
  }
}

process.parentPort.on("message", (message) => {
  const command = message.data as VoiceWorkerCommand;
  switch (command.type) {
    case "audio": {
      const port = message.ports[0];
      if (!port) return;
      audio?.close();
      audio = port;
      port.on("message", (event) => {
        const data: unknown = event.data;
        if (isAudioUp(data)) onAudio(data);
      });
      port.start();
      engine?.audioReplaced();
      return;
    }
    case "start":
      void start(command);
      return;
    case "rest":
      starts += 1;
      engine?.stopSpeaking();
      // Nothing it still recognizes reaches the next voice.
      engine?.close();
      engine = null;
      waiting = [];
      waitingSamples = 0;
      audio?.close();
      audio = null;
      return;
    default:
      forEngine(command);
  }
});

async function start({
  speech,
  voiceprint,
  handsFree,
  dictation,
}: Extract<VoiceWorkerCommand, { type: "start" }>): Promise<void> {
  const mine = ++starts;
  try {
    let parts: SpeechParts;
    if (speech.kind === "fake") parts = fakeSpeech(speech);
    else {
      const key = JSON.stringify(speech.paths);
      // One load at a time, shared by every start that wants it.
      if (loaded?.key !== key) {
        const loading = import("./sherpa-speech.js").then((sherpa) =>
          sherpa.loadSherpaSpeech(speech.paths, speech.voice),
        );
        loaded = { key, parts: loading };
        loading.catch(() => {
          if (loaded?.parts === loading) loaded = null;
        });
      }
      parts = await loaded.parts;
    }
    // Voice went off, or started again, while the models loaded.
    if (mine !== starts) return;
    if (speech.kind === "models") parts.setVoice?.(speech.voice);
    engine?.stopSpeaking();
    engine?.close();
    const next = new VoiceEngine(parts, emit, (message) =>
      audio?.postMessage(message),
    );
    next.setVoiceprint(voiceprint);
    next.setHandsFree(handsFree);
    next.setDictation(dictation);
    engine = next;
    // What was heard and pressed while loading, in the order it came.
    const backlog = waiting;
    waiting = [];
    waitingSamples = 0;
    for (const entry of backlog)
      if ("audio" in entry) next.onAudio(entry.audio);
      else forEngine(entry.command);
    emit({ type: "ready" });
  } catch (cause) {
    if (mine !== starts) return;
    emit({
      type: "failed",
      message: `The speech models could not load: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

function isAudioUp(value: unknown): value is VoiceAudioUp {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "frame" ||
      value.type === "drained" ||
      value.type === "levels" ||
      value.type === "failed")
  );
}
