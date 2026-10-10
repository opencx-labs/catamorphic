import type { MessagePortMain } from "electron";
import type {
  VoiceAudioUp,
  VoiceWorkerCommand,
  VoiceWorkerEvent,
} from "../../shared/voice.js";
import { VoiceEngine } from "./engine.js";
import { fakeSpeech } from "./fake-speech.js";

/**
 * The speech worker (ADR 0216), an Electron utility process: the models
 * take a gigabyte and their inference whole CPU cores, so they stay out of
 * the main process. The audio page's port brings microphone frames and
 * takes speech back directly; the main process sees only conversation
 * events.
 */
let engine: VoiceEngine | null = null;
let audio: MessagePortMain | null = null;

const emit = (event: VoiceWorkerEvent) => process.parentPort.postMessage(event);

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
        if (isAudioUp(data)) engine?.onAudio(data);
      });
      port.start();
      return;
    }
    case "start":
      void start(command);
      return;
    case "push-to-talk":
      engine?.setPushToTalk(command.enabled);
      return;
    case "hold":
      engine?.hold(command.held);
      return;
    case "learn":
      engine?.learn();
      return;
    case "voiceprint":
      engine?.setVoiceprint(command.voiceprint);
      return;
    case "speak":
      engine?.speak(command.id, command.text);
      return;
    case "cue":
      engine?.cue();
      return;
    case "voice":
      engine?.setVoice(command.voice);
      return;
    case "stop-speaking":
      engine?.stopSpeaking();
      return;
  }
});

async function start({
  speech,
  voiceprint,
  pushToTalk,
}: Extract<VoiceWorkerCommand, { type: "start" }>): Promise<void> {
  try {
    const parts =
      speech.kind === "fake"
        ? fakeSpeech(speech)
        : await (await import("./sherpa-speech.js")).loadSherpaSpeech(
            speech.paths,
            speech.voice,
          );
    engine?.stopSpeaking();
    engine = new VoiceEngine(parts, emit, (message) =>
      audio?.postMessage(message),
    );
    engine.setVoiceprint(voiceprint);
    engine.setPushToTalk(pushToTalk);
    emit({ type: "ready" });
  } catch (cause) {
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
